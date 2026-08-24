/**
 * Kitsu standalone browser backend.
 * Patches fetch + EventSource so the existing desktop UI talks to matrix-js-sdk
 * in-process (Capacitor / phone) instead of the Node Express API.
 */
(() => {
  const SESSION_KEY = 'kitsu.browser.session';
  const ENABLED =
    Boolean(window.Capacitor?.isNativePlatform?.()) ||
    localStorage.getItem('kitsu.standalone') === '1' ||
    /(?:\?|&)standalone=1(?:&|$)/.test(location.search) ||
    location.protocol === 'capacitor:' ||
    location.protocol === 'https:' && /kitsu/i.test(location.hostname);

  if (!ENABLED) {
    window.KitsuStandalone = { enabled: false };
    return;
  }

  /** @type {import('matrix-js-sdk').MatrixClient | null} */
  let client = null;
  let ready = false;
  let restoring = false;
  let lastError = null;
  /** @type {Set<(payload: object) => void>} */
  const liveListeners = new Set();
  /** Real browser fetch — set after we wrap window.fetch. */
  let origFetch = window.fetch.bind(window);

  function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  function errorResponse(message, status = 400) {
    return jsonResponse({ error: String(message || 'Error') }, status);
  }

  function loadStoredSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function saveStoredSession(session) {
    if (!session) localStorage.removeItem(SESSION_KEY);
    else localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }

  function sdk() {
    const s = window.MatrixBrowserSdk;
    if (!s) {
      const detail = window.__kitsuMatrixBootError?.message || 'matrix-js-sdk not loaded';
      throw new Error(detail);
    }
    return s;
  }

  /** @type {Map<string, object|null>} */
  const profileStyleCache = new Map();
  /** @type {Map<string, { meta: object|null, ts: number, key: string }>} */
  const avatarMetaCache = new Map();
  /** @type {Map<string, string>} */
  const blobUrlCache = new Map();
  /** @type {Map<string, { contentType: string, buffer: ArrayBuffer, ts: number }>} */
  const mediaBufferCache = new Map();
  const MEDIA_CACHE_TTL_MS = 5 * 60 * 1000;

  function mediaProxy(remoteUrl) {
    if (!remoteUrl) return null;
    return `/api/media?url=${encodeURIComponent(remoteUrl)}`;
  }

  function profileAvatarPath(userId, size = 96) {
    if (!userId) return null;
    return `/api/profile-avatar?userId=${encodeURIComponent(userId)}&size=${encodeURIComponent(size)}`;
  }

  function roomAvatarPath(roomId, size = 96, { original = false } = {}) {
    if (!roomId) return null;
    const params = new URLSearchParams({ size: String(size) });
    if (original) params.set('original', '1');
    return `/api/avatar/${encodeURIComponent(roomId)}?${params.toString()}`;
  }

  function rememberMediaBuffer(key, payload) {
    if (!key || !payload?.buffer) return payload;
    if (mediaBufferCache.size > 120) {
      const drop = mediaBufferCache.keys().next().value;
      if (drop !== undefined) mediaBufferCache.delete(drop);
    }
    mediaBufferCache.set(key, { ...payload, ts: Date.now() });
    return payload;
  }

  function readMediaBuffer(key) {
    const hit = mediaBufferCache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.ts > MEDIA_CACHE_TTL_MS) {
      mediaBufferCache.delete(key);
      return null;
    }
    return { contentType: hit.contentType, buffer: hit.buffer };
  }

  function mxcToRemote(mxc, width, height, method = 'crop') {
    if (!client || !mxc || typeof mxc !== 'string' || !mxc.startsWith('mxc://')) return null;
    try {
      if (width && height) {
        return (
          client.mxcUrlToHttp(mxc, width, height, method, false, true, true) ||
          client.mxcUrlToHttp(mxc, width, height, method) ||
          null
        );
      }
      return (
        client.mxcUrlToHttp(mxc, undefined, undefined, undefined, false, true, true) ||
        client.mxcUrlToHttp(mxc) ||
        null
      );
    } catch {
      return null;
    }
  }

  function mxcToHttp(mxc, width = 96) {
    return mediaProxy(mxcToRemote(mxc, width, width, 'crop') || mxcToRemote(mxc));
  }

  function mxcToHttpFull(mxc) {
    return mediaProxy(mxcToRemote(mxc));
  }

  function authHeaders() {
    const token = client?.getAccessToken?.();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async function fetchRemoteMedia(remoteUrl) {
    if (!remoteUrl) return null;
    const cached = readMediaBuffer(`remote:${remoteUrl}`);
    if (cached) return cached;
    const tryOnce = async (withAuth) => {
      try {
        const headers = withAuth ? authHeaders() : {};
        let response = await origFetch(remoteUrl, { headers, redirect: 'follow' });
        // Some HS builds still accept access_token on media URLs
        if (!response.ok && withAuth && client?.getAccessToken?.()) {
          const token = client.getAccessToken();
          const joiner = remoteUrl.includes('?') ? '&' : '?';
          response = await origFetch(`${remoteUrl}${joiner}access_token=${encodeURIComponent(token)}`, {
            redirect: 'follow',
          });
        }
        if (!response.ok) return { response, buffer: null, contentType: null };
        const contentType = response.headers.get('Content-Type') || 'application/octet-stream';
        const buffer = await response.arrayBuffer();
        return { response, buffer, contentType };
      } catch {
        return { response: null, buffer: null, contentType: null };
      }
    };
    let result = await tryOnce(true);
    if (!result.buffer) result = await tryOnce(false);
    if (!result.buffer) return null;
    return rememberMediaBuffer(`remote:${remoteUrl}`, {
      contentType: result.contentType,
      buffer: result.buffer,
    });
  }

  function getAvatarMxc(userId, room = null) {
    if (!client || !userId) return null;
    try {
      const fromUser = client.getUser?.(userId)?.avatarUrl || null;
      if (fromUser) return fromUser;
    } catch { /* ignore */ }
    if (room) {
      try {
        const member = room.getMember?.(userId);
        const fromMember =
          (typeof member?.getMxcAvatarUrl === 'function' && member.getMxcAvatarUrl()) ||
          member?.events?.member?.getContent?.()?.avatar_url ||
          null;
        if (fromMember) return fromMember;
      } catch { /* ignore */ }
    }
    return null;
  }

  async function resolveAvatarMxc(userId, hint = null) {
    if (typeof hint === 'string' && hint.startsWith('mxc://')) return hint;
    const local = getAvatarMxc(userId);
    if (local) return local;
    if (!client || !userId) return null;
    try {
      const profile = await client.getProfileInfo(userId);
      return profile?.avatar_url || null;
    } catch {
      return null;
    }
  }

  /** Full-size media URL only — thumbnails strip Paarrot PNG tEXt metadata. */
  function mxcToFullRemote(mxc) {
    if (!client || !mxc || typeof mxc !== 'string' || !mxc.startsWith('mxc://')) return null;
    try {
      return (
        client.mxcUrlToHttp(mxc, undefined, undefined, undefined, false, true, true) ||
        client.mxcUrlToHttp(mxc, undefined, undefined, undefined, false, true) ||
        client.mxcUrlToHttp(mxc) ||
        null
      );
    } catch {
      return null;
    }
  }

  function readU32(view, offset) {
    return ((view[offset] << 24) | (view[offset + 1] << 16) | (view[offset + 2] << 8) | view[offset + 3]) >>> 0;
  }

  function extractPaarrotFromPng(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const sig = [137, 80, 78, 71, 13, 10, 26, 10];
    if (data.length < 8 || !sig.every((b, i) => data[i] === b)) return {};
    const meta = {};
    const dec = new TextDecoder('utf-8', { fatal: false });
    let offset = 8;
    while (offset + 8 <= data.length) {
      const length = readU32(data, offset);
      const type = String.fromCharCode(data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7]);
      const start = offset + 8;
      const end = start + length;
      if (end + 4 > data.length) break;
      if (type === 'tEXt') {
        const chunk = data.subarray(start, end);
        const nul = chunk.indexOf(0);
        if (nul > 0) {
          const key = dec.decode(chunk.subarray(0, nul));
          const value = dec.decode(chunk.subarray(nul + 1));
          if (key === 'paarrot:color') meta.color = value;
          else if (key === 'paarrot:banner') meta.banner = value;
          else if (key === 'paarrot:borderColor') meta.avatarBorderColor = value;
          else if (key === 'paarrot:gradient') {
            try { meta.gradient = JSON.parse(value); } catch { /* ignore */ }
          }
        }
      }
      offset = end + 4;
      if (type === 'IEND') break;
    }
    return meta;
  }

  function extractPaarrotColorLoose(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const text = new TextDecoder('latin1').decode(data.subarray(0, Math.min(data.length, 96 * 1024)));
    const m = text.match(/<paarrot:color>([^<]+)<\/paarrot:color>/) || text.match(/paarrot:color[=:]([#A-Fa-f0-9]+)/);
    return m ? { color: m[1].trim() } : {};
  }

  function extractMetadataFromImage(buffer) {
    const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer);
    const png = extractPaarrotFromPng(bytes);
    if (png.color || png.banner || png.avatarBorderColor || png.gradient) return png;
    return extractPaarrotColorLoose(bytes);
  }

  function normalizeHexColor(value) {
    const raw = String(value || '').trim();
    if (/^#[0-9a-fA-F]{3}$/.test(raw)) {
      return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`.toLowerCase();
    }
    if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
    return null;
  }

  function normalizeColorPreference(raw) {
    if (!raw) return null;
    let parsed = raw;
    if (typeof raw === 'string') {
      try {
        parsed = JSON.parse(raw);
      } catch {
        const hex = normalizeHexColor(raw);
        return hex ? { on_dark: hex, on_light: hex } : null;
      }
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const onDark =
      normalizeHexColor(parsed.on_dark) ||
      normalizeHexColor(parsed.onDark) ||
      normalizeHexColor(parsed.dark) ||
      normalizeHexColor(parsed.color);
    const onLight =
      normalizeHexColor(parsed.on_light) ||
      normalizeHexColor(parsed.onLight) ||
      normalizeHexColor(parsed.light) ||
      normalizeHexColor(parsed.color);
    if (!onDark && !onLight) return null;
    return { on_dark: onDark || onLight, on_light: onLight || onDark };
  }

  function normalizeProfileStyle(parsed) {
    if (!parsed || typeof parsed !== 'object') return null;
    const nameplate = typeof parsed.nameplate === 'string' ? parsed.nameplate : null;
    const nameGradientStart =
      typeof parsed.nameGradientStart === 'string'
        ? parsed.nameGradientStart
        : typeof parsed.colors?.start === 'string'
          ? parsed.colors.start
          : null;
    const nameGradientEnd =
      typeof parsed.nameGradientEnd === 'string'
        ? parsed.nameGradientEnd
        : typeof parsed.colors?.end === 'string'
          ? parsed.colors.end
          : null;
    const colorPreference =
      normalizeColorPreference(parsed.colorPreference) ||
      normalizeColorPreference(parsed['m.color_preference']) ||
      normalizeColorPreference(parsed['eu.she-a.color']) ||
      normalizeColorPreference({
        on_dark: parsed.on_dark || parsed.onDark,
        on_light: parsed.on_light || parsed.onLight,
      }) ||
      normalizeColorPreference(parsed.color) ||
      (nameGradientStart
        ? {
            on_dark: normalizeHexColor(nameGradientStart),
            on_light: normalizeHexColor(nameGradientEnd || nameGradientStart),
          }
        : null);
    return {
      avatarBorder: typeof parsed.avatarBorder === 'string' ? parsed.avatarBorder : null,
      gradientStart: typeof parsed.gradientStart === 'string' ? parsed.gradientStart : null,
      gradientEnd: typeof parsed.gradientEnd === 'string' ? parsed.gradientEnd : null,
      gradientAngle: Number.isFinite(Number(parsed.gradientAngle)) ? Number(parsed.gradientAngle) : 180,
      nameplate,
      nameGradientStart,
      nameGradientEnd,
      color: colorPreference?.on_dark || normalizeHexColor(parsed.color) || null,
      colorPreference,
    };
  }

  function parseProfileStyle(profileRaw) {
    if (!profileRaw || typeof profileRaw !== 'object') return null;
    const colorPreference =
      normalizeColorPreference(profileRaw['m.color_preference']) ||
      normalizeColorPreference(profileRaw['eu.she-a.color']) ||
      normalizeColorPreference(profileRaw['paarrot.colors']);

    const raw =
      profileRaw?.['paarrot.colors'] ||
      profileRaw?.['app.relay.profile_style'] ||
      profileRaw?.['im.vector.custom.relay_profile_style'] ||
      null;

    let style = null;
    if (raw) {
      try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        style = normalizeProfileStyle(parsed);
      } catch {
        style = null;
      }
    }
    if (!style && colorPreference) style = normalizeProfileStyle({ colorPreference });
    else if (style && colorPreference) {
      style = {
        ...style,
        colorPreference,
        color: colorPreference.on_dark || style.color,
        nameGradientStart: style.nameGradientStart || colorPreference.on_dark,
        nameGradientEnd: style.nameGradientEnd || colorPreference.on_light,
      };
    }
    return style;
  }

  function cacheProfileStyle(userId, style) {
    if (!userId) return style;
    profileStyleCache.set(userId, style || null);
    return style;
  }

  function styleFromPaarrot(meta) {
    if (!meta) return null;
    const dir = String(meta.gradient?.direction || '');
    const m = dir.match(/(-?\d+(?:\.\d+)?)\s*deg/i);
    const color = normalizeHexColor(meta.color);
    return {
      avatarBorder: meta.avatarBorderColor || null,
      gradientStart: meta.gradient?.startColor || null,
      gradientEnd: meta.gradient?.stopColor || null,
      gradientAngle: m ? Number(m[1]) : 180,
      nameplate: null,
      nameGradientStart: null,
      nameGradientEnd: null,
      color,
      colorPreference: color ? { on_dark: color, on_light: color } : null,
    };
  }

  function getMemberColorPreference(room, userId) {
    if (!room || !userId) return null;
    try {
      const member = room.getMember?.(userId);
      const content = member?.events?.member?.getContent?.() || member?.event?.content || null;
      if (!content || typeof content !== 'object') return null;
      return (
        normalizeColorPreference(content['m.color_preference']) ||
        normalizeColorPreference(content['eu.she-a.color']) ||
        normalizeColorPreference(content['paarrot.colors'])
      );
    } catch {
      return null;
    }
  }

  function mergeProfileStyles({ roomColorPref = null, accountStyle = null, avatarMeta = null } = {}) {
    const avatarStyle = styleFromPaarrot(avatarMeta);
    const base = {
      avatarBorder: accountStyle?.avatarBorder || avatarStyle?.avatarBorder || null,
      gradientStart: accountStyle?.gradientStart || avatarStyle?.gradientStart || null,
      gradientEnd: accountStyle?.gradientEnd || avatarStyle?.gradientEnd || null,
      gradientAngle: accountStyle?.gradientAngle ?? avatarStyle?.gradientAngle ?? 180,
      nameplate: accountStyle?.nameplate || null,
      nameGradientStart: accountStyle?.nameGradientStart || null,
      nameGradientEnd: accountStyle?.nameGradientEnd || null,
      color: null,
      colorPreference: null,
    };
    const colorPreference =
      normalizeColorPreference(roomColorPref) ||
      accountStyle?.colorPreference ||
      normalizeColorPreference(accountStyle?.color) ||
      (accountStyle?.nameGradientStart
        ? {
            on_dark: normalizeHexColor(accountStyle.nameGradientStart),
            on_light: normalizeHexColor(accountStyle.nameGradientEnd || accountStyle.nameGradientStart),
          }
        : null) ||
      avatarStyle?.colorPreference ||
      null;
    if (colorPreference?.on_dark || colorPreference?.on_light) {
      base.colorPreference = {
        on_dark: colorPreference.on_dark || colorPreference.on_light,
        on_light: colorPreference.on_light || colorPreference.on_dark,
      };
      base.color = base.colorPreference.on_dark;
      if (!base.nameGradientStart) base.nameGradientStart = base.colorPreference.on_dark;
      if (!base.nameGradientEnd) base.nameGradientEnd = base.colorPreference.on_light;
    }
    if (!base.avatarBorder && !base.gradientStart && !base.color && !base.nameplate) return null;
    return base;
  }

  async function fetchAvatarBytes(userId, size = 96) {
    if (!client || !userId) return null;
    const mxc = await resolveAvatarMxc(userId);
    if (!mxc) return null;
    const remote =
      (size ? mxcToRemote(mxc, size, size, 'crop') : null) ||
      mxcToFullRemote(mxc);
    return fetchRemoteMedia(remote);
  }

  async function fetchAvatarPaarrotColors(userId, avatarMxcHint = null) {
    if (!client || !userId) return null;
    const avatarKey = (await resolveAvatarMxc(userId, avatarMxcHint)) || '';
    const cached = avatarMetaCache.get(userId);
    if (cached && cached.key === avatarKey && Date.now() - cached.ts < 5 * 60 * 1000) {
      return cached.meta;
    }
    let buffer = null;
    if (avatarKey) {
      // Must use the original upload — Synapse thumbnails drop tEXt chunks.
      const candidates = [
        mxcToFullRemote(avatarKey),
        (() => {
          try { return client.mxcUrlToHttp(avatarKey); } catch { return null; }
        })(),
      ].filter(Boolean);
      for (const remote of candidates) {
        try {
          const media = await fetchRemoteMedia(remote);
          if (media?.buffer) {
            buffer = media.buffer;
            break;
          }
        } catch { /* try next */ }
      }
    }
    const meta = buffer ? extractMetadataFromImage(buffer) : {};
    const has = Boolean(meta.color || meta.avatarBorderColor || meta.gradient || meta.banner);
    const result = has ? meta : null;
    if (avatarMetaCache.size > 250) {
      const drop = avatarMetaCache.keys().next().value;
      if (drop !== undefined) avatarMetaCache.delete(drop);
    }
    avatarMetaCache.set(userId, { meta: result, ts: Date.now(), key: avatarKey });
    return result;
  }

  async function getUserProfile(userId, { roomId = null } = {}) {
    if (!client) throw new Error('Not logged in');
    const id = String(userId || '').trim();
    if (!id.startsWith('@') || !id.includes(':')) throw new Error('Invalid Matrix user ID');
    let displayName = displayNameFor(id, roomId ? client.getRoom(roomId) : null);
    let avatarMxc = null;
    let bannerMxc = null;
    let profileRaw = null;
    try {
      profileRaw = await client.getProfileInfo(id);
      if (profileRaw?.displayname) displayName = profileRaw.displayname;
      if (profileRaw?.avatar_url) avatarMxc = profileRaw.avatar_url;
      bannerMxc =
        profileRaw?.['m.banner_url'] ||
        profileRaw?.['chat.commet.profile_banner'] ||
        profileRaw?.banner_url ||
        null;
    } catch { /* ignore */ }
    try {
      if (typeof client.getExtendedProfileProperty === 'function') {
        const supported = await client.doesServerSupportExtendedProfiles?.();
        if (supported) {
          for (const key of [
            'app.relay.profile_style',
            'paarrot.colors',
            'm.color_preference',
            'eu.she-a.color',
            'm.banner_url',
          ]) {
            try {
              const value = await client.getExtendedProfileProperty(id, key);
              if (value != null) profileRaw = { ...(profileRaw || {}), [key]: value };
            } catch { /* ignore */ }
          }
          if (!bannerMxc) {
            bannerMxc =
              profileRaw?.['m.banner_url'] ||
              profileRaw?.['chat.commet.profile_banner'] ||
              profileRaw?.banner_url ||
              null;
          }
        }
      }
    } catch { /* ignore */ }
    if (!avatarMxc) avatarMxc = client.getUser?.(id)?.avatarUrl || null;
    let bannerUrl = null;
    if (typeof bannerMxc === 'string' && bannerMxc.startsWith('mxc://')) {
      bannerUrl =
        mediaProxy(mxcToRemote(bannerMxc, 1280, 480, 'scale')) ||
        mxcToHttpFull(bannerMxc);
    }
    const accountStyle = parseProfileStyle(profileRaw);
    const room = roomId ? client.getRoom(roomId) : null;
    const roomColorPref = getMemberColorPreference(room, id);
    let paarrotColors = null;
    try { paarrotColors = await fetchAvatarPaarrotColors(id, avatarMxc); } catch { paarrotColors = null; }
    // MSC4133 banner on profile first; avatar-embedded banner is legacy fallback.
    if (!bannerUrl && paarrotColors?.banner?.startsWith?.('mxc://')) {
      bannerUrl = mxcToHttpFull(paarrotColors.banner);
    } else if (!bannerUrl && typeof paarrotColors?.banner === 'string' && /^https?:/i.test(paarrotColors.banner)) {
      bannerUrl = mediaProxy(paarrotColors.banner);
    }
    // MSC4522 / Paarrot 4.11+: profile colors beat avatar tEXt metadata.
    const style = mergeProfileStyles({
      roomColorPref,
      accountStyle,
      avatarMeta: paarrotColors,
    });
    cacheProfileStyle(id, style);
    return {
      userId: id,
      displayName,
      avatarUrl: profileAvatarPath(id, 128),
      hasAvatar: Boolean(avatarMxc),
      bannerUrl,
      style,
      colorPreference: style?.colorPreference || null,
      paarrotColors,
      presence: null,
      statusMsg: client.getUser?.(id)?.presenceStatusMsg || '',
      powerLevel: 0,
      role: 'member',
      server: id.split(':').slice(1).join(':') || '',
      isSelf: id === client.getUserId(),
    };
  }

  function displayNameFor(userId, room = null) {
    if (!userId) return 'unknown';
    try {
      const member = room?.getMember?.(userId);
      const name = member?.name || member?.rawDisplayName;
      if (name && name !== userId) return name;
    } catch {
      /* ignore */
    }
    try {
      const user = client?.getUser?.(userId);
      if (user?.displayName) return user.displayName;
    } catch {
      /* ignore */
    }
    if (userId.startsWith('@') && userId.includes(':')) {
      return userId.slice(1).split(':')[0] || userId;
    }
    return userId;
  }

  function isSpaceRoom(room) {
    if (!room) return false;
    try {
      if (typeof room.isSpaceRoom === 'function') return room.isSpaceRoom();
      if (typeof room.getType === 'function' && room.getType() === 'm.space') return true;
      const create = room.currentState?.getStateEvents?.('m.room.create', '');
      return create?.getContent?.()?.type === 'm.space';
    } catch {
      return false;
    }
  }

  function getRoomCreateType(room) {
    try {
      if (typeof room?.getType === 'function') {
        const typed = room.getType();
        if (typeof typed === 'string' && typed) return typed;
      }
      const create = room.currentState?.getStateEvents?.('m.room.create', '');
      const type = create?.getContent?.()?.type;
      return typeof type === 'string' && type ? type : null;
    } catch {
      return null;
    }
  }

  function getPaarrotRoomKind(room) {
    try {
      const event = room.currentState?.getStateEvents?.('im.paarrot.room.kind', '');
      const kind = event?.getContent?.()?.kind;
      return typeof kind === 'string' && kind ? kind : null;
    } catch {
      return null;
    }
  }

  function getSpaceChildEntries(spaceRoom) {
    const entries = [];
    if (!spaceRoom?.currentState?.getStateEvents) return entries;
    const events = spaceRoom.currentState.getStateEvents('m.space.child') || [];
    const byId = new Map();
    for (const event of events) {
      const roomId = event.getStateKey?.();
      const content = event.getContent?.() || {};
      if (!roomId || !content || Object.keys(content).length === 0) continue;
      byId.set(roomId, {
        roomId,
        order: typeof content.order === 'string' ? content.order : null,
        suggested: Boolean(content.suggested),
      });
    }
    entries.push(...byId.values());
    entries.sort((a, b) => {
      if (a.order && b.order && a.order !== b.order) return a.order < b.order ? -1 : 1;
      if (a.order && !b.order) return -1;
      if (!a.order && b.order) return 1;
      return String(a.roomId).localeCompare(String(b.roomId));
    });
    return entries;
  }

  function getSpaceChildIds(spaceRoom) {
    return new Set(getSpaceChildEntries(spaceRoom).map((entry) => entry.roomId));
  }

  function isForumContainer(room) {
    if (!room) return false;
    if (getPaarrotRoomKind(room) === 'forum_space') return true;
    if (getRoomCreateType(room) !== 'm.forum') return false;
    if (isSpaceRoom(room)) return true;
    return getSpaceChildEntries(room).length > 0;
  }

  function isSpaceLikeRoom(room) {
    return isSpaceRoom(room) || isForumContainer(room);
  }

  function isJoined(room) {
    try {
      return room.getMyMembership?.() === 'join';
    } catch {
      return false;
    }
  }

  function getDirectIds() {
    const set = new Set();
    try {
      const map = client?.getAccountData?.('m.direct')?.getContent?.() || {};
      for (const rooms of Object.values(map)) {
        for (const id of rooms || []) set.add(id);
      }
    } catch {
      /* ignore */
    }
    return set;
  }

  function getJoinedParentSpaceIds(room) {
    const ids = new Set();
    if (!room?.currentState?.getStateEvents) return ids;
    const events = room.currentState.getStateEvents('m.space.parent') || [];
    for (const event of events) {
      const parentId = event.getStateKey?.();
      const content = event.getContent?.() || {};
      if (!parentId || !content || Object.keys(content).length === 0) continue;
      ids.add(parentId);
    }
    return ids;
  }

  function spaceDedupeKey(name) {
    return String(name || '')
      .trim()
      .toLowerCase()
      .replace(/\s*\([^)]*\)\s*$/u, '')
      .replace(/\s+/gu, ' ')
      .trim();
  }

  function getPaarrotSubRoomIds(room) {
    try {
      if (!room?.currentState?.getStateEvents) return [];
      let event = room.currentState.getStateEvents('im.paarrot.sub_rooms', '');
      if (!event) {
        const all = room.currentState.getStateEvents('im.paarrot.sub_rooms') || [];
        event = Array.isArray(all) ? all[0] : all;
      }
      const content = event?.getContent?.() || {};
      const raw = content.children ?? content.rooms ?? content.room_ids ?? [];
      return Array.isArray(raw)
        ? raw.filter((id) => typeof id === 'string' && id.startsWith('!'))
        : [];
    } catch {
      return [];
    }
  }

  function getRoomAvatarMxc(room) {
    if (!room) return null;
    try {
      if (typeof room.getMxcAvatarUrl === 'function') {
        const mxc = room.getMxcAvatarUrl();
        if (mxc) return mxc;
      }
      const event = room.currentState?.getStateEvents?.('m.room.avatar', '');
      const url = event?.getContent?.()?.url;
      return typeof url === 'string' ? url : null;
    } catch {
      return null;
    }
  }

  function getDmPeerUserId(room) {
    if (!room || !client) return null;
    try {
      const myId = client.getUserId();
      const members = room.getJoinedMembers?.() || [];
      const other = members.find((m) => m.userId !== myId);
      return other?.userId || null;
    } catch {
      return null;
    }
  }

  function getRoomAvatarRemote(room, size = 96, { original = false } = {}) {
    if (!client || !room) return null;
    const mxc = getRoomAvatarMxc(room);
    if (mxc) {
      if (original) return mxcToFullRemote(mxc);
      return mxcToRemote(mxc, size, size, 'crop') || mxcToFullRemote(mxc);
    }
    const peerId = getDmPeerUserId(room);
    if (peerId) {
      const peerMxc = getAvatarMxc(peerId, room);
      if (peerMxc) {
        if (original) return mxcToFullRemote(peerMxc);
        return mxcToRemote(peerMxc, size, size, 'crop') || mxcToFullRemote(peerMxc);
      }
    }
    return null;
  }

  async function fetchRoomAvatarBuffer(roomId, size = 96, { original = false } = {}) {
    if (!client || !roomId) return null;
    const cacheKey = `room-avatar:${roomId}:${size}:${original ? 1 : 0}`;
    const cached = readMediaBuffer(cacheKey);
    if (cached) return cached;
    const room = client.getRoom(roomId);
    if (!room) return null;
    const remote = getRoomAvatarRemote(room, size, { original });
    if (!remote) return null;
    const media = await fetchRemoteMedia(remote);
    if (!media) return null;
    return rememberMediaBuffer(cacheKey, media);
  }

  function getSpaceSummary(spaceId) {
    if (!client) return null;
    const room = client.getRoom(spaceId);
    if (!room || !isSpaceLikeRoom(room)) return null;
    const childIds = [...getSpaceChildIds(room)];
    let unread = 0;
    for (const childId of childIds) {
      const child = client.getRoom(childId);
      if (!child || isSpaceLikeRoom(child)) continue;
      unread += child.getUnreadNotificationCount?.() || 0;
    }
    unread += room.getUnreadNotificationCount?.() || 0;
    const alias = room.getCanonicalAlias?.() || null;
    const topic = room.currentState?.getStateEvents?.('m.room.topic', '')?.getContent?.()?.topic || '';
    const hasAvatar = Boolean(getRoomAvatarRemote(room, 96, { original: true }));
    return {
      spaceId: room.roomId,
      name: room.name || room.roomId,
      topic,
      alias,
      permalink: alias ? `https://matrix.to/#/${alias}` : `https://matrix.to/#/${room.roomId}`,
      childCount: childIds.length,
      unread,
      avatarUrl: roomAvatarPath(room.roomId, 96, { original: true }),
      hasAvatar,
      isForum: isForumContainer(room),
    };
  }

  function listSpaces() {
    if (!client) return [];
    const spaces = (client.getRooms() || []).filter((room) => isSpaceLikeRoom(room) && isJoined(room));
    const joinedIds = new Set(spaces.map((room) => room.roomId));
    const childOfSpace = new Set();
    for (const space of spaces) {
      for (const childId of getSpaceChildIds(space)) childOfSpace.add(childId);
    }
    const roots = spaces
      .filter((room) => {
        if (childOfSpace.has(room.roomId)) return false;
        for (const parentId of getJoinedParentSpaceIds(room)) {
          if (joinedIds.has(parentId) && parentId !== room.roomId) return false;
        }
        return true;
      })
      .map((room) => {
        const summary = getSpaceSummary(room.roomId);
        return {
          spaceId: room.roomId,
          name: summary?.name || room.name || room.roomId,
          avatarUrl: summary?.avatarUrl || null,
          hasAvatar: Boolean(summary?.hasAvatar),
          childCount: summary?.childCount || 0,
          unread: summary?.unread || 0,
          permalink: summary?.permalink || `https://matrix.to/#/${room.roomId}`,
          isForum: Boolean(summary?.isForum),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    const byName = new Map();
    for (const space of roots) {
      const key = spaceDedupeKey(space.name);
      if (!key) continue;
      const existing = byName.get(key);
      if (!existing) {
        byName.set(key, space);
        continue;
      }
      const preferNew =
        space.childCount > existing.childCount ||
        (space.childCount === existing.childCount && space.name.length < existing.name.length);
      if (preferNew) byName.set(key, space);
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  function listSpaceSidebar(spaceId) {
    if (!client) return { groups: [], rooms: [], space: null, parents: [] };
    const spaceRoom = client.getRoom(spaceId);
    if (!spaceRoom || !isSpaceLikeRoom(spaceRoom)) return { groups: [], rooms: [], space: null, parents: [] };

    const directIds = getDirectIds();
    const flatRooms = [];
    const seen = new Set();
    const placedRooms = new Set();
    const placedSections = new Set();
    const groups = [];
    let current = null;

    const globalSubRoomIds = new Set();
    for (const room of client.getRooms() || []) {
      for (const childId of getPaarrotSubRoomIds(room)) globalSubRoomIds.add(childId);
    }

    const takeRoom = (room) => {
      if (!room || !isJoined(room) || isSpaceLikeRoom(room)) return null;
      if (seen.has(room.roomId)) {
        return flatRooms.find((entry) => entry.roomId === room.roomId) || null;
      }
      const item = serializeRoom(room, { isDirect: directIds.has(room.roomId) });
      seen.add(room.roomId);
      flatRooms.push(item);
      return item;
    };

    const sectionMeta = (space) => ({
      avatarUrl: roomAvatarPath(space.roomId, 48),
      hasAvatar: Boolean(getRoomAvatarRemote(space, 48)),
      memberCount:
        typeof space.getJoinedMemberCount === 'function'
          ? space.getJoinedMemberCount()
          : space.getJoinedMembers?.()?.length || 0,
    });

    const startSection = (sectionSpace, label, { suggested = false } = {}) => {
      if (placedSections.has(sectionSpace.roomId)) {
        current = groups.find((group) => group.spaceId === sectionSpace.roomId) || current;
        return current;
      }
      placedSections.add(sectionSpace.roomId);
      const isRootRooms = sectionSpace.roomId === spaceId;
      current = {
        type: isRootRooms ? 'section' : 'folder',
        id: isRootRooms ? `${spaceId}:rooms` : sectionSpace.roomId,
        spaceId: sectionSpace.roomId,
        name: label,
        unread: 0,
        suggested: Boolean(suggested),
        ...sectionMeta(sectionSpace),
        items: [],
        rooms: [],
      };
      groups.push(current);
      return current;
    };

    const pushRoomItem = (room, { suggested = false, depth = 0 } = {}) => {
      if (placedRooms.has(room.roomId)) return;
      const item = takeRoom(room);
      if (!item) return;
      placedRooms.add(room.roomId);
      if (!current) startSection(spaceRoom, 'Rooms');
      const row = {
        type: 'room',
        ...item,
        suggested: Boolean(suggested),
        depth: Number(depth) || 0,
      };
      current.items.push(row);
      current.rooms.push(item);
      current.unread += Number(item.unread) || 0;
    };

    const addSubRooms = (parentRoom, depth) => {
      if (depth > 6) return;
      for (const childId of getPaarrotSubRoomIds(parentRoom)) {
        if (placedRooms.has(childId)) continue;
        const child = client.getRoom(childId);
        if (!child || !isJoined(child) || isSpaceLikeRoom(child)) continue;
        pushRoomItem(child, { depth: depth + 1 });
        addSubRooms(child, depth + 1);
      }
    };

    const walkSpaceChildren = (parentSpace) => {
      for (const entry of getSpaceChildEntries(parentSpace)) {
        if (globalSubRoomIds.has(entry.roomId) && !isSpaceLikeRoom(client.getRoom(entry.roomId))) {
          continue;
        }
        const child = client.getRoom(entry.roomId);
        if (!child || !isJoined(child)) continue;
        if (isSpaceLikeRoom(child)) {
          if (placedSections.has(child.roomId)) continue;
          startSection(child, child.name || child.roomId, { suggested: entry.suggested });
          walkSpaceChildren(child);
          continue;
        }
        pushRoomItem(child, { suggested: entry.suggested, depth: 0 });
        addSubRooms(child, 0);
      }
    };

    for (const entry of getSpaceChildEntries(spaceRoom)) {
      const child = client.getRoom(entry.roomId);
      if (!child || !isJoined(child)) continue;
      if (isSpaceLikeRoom(child)) {
        if (placedSections.has(child.roomId)) continue;
        startSection(child, child.name || child.roomId, { suggested: entry.suggested });
        walkSpaceChildren(child);
        continue;
      }
      if (globalSubRoomIds.has(child.roomId)) continue;
      if (!current || current.spaceId !== spaceId) startSection(spaceRoom, 'Rooms');
      pushRoomItem(child, { suggested: entry.suggested, depth: 0 });
      addSubRooms(child, 0);
    }

    let pruned = groups.filter(
      (group) => group.items.length > 0 || group.spaceId === spaceId,
    );

    // If hierarchy state is thin, still surface joined rooms so Lobby isn't empty.
    if (!pruned.length && flatRooms.length) {
      pruned.push({
        type: 'section',
        id: `${spaceId}:rooms`,
        spaceId,
        name: 'Rooms',
        unread: flatRooms.reduce((sum, room) => sum + (Number(room.unread) || 0), 0),
        suggested: false,
        avatarUrl: roomAvatarPath(spaceId, 48),
        hasAvatar: Boolean(getRoomAvatarRemote(spaceRoom, 48)),
        memberCount: spaceRoom.getJoinedMemberCount?.() || 0,
        items: flatRooms.map((room) => ({ type: 'room', ...room, depth: 0 })),
        rooms: flatRooms.slice(),
      });
    } else if (!pruned.length) {
      // Keep an empty Rooms section so Lobby can still render Add Room/Space.
      pruned.push({
        type: 'section',
        id: `${spaceId}:rooms`,
        spaceId,
        name: 'Rooms',
        unread: 0,
        suggested: false,
        ...sectionMeta(spaceRoom),
        items: [],
        rooms: [],
      });
    }

    const parents = [...getJoinedParentSpaceIds(spaceRoom)]
      .filter((id) => id && id !== spaceId && client.getRoom(id))
      .map((id) => {
        const parent = client.getRoom(id);
        return { spaceId: id, name: parent?.name || id };
      });

    return {
      groups: pruned,
      rooms: flatRooms,
      parents,
      space: getSpaceSummary(spaceId) || null,
    };
  }

  function publicState() {
    if (!client) {
      return {
        connected: false,
        ready: false,
        restoring: false,
        userId: null,
        displayName: null,
        homeserver: null,
        deviceId: null,
        avatarUrl: null,
        error: lastError,
      };
    }
    const userId = client.getUserId();
    const profile = client.getUser?.(userId);
    const avatarMxc = profile?.avatarUrl || null;
    return {
      connected: true,
      ready,
      restoring,
      userId,
      displayName: profile?.displayName || displayNameFor(userId),
      homeserver: client.getHomeserverUrl?.() || client.baseUrl || null,
      deviceId: client.getDeviceId?.() || null,
      avatarUrl: mxcToHttp(avatarMxc, 96),
      hasAvatar: Boolean(avatarMxc),
      error: lastError,
    };
  }

  function getDmSidebarStatus(room) {
    const myUserId = client?.getUserId?.();
    const members = room.getJoinedMembers?.() || [];
    const typingUsers = members.filter(
      (member) => member?.typing && member.userId && member.userId !== myUserId,
    );
    const typing = typingUsers.length > 0;
    const typingLabel = typing
      ? typingUsers.length === 1
        ? 'Typing…'
        : `${typingUsers.length} typing…`
      : '';
    let lastMine = false;
    let peerRead = false;
    const peerId = getDmPeerUserId(room);
    const liveEvents = room.getLiveTimeline?.()?.getEvents?.() || [];
    for (let i = liveEvents.length - 1; i >= 0; i -= 1) {
      const ev = liveEvents[i];
      if (!ev) continue;
      const type = ev.getType?.();
      if (type !== 'm.room.message' && type !== 'm.room.encrypted') continue;
      if (ev.isRedacted?.()) continue;
      lastMine = ev.getSender?.() === myUserId;
      if (!lastMine || !peerId) break;
      const lastId = ev.getId?.();
      if (!lastId) break;
      let peerUpTo = null;
      try {
        peerUpTo = room.getEventReadUpTo?.(peerId) || null;
      } catch {
        peerUpTo = null;
      }
      if (!peerUpTo) break;
      if (peerUpTo === lastId) {
        peerRead = true;
        break;
      }
      let peerIdx = -1;
      for (let j = 0; j < liveEvents.length; j += 1) {
        if (liveEvents[j]?.getId?.() === peerUpTo) {
          peerIdx = j;
          break;
        }
      }
      peerRead = peerIdx >= i;
      break;
    }
    return { typing, typingLabel, lastMine, peerRead };
  }

  function serializeRoom(room, { isDirect = false } = {}) {
    const myUserId = client.getUserId();
    let dmUserId = null;
    if (isDirect) dmUserId = getDmPeerUserId(room);
    const last = room.getLastLiveEvent?.() || room.getLiveTimeline?.()?.getEvents?.()?.slice(-1)?.[0];
    const hasAvatar = Boolean(getRoomAvatarRemote(room, 96));
    const dmStatus = isDirect
      ? getDmSidebarStatus(room)
      : { typing: false, typingLabel: '', lastMine: false, peerRead: false };
    return {
      roomId: room.roomId,
      name: room.name || room.roomId,
      topic: room.currentState?.getStateEvents?.('m.room.topic', '')?.getContent?.()?.topic || '',
      unread: room.getUnreadNotificationCount?.() || 0,
      lastEventTs: last?.getTs?.() || room.getLastActiveTimestamp?.() || 0,
      encrypted: Boolean(room.hasEncryptionStateEvent?.()),
      isSpace: false,
      isDirect,
      dmUserId,
      presence: null,
      online: false,
      typing: dmStatus.typing,
      typingLabel: dmStatus.typingLabel,
      lastMine: dmStatus.lastMine,
      peerRead: dmStatus.peerRead,
      alias: room.getCanonicalAlias?.() || null,
      permalink: `https://matrix.to/#/${room.roomId}`,
      avatarUrl: roomAvatarPath(room.roomId, 96),
      avatarUrlLg: roomAvatarPath(room.roomId, 128, { original: true }),
      hasAvatar,
      memberCount: room.getJoinedMemberCount?.() || 0,
      pinnedCount: 0,
      voiceMembers: [],
      creatorUserId: null,
      creatorName: null,
      createdTs: null,
      joinRule: room.getJoinRule?.() || 'invite',
    };
  }

  function listRooms(filter = 'dms') {
    if (!client) return [];
    const directIds = getDirectIds();
    if (filter && filter.startsWith('!')) {
      return listSpaceSidebar(filter).rooms || [];
    }
    return (client.getRooms?.() || [])
      .filter((room) => {
        if (!isJoined(room) || isSpaceLikeRoom(room)) return false;
        // dms/home: all joined non-space rooms (spaces keep their own sidebars).
        if (filter === 'dms' || filter === 'home') return true;
        return true;
      })
      .map((room) => serializeRoom(room, { isDirect: directIds.has(room.roomId) }))
      .sort((a, b) => b.lastEventTs - a.lastEventTs);
  }

  function serializeEvent(room, event) {
    const type = event.getType?.() || event.getWireType?.() || '';
    const sender = event.getSender?.() || '';
    const content = event.getContent?.() || {};
    const myUserId = client.getUserId();
    const isMine = sender === myUserId;
    const redacted = Boolean(event.isRedacted?.());
    let body = content.body || null;
    let msgtype = content.msgtype || null;
    let encrypted = type === 'm.room.encrypted';
    if (encrypted && !body) body = '[Unable to decrypt]';

    const clear = event.isDecryptionFailure?.() ? null : event;
    const clearContent = clear?.getContent?.() || content;
    if (clear && type === 'm.room.encrypted') {
      encrypted = false;
      body = clearContent.body || body;
      msgtype = clearContent.msgtype || msgtype;
    }

    const imageMxc = msgtype === 'm.image' ? clearContent.url : null;
    const videoMxc = msgtype === 'm.video' ? clearContent.url : null;

    return {
      eventId: event.getId?.(),
      type: clear?.getType?.() || type,
      sender,
      senderName: displayNameFor(sender, room),
      senderAvatarUrl: profileAvatarPath(sender, 96),
      hasSenderAvatar: Boolean(getAvatarMxc(sender, room) || client.getUser?.(sender)?.avatarUrl),
      senderStyle: profileStyleCache.get(sender) || null,
      isMine,
      canRedact: isMine,
      ts: event.getTs?.() || 0,
      body: redacted ? null : body,
      html: redacted ? null : clearContent.formatted_body || null,
      msgtype: redacted ? null : msgtype,
      imageUrl: imageMxc ? mxcToHttp(imageMxc, 1280) : null,
      imageFullUrl: imageMxc ? mxcToHttp(imageMxc) : null,
      imageMxc,
      imageFilename: clearContent.body || null,
      imageInfo: clearContent.info || null,
      videoUrl: videoMxc ? mxcToHttp(videoMxc) : null,
      videoFullUrl: videoMxc ? mxcToHttp(videoMxc) : null,
      videoMxc,
      videoFilename: clearContent.body || null,
      videoInfo: clearContent.info || null,
      encrypted,
      redacted,
      readBy: [],
      reactions: [],
      canEdit: isMine && msgtype === 'm.text',
      canPin: false,
      isPinned: false,
    };
  }

  function isRoomTimelineAtStart(roomId) {
    const room = client?.getRoom?.(roomId);
    if (!room) return true;
    try {
      const Matrix = sdk();
      const backwards = Matrix.EventTimeline?.BACKWARDS ?? 'b';
      const token = room.getLiveTimeline?.()?.getPaginationToken?.(backwards);
      return token == null;
    } catch {
      return true;
    }
  }

  function countRoomChatEvents(roomId) {
    const room = client?.getRoom?.(roomId);
    if (!room) return 0;
    const events = room.getLiveTimeline?.()?.getEvents?.() || [];
    let count = 0;
    for (const event of events) {
      const type = event.getType?.() || '';
      if (
        type === 'm.room.message' ||
        type === 'm.room.encrypted' ||
        type === 'm.reaction' ||
        type === 'm.sticker'
      ) {
        count += 1;
      }
    }
    return count;
  }

  async function scrollbackRoom(roomId, limit = 100) {
    if (!client) throw new Error('Not logged in');
    const room = client.getRoom(roomId);
    if (!room) throw new Error('Room not found');
    const before = room.getLiveTimeline?.()?.getEvents?.()?.length || 0;
    if (isRoomTimelineAtStart(roomId)) {
      return { roomId, added: 0, eventCount: before, atStart: true };
    }
    const batch = Math.max(10, Math.min(200, Number(limit) || 100));
    await client.scrollback(room, batch);
    const after = room.getLiveTimeline?.()?.getEvents?.()?.length || 0;
    return {
      roomId,
      added: Math.max(0, after - before),
      eventCount: after,
      atStart: isRoomTimelineAtStart(roomId),
    };
  }

  async function ensureRoomHistory(
    roomId,
    { minEvents = 200, minMessages = 0, batchSize = 100, maxBatches = 40 } = {},
  ) {
    if (!client) throw new Error('Not logged in');
    const room = client.getRoom(roomId);
    if (!room) throw new Error('Room not found');
    const targetEvents = Math.max(30, Math.min(8000, Number(minEvents) || 200));
    const targetMessages = Math.max(0, Math.min(4000, Number(minMessages) || 0));
    const size = Math.max(10, Math.min(200, Number(batchSize) || 100));
    const batches = Math.max(1, Math.min(120, Number(maxBatches) || 40));
    let runs = 0;
    let addedTotal = 0;
    while (runs < batches) {
      const count = room.getLiveTimeline?.()?.getEvents?.()?.length || 0;
      const chatCount = countRoomChatEvents(roomId);
      if (count >= targetEvents && (!targetMessages || chatCount >= targetMessages)) break;
      if (isRoomTimelineAtStart(roomId)) break;
      const result = await scrollbackRoom(roomId, size);
      runs += 1;
      addedTotal += result.added || 0;
      if (result.atStart || !result.added) break;
    }
    return {
      roomId,
      eventCount: room.getLiveTimeline?.()?.getEvents?.()?.length || 0,
      messageCount: countRoomChatEvents(roomId),
      added: addedTotal,
      batches: runs,
      atStart: isRoomTimelineAtStart(roomId),
    };
  }

  function getTimeline(roomId, limit = 500) {
    const room = client?.getRoom?.(roomId);
    if (!room) return { roomId, messages: [], atStart: true, history: null };
    const events = room.getLiveTimeline?.()?.getEvents?.() || [];
    const want = Math.max(1, Math.min(2500, Number(limit) || 500));
    const slice = events.slice(-Math.min(events.length, want * 3));
    const messages = [];
    for (const event of slice) {
      const type = event.getType?.() || '';
      if (type === 'm.room.redaction') continue;
      if (event.isRelation?.('m.replace')) continue;
      if (
        type === 'm.room.message' ||
        type === 'm.room.encrypted' ||
        type === 'm.room.member' ||
        type === 'm.room.name' ||
        type === 'm.room.topic' ||
        type === 'm.room.avatar'
      ) {
        if (type.startsWith('m.room.') && type !== 'm.room.message' && type !== 'm.room.encrypted') {
          messages.push({
            ...serializeEvent(room, event),
            systemKind: type === 'm.room.member' ? 'membership' : 'room',
            systemAction: type === 'm.room.member' ? event.getContent?.()?.membership || 'join' : 'room_name',
            body: event.getContent?.()?.body || event.getContent?.()?.membership || type,
          });
        } else {
          messages.push(serializeEvent(room, event));
        }
      }
    }
    return {
      roomId,
      messages: messages.slice(-want),
      atStart: isRoomTimelineAtStart(roomId),
      history: null,
    };
  }

  function emitLive(payload) {
    for (const fn of liveListeners) {
      try {
        fn(payload);
      } catch {
        /* ignore */
      }
    }
  }

  function wireClient(c) {
    c.on?.('sync', (state) => {
      if (state === 'PREPARED' || state === 'SYNCING') {
        ready = true;
        restoring = false;
        emitLive({ kind: 'sync', state, live: true });
      }
    });
    c.on?.('Room.timeline', (event, room, toStartOfTimeline) => {
      if (toStartOfTimeline || !ready || !room) return;
      const type = event.getType?.() || '';
      if (
        type === 'm.room.message' ||
        type === 'm.room.encrypted' ||
        type === 'm.room.redaction' ||
        type === 'm.reaction'
      ) {
        emitLive({
          kind: 'timeline',
          roomId: room.roomId,
          eventId: event.getId?.(),
          type,
          sender: event.getSender?.(),
          live: true,
        });
      }
    });
    c.on?.('Event.decrypted', (event) => {
      const roomId = event.getRoomId?.();
      if (!roomId || !ready) return;
      emitLive({
        kind: 'timeline',
        roomId,
        eventId: event.getId?.(),
        type: event.getType?.(),
        sender: event.getSender?.(),
        live: true,
        decrypted: true,
      });
    });
  }

  async function resolveHomeserver(homeserver) {
    const Matrix = sdk();
    const input = String(homeserver || '').trim();
    if (!input) throw new Error('Homeserver is required');
    try {
      if (Matrix.AutoDiscovery?.findClientConfig) {
        const conf = await Matrix.AutoDiscovery.findClientConfig(input.replace(/^https?:\/\//, '').split('/')[0]);
        const url = conf?.['m.homeserver']?.base_url;
        if (url) return url.replace(/\/$/, '');
      }
    } catch {
      /* fall through */
    }
    if (/^https?:\/\//i.test(input)) return input.replace(/\/$/, '');
    return `https://${input.replace(/\/$/, '')}`;
  }

  async function startFromSession(session) {
    const Matrix = sdk();
    restoring = true;
    ready = false;
    lastError = null;
    const c = Matrix.createClient({
      baseUrl: session.baseUrl,
      accessToken: session.accessToken,
      userId: session.userId,
      deviceId: session.deviceId,
    });
    wireClient(c);
    client = c;
    try {
      await Matrix.ensureCryptoWasm?.();
      await c.initRustCrypto({
        useIndexedDB: true,
        cryptoDatabasePrefix: `kitsu-crypto-${session.userId}-${session.deviceId}`,
      });
    } catch (error) {
      console.warn('[kitsu-standalone] crypto init', error);
      lastError = error?.message || String(error);
    }
    c.startClient({ initialSyncLimit: 100, lazyLoadMembers: true });
    // ready flips on sync event
    window.setTimeout(() => {
      if (!ready) {
        ready = true;
        restoring = false;
      }
    }, 8000);
  }

  async function login({ homeserver, user, password, deviceName }) {
    await logout({ clearStorage: false });
    const Matrix = sdk();
    const baseUrl = await resolveHomeserver(homeserver);
    const bootstrap = Matrix.createClient({ baseUrl });
    const response = await bootstrap.login('m.login.password', {
      user: String(user || '').trim(),
      password: String(password || ''),
      initial_device_display_name: deviceName || 'Kitsu Android',
    });
    const session = {
      baseUrl,
      accessToken: response.access_token,
      userId: response.user_id,
      deviceId: response.device_id,
    };
    saveStoredSession(session);
    await startFromSession(session);
    return publicState();
  }

  async function logout({ clearStorage = true } = {}) {
    try {
      await client?.logout?.(true);
    } catch {
      /* ignore */
    }
    try {
      client?.stopClient?.();
    } catch {
      /* ignore */
    }
    client = null;
    ready = false;
    restoring = false;
    if (clearStorage) saveStoredSession(null);
    emitLive({ kind: 'session', connected: false, live: true });
  }

  async function boot() {
    const session = loadStoredSession();
    if (!session?.accessToken) return;
    try {
      await startFromSession(session);
    } catch (error) {
      console.warn('[kitsu-standalone] restore failed', error);
      lastError = error?.message || String(error);
      restoring = false;
    }
  }

  async function handleApi(method, pathname, url, body) {
    const path = pathname.replace(/\/$/, '') || '/';

    if (path === '/api/health' && method === 'GET') {
      return jsonResponse({
        ok: true,
        name: 'kitsu',
        version: '0.3.6-android',
        standalone: true,
        mode: 'browser-matrix',
      });
    }

    if (path === '/api/session' && method === 'GET') return jsonResponse(publicState());
    if (path === '/api/login' && method === 'POST') {
      try {
        return jsonResponse(await login(body || {}));
      } catch (error) {
        return errorResponse(error?.message || error, 400);
      }
    }
    if (path === '/api/logout' && method === 'POST') {
      await logout({ clearStorage: true });
      return jsonResponse({ ok: true });
    }

    if (path === '/api/rooms' && method === 'GET') {
      const filter = url.searchParams.get('space') || url.searchParams.get('filter') || 'home';
      const payload = { rooms: listRooms(filter), filter, ready, groups: [] };
      if (String(filter).startsWith('!')) {
        const sidebar = listSpaceSidebar(filter);
        payload.groups = sidebar.groups || [];
        payload.parents = sidebar.parents || [];
        payload.space = sidebar.space || null;
        if (Array.isArray(sidebar.rooms) && sidebar.rooms.length) payload.rooms = sidebar.rooms;
      }
      return jsonResponse(payload);
    }

    if (path === '/api/spaces' && method === 'GET') {
      if (!client) return errorResponse('Not logged in', 401);
      return jsonResponse({ spaces: listSpaces(), ready });
    }

    const spaceMatch = path.match(/^\/api\/spaces\/([^/]+)$/);
    if (spaceMatch && method === 'GET') {
      if (!client) return errorResponse('Not logged in', 401);
      const summary = getSpaceSummary(decodeURIComponent(spaceMatch[1]));
      if (!summary) return errorResponse('Space not found', 404);
      return jsonResponse(summary);
    }

    const spaceReadMatch = path.match(/^\/api\/spaces\/([^/]+)\/read$/);
    if (spaceReadMatch && method === 'POST') {
      if (!client) return errorResponse('Not logged in', 401);
      try {
        const spaceId = decodeURIComponent(spaceReadMatch[1]);
        const room = client.getRoom(spaceId);
        const targets = room ? [room] : [];
        if (room) {
          for (const childId of getSpaceChildIds(room)) {
            const child = client.getRoom(childId);
            if (child && !isSpaceRoom(child)) targets.push(child);
          }
        }
        for (const target of targets) {
          const events = target.getLiveTimeline?.()?.getEvents?.() || [];
          const last = events[events.length - 1];
          if (last) await client.sendReadReceipt(last, undefined, true);
        }
      } catch { /* ignore */ }
      return jsonResponse({ ok: true });
    }

    const roomMatch = path.match(/^\/api\/rooms\/([^/]+)$/);
    if (roomMatch && method === 'GET') {
      const roomId = decodeURIComponent(roomMatch[1]);
      const room = client?.getRoom?.(roomId);
      if (!room) return errorResponse('Room not found', 404);
      return jsonResponse(serializeRoom(room, { isDirect: getDirectIds().has(roomId) }));
    }

    const messagesMatch = path.match(/^\/api\/rooms\/([^/]+)\/messages$/);
    if (messagesMatch && method === 'GET') {
      if (!client) return errorResponse('Not logged in', 401);
      const roomId = decodeURIComponent(messagesMatch[1]);
      const limit = Number(url.searchParams.get('limit') || 200);
      const history =
        url.searchParams.get('history') === '1' || url.searchParams.get('history') === 'true';
      const minEvents = Number(url.searchParams.get('minEvents') || Math.max(limit, 400));
      const minMessages = Number(url.searchParams.get('minMessages') || Math.max(limit, 300));
      try {
        let historyMeta = null;
        if (history) {
          historyMeta = await ensureRoomHistory(roomId, {
            minEvents: Math.max(minEvents, minMessages),
            minMessages,
            batchSize: 100,
            maxBatches: 80,
          });
        } else {
          historyMeta = await ensureRoomHistory(roomId, {
            minEvents: Math.max(limit * 2, 200),
            minMessages: Math.min(400, Math.max(80, limit)),
            batchSize: 100,
            maxBatches: 40,
          });
        }
        const timeline = getTimeline(roomId, limit);
        return jsonResponse({
          ...timeline,
          atStart: historyMeta?.atStart ?? timeline.atStart,
          history: historyMeta,
        });
      } catch (error) {
        return errorResponse(error?.message || error, 400);
      }
    }

    const olderMatch = path.match(/^\/api\/rooms\/([^/]+)\/messages\/older$/);
    if (olderMatch && method === 'POST') {
      if (!client) return errorResponse('Not logged in', 401);
      const roomId = decodeURIComponent(olderMatch[1]);
      const limit = Number(body?.limit || url.searchParams.get('limit') || 120);
      const displayLimit = Number(body?.displayLimit || url.searchParams.get('displayLimit') || 500);
      try {
        const history = await ensureRoomHistory(roomId, {
          minEvents: Math.max(displayLimit * 2, 200),
          minMessages: Math.max(displayLimit, 200),
          batchSize: Math.max(80, Math.min(200, limit)),
          maxBatches: 6,
        });
        const timeline = getTimeline(roomId, displayLimit);
        return jsonResponse({
          roomId,
          messages: timeline.messages,
          added: history.added,
          eventCount: history.eventCount,
          atStart: history.atStart,
        });
      } catch (error) {
        return errorResponse(error?.message || error, 400);
      }
    }

    const sendMatch = path.match(/^\/api\/rooms\/([^/]+)\/send$/);
    if (sendMatch && method === 'POST') {
      const roomId = decodeURIComponent(sendMatch[1]);
      const text = String(body?.body || '');
      if (!client) return errorResponse('Not logged in', 401);
      if (!text.trim()) return errorResponse('Empty message');
      try {
        const result = await client.sendTextMessage(roomId, text);
        return jsonResponse({ eventId: result?.event_id || null });
      } catch (error) {
        return errorResponse(error?.message || error);
      }
    }

    const readMatch = path.match(/^\/api\/rooms\/([^/]+)\/read$/);
    if (readMatch && method === 'POST') {
      const roomId = decodeURIComponent(readMatch[1]);
      try {
        const room = client?.getRoom?.(roomId);
        const events = room?.getLiveTimeline?.()?.getEvents?.() || [];
        const last = events[events.length - 1];
        if (last) await client.sendReadReceipt(last, undefined, true);
      } catch {
        /* ignore */
      }
      return jsonResponse({ ok: true });
    }

    const typingMatch = path.match(/^\/api\/rooms\/([^/]+)\/typing$/);
    if (typingMatch && method === 'POST') {
      try {
        await client?.sendTyping?.(decodeURIComponent(typingMatch[1]), Boolean(body?.typing), 10000);
      } catch {
        /* ignore */
      }
      return jsonResponse({ ok: true });
    }
    if (typingMatch && method === 'GET') {
      return jsonResponse({ typing: [] });
    }

    if (path === '/api/profile-avatar' && method === 'GET') {
      const userId = String(url.searchParams.get('userId') || client?.getUserId() || '').trim();
      const size = Math.max(16, Math.min(256, Number(url.searchParams.get('size')) || 96));
      if (!client) return errorResponse('Not logged in', 401);
      const cacheKey = `profile-avatar:${userId}:${size}`;
      const cached = readMediaBuffer(cacheKey);
      const avatar = cached || await fetchAvatarBytes(userId, size);
      if (!avatar) return errorResponse('No avatar', 404);
      if (!cached) rememberMediaBuffer(cacheKey, avatar);
      return new Response(avatar.buffer, {
        status: 200,
        headers: {
          'Content-Type': avatar.contentType || 'image/png',
          'Cache-Control': 'private, max-age=300',
        },
      });
    }

    const roomAvatarMatch = path.match(/^\/api\/avatar\/(.+)$/);
    if (roomAvatarMatch && method === 'GET') {
      if (!client) return errorResponse('Not logged in', 401);
      const roomId = decodeURIComponent(roomAvatarMatch[1]);
      const size = Math.max(16, Math.min(256, Number(url.searchParams.get('size')) || 96));
      const original =
        url.searchParams.get('original') === '1' ||
        url.searchParams.get('original') === 'true' ||
        url.searchParams.get('transparent') === '1';
      const avatar = await fetchRoomAvatarBuffer(roomId, size, { original });
      if (!avatar) return errorResponse('No avatar', 404);
      return new Response(avatar.buffer, {
        status: 200,
        headers: {
          'Content-Type': avatar.contentType || 'image/png',
          'Cache-Control': 'private, max-age=300',
        },
      });
    }

    if (path === '/api/media' && method === 'GET') {
      const remote = String(url.searchParams.get('url') || '').trim();
      if (!remote) return errorResponse('Missing url');
      if (!client) return errorResponse('Not logged in', 401);
      try {
        const media = await fetchRemoteMedia(remote);
        if (!media) return errorResponse('Media unavailable', 404);
        const headers = {
          'Content-Type': media.contentType || 'application/octet-stream',
          'Cache-Control': 'private, max-age=300',
        };
        if (url.searchParams.get('download') === '1') {
          const filename = String(url.searchParams.get('filename') || 'download').replace(/[^\w.\-]+/g, '_');
          headers['Content-Disposition'] = `attachment; filename="${filename}"`;
        }
        return new Response(media.buffer, { status: 200, headers });
      } catch (error) {
        return errorResponse(error?.message || error, 404);
      }
    }

    if (path === '/api/profile' && method === 'GET') {
      try {
        return jsonResponse(await getUserProfile(url.searchParams.get('userId'), {
          roomId: url.searchParams.get('roomId') || null,
        }));
      } catch (error) {
        return errorResponse(error?.message || error, 400);
      }
    }

    if (path === '/api/paarrot-colors' && method === 'GET') {
      if (!client) return errorResponse('Not logged in', 401);
      try {
        const userId = String(url.searchParams.get('userId') || client.getUserId() || '').trim();
        const colors = await fetchAvatarPaarrotColors(userId);
        return jsonResponse({ userId, colors: colors || null });
      } catch (error) {
        return errorResponse(error?.message || error, 400);
      }
    }

    if (path === '/api/nameplates/panda/meta' && method === 'GET') {
      try {
        const res = await origFetch('/nameplates/panda.png');
        if (!res.ok) return jsonResponse({ id: 'panda', colors: null });
        const buf = await res.arrayBuffer();
        return jsonResponse({ id: 'panda', colors: extractMetadataFromImage(buf) });
      } catch (error) {
        return errorResponse(error?.message || error, 500);
      }
    }

    if (path === '/api/account' && method === 'GET') {
      if (!client) return errorResponse('Not logged in', 401);
      try {
        const profile = await getUserProfile(client.getUserId());
        return jsonResponse({
          ...profile,
          emails: [],
          email: null,
          ignoredUsers: [],
          homeserver: client.getHomeserverUrl?.() || client.baseUrl || null,
        });
      } catch (error) {
        return errorResponse(error?.message || error, 400);
      }
    }

    if (path === '/api/explore/rooms' && method === 'GET') {
      if (!client) return errorResponse('Not logged in', 401);
      try {
        const serverName = String(url.searchParams.get('server') || '')
          .trim()
          .replace(/^https?:\/\//i, '')
          .replace(/\/+$/, '')
          .split('/')[0];
        if (!serverName) return errorResponse('Server is required', 400);
        const limit = Math.min(
          Math.max(Number(url.searchParams.get('limit') || 24) || 24, 1),
          100,
        );
        const term = String(url.searchParams.get('q') || url.searchParams.get('term') || '').trim();
        const since = url.searchParams.get('since') || null;
        const roomTypesRaw = String(
          url.searchParams.get('roomTypes') || url.searchParams.get('type') || '',
        ).trim();
        const opts = { server: serverName, limit };
        if (since) opts.since = since;
        const filter = {};
        if (term) filter.generic_search_term = term;
        if (roomTypesRaw === 'spaces' || roomTypesRaw === 'm.space') filter.room_types = ['m.space'];
        else if (roomTypesRaw === 'rooms' || roomTypesRaw === 'null') filter.room_types = [null];
        if (Object.keys(filter).length) opts.filter = filter;
        const result = await client.publicRooms(opts);
        const rooms = (result?.chunk || []).map((room) => {
          const avatarMxc = room?.avatar_url || null;
          let avatarHttp = null;
          if (avatarMxc && typeof client.mxcUrlToHttp === 'function') {
            try {
              avatarHttp =
                client.mxcUrlToHttp(avatarMxc, 96, 96, 'crop', false, true, true) || null;
            } catch {
              avatarHttp = null;
            }
          }
          return {
            roomId: room.room_id,
            name: room.name || room.canonical_alias || room.room_id,
            topic: room.topic || '',
            alias: room.canonical_alias || null,
            avatarUrl: avatarMxc,
            avatarHttp,
            memberCount: Number(room.num_joined_members) || 0,
            joinRule: room.join_rule || null,
            worldReadable: Boolean(room.world_readable),
            guestCanJoin: Boolean(room.guest_can_join),
            roomType: room.room_type || null,
            isSpace: room.room_type === 'm.space',
          };
        });
        return jsonResponse({
          server: serverName,
          rooms,
          nextBatch: result?.next_batch || null,
          total: result?.total_room_count_estimate ?? null,
        });
      } catch (error) {
        return errorResponse(error?.message || error, 400);
      }
    }

    if (path === '/api/join' && method === 'POST') {
      if (!client) return errorResponse('Not logged in', 401);
      try {
        let value = String(body?.id || body?.alias || body?.link || '').trim();
        if (!value) return errorResponse('Room ID, alias, or link is required', 400);
        const matrixTo = value.match(/matrix\.to\/#\/([^?/\s]+)/i);
        if (matrixTo) value = decodeURIComponent(matrixTo[1]);
        if (value.startsWith('#') && !value.includes(':')) {
          const userId = client.getUserId() || '';
          const domain = userId.includes(':') ? userId.split(':').slice(1).join(':') : '';
          if (domain) value = `${value}:${domain}`;
        }
        const room = await client.joinRoom(value);
        const roomId = room?.roomId || value;
        const joined = client.getRoom(roomId) || room;
        const isSpace = joined ? isSpaceLikeRoom(joined) : false;
        return jsonResponse({
          ok: true,
          roomId,
          isSpace,
          joinedChildren: [],
          summary: joined
            ? isSpace
              ? getSpaceSummary(roomId)
              : serializeRoom(joined)
            : null,
        });
      } catch (error) {
        return errorResponse(error?.message || error, 400);
      }
    }

    if (path === '/api/devices' && method === 'GET') {
      if (!client) return errorResponse('Not logged in', 401);
      try {
        const currentId = client.getDeviceId?.() || null;
        let devices = [];
        try {
          const raw = await client.getDevices?.();
          devices = Array.isArray(raw?.devices) ? raw.devices : Array.isArray(raw) ? raw : [];
        } catch {
          devices = [];
        }
        const crypto = client.getCrypto?.();
        const userId = client.getUserId?.();
        const mapped = [];
        for (const device of devices) {
          const deviceId = device.device_id || device.deviceId;
          if (!deviceId) continue;
          let verified = false;
          if (crypto && userId && typeof crypto.getDeviceVerificationStatus === 'function') {
            try {
              const status = await crypto.getDeviceVerificationStatus(userId, deviceId);
              verified = Boolean(status?.isVerified?.() ?? status?.verified);
            } catch {
              verified = false;
            }
          }
          mapped.push({
            deviceId,
            displayName: device.display_name || device.displayName || deviceId,
            lastSeenTs: device.last_seen_ts || device.lastSeenTs || null,
            lastSeenIp: device.last_seen_ip || device.lastSeenIp || null,
            isCurrent: Boolean(currentId && deviceId === currentId),
            verified,
          });
        }
        const current = mapped.find((d) => d.isCurrent);
        const currentVerified = current ? Boolean(current.verified) : !crypto;
        const otherUnverifiedCount = mapped.filter((d) => !d.isCurrent && !d.verified).length;
        const unverifiedCount = currentVerified ? otherUnverifiedCount : 0;
        return jsonResponse({
          currentDeviceId: currentId,
          unverifiedCount,
          otherUnverifiedCount,
          currentDeviceUnverified: Boolean(crypto) && !currentVerified,
          showOtherVerification: currentVerified,
          security: {
            verification: currentVerified ? 'verified' : 'unverified',
            unverifiedCount,
            otherUnverifiedCount,
            currentDeviceUnverified: Boolean(crypto) && !currentVerified,
            showOtherVerification: currentVerified,
            cryptoEnabled: Boolean(crypto),
          },
          devices: mapped,
        });
      } catch (error) {
        return errorResponse(error?.message || error, 400);
      }
    }

    const confettiMatch = path.match(/^\/api\/rooms\/([^/]+)\/emoji-confetti$/);
    if (confettiMatch && method === 'POST') {
      if (!client) return errorResponse('Not logged in', 401);
      try {
        const roomId = decodeURIComponent(confettiMatch[1]);
        const pool = (Array.isArray(body?.emojis) ? body.emojis : [])
          .map((entry) => String(entry || '').trim())
          .filter(Boolean)
          .slice(0, 12);
        if (!pool.length) return errorResponse('Emoji list is required', 400);
        const content = {
          emojis: pool,
          msgtype: 'app.relay.emoji_confetti',
        };
        const target = String(body?.targetEventId || body?.eventId || '').trim();
        if (target) content.target_event_id = target;
        const result = await client.sendEvent(roomId, 'app.relay.emoji_confetti', content);
        emitLive({
          kind: 'emoji-confetti',
          roomId,
          emojis: pool,
          targetEventId: target || null,
          sender: client.getUserId?.() || null,
          live: true,
        });
        return jsonResponse({
          ok: true,
          eventId: result?.event_id || null,
          emojis: pool,
        });
      } catch (error) {
        return errorResponse(error?.message || error, 400);
      }
    }

    if (path === '/api/account/style' && method === 'PUT') {
      if (!client) return errorResponse('Not logged in', 401);
      try {
        const style = body?.style === null ? null : normalizeProfileStyle(body?.style || body || {});
        const colorPreference =
          normalizeColorPreference(style?.colorPreference) ||
          normalizeColorPreference({
            on_dark: style?.nameGradientStart || style?.color,
            on_light: style?.nameGradientEnd || style?.nameGradientStart || style?.color,
          });
        const payload = style
          ? {
              avatarBorder: style.avatarBorder || null,
              gradientStart: style.gradientStart || null,
              gradientEnd: style.gradientEnd || null,
              gradientAngle: Number(style.gradientAngle) || 180,
              nameplate: style.nameplate || null,
              nameGradientStart: style.nameGradientStart || colorPreference?.on_dark || null,
              nameGradientEnd: style.nameGradientEnd || colorPreference?.on_light || null,
              color: colorPreference?.on_dark || style.color || null,
              colorPreference,
              colors:
                style.nameGradientStart || style.nameGradientEnd || colorPreference
                  ? {
                      start: style.nameGradientStart || colorPreference?.on_dark || null,
                      end: style.nameGradientEnd || colorPreference?.on_light || null,
                    }
                  : null,
            }
          : null;
        const value = payload ? JSON.stringify(payload) : '';
        const userId = client.getUserId();
        let via = 'profile';
        try {
          if (payload && typeof client.setExtendedProfileProperty === 'function') {
            const supported = await client.doesServerSupportExtendedProfiles?.();
            if (supported) {
              await client.setExtendedProfileProperty('paarrot.colors', value);
              await client.setExtendedProfileProperty('app.relay.profile_style', value);
              if (colorPreference) {
                await client.setExtendedProfileProperty('m.color_preference', colorPreference);
              }
              via = 'extended';
            } else {
              await client.setProfileInfo('paarrot.colors', { 'paarrot.colors': value });
              await client.setProfileInfo('app.relay.profile_style', { 'app.relay.profile_style': value });
              if (colorPreference) {
                await client.setProfileInfo('m.color_preference', {
                  'm.color_preference': colorPreference,
                });
              }
            }
          } else if (payload) {
            await client.setProfileInfo('paarrot.colors', { 'paarrot.colors': value });
            await client.setProfileInfo('app.relay.profile_style', { 'app.relay.profile_style': value });
            if (colorPreference) {
              await client.setProfileInfo('m.color_preference', {
                'm.color_preference': colorPreference,
              });
            }
          }
        } catch (error) {
          return errorResponse(error?.message || error, 400);
        }
        cacheProfileStyle(userId, payload);
        return jsonResponse({ ok: true, style: payload, via });
      } catch (error) {
        return errorResponse(error?.message || error, 400);
      }
    }

    // Soft stubs so the desktop UI doesn't hard-crash on phone.
    if (path.startsWith('/api/')) {
      if (method === 'GET') {
        if (path === '/api/invites') return jsonResponse({ invites: [] });
        if (path === '/api/activity') return jsonResponse({ items: [], cursor: 0 });
        if (path === '/api/stickers') return jsonResponse({ packs: [], favorites: [] });
        if (path === '/api/plugins') return jsonResponse({ plugins: [] });
        if (path === '/api/themes') return jsonResponse({ themes: [] });
        // /api/devices handled above when crypto is available
        if (path === '/api/sidebar') return jsonResponse({ folders: [] });
        if (path.endsWith('/members')) return jsonResponse({ members: [] });
        if (path.endsWith('/pins')) return jsonResponse({ pins: [] });
        if (path.endsWith('/threads')) return jsonResponse({ threads: [] });
        if (path !== '/api/media' && path.endsWith('/media')) return jsonResponse({ media: [] });
        if (path.includes('/embed-filters')) return jsonResponse({ personal: [], room: [] });
        if (path === '/api/voip/config') return jsonResponse({});
        if (path === '/api/voip/ice') return jsonResponse({ iceServers: [] });
        if (path === '/api/control/status') return jsonResponse({});
        if (path === '/api/notifications/rules') return jsonResponse({ rules: [] });
        if (path === '/api/account/fav-emojis') return jsonResponse({ emojis: [] });
        return jsonResponse({});
      }
      if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
        return jsonResponse({ ok: true });
      }
    }

    return null;
  }

  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (!url.pathname.startsWith('/api/')) {
      return origFetch(input, init);
    }
    // Wait briefly for SDK if still loading
    for (let i = 0; i < 50 && !window.MatrixBrowserSdk; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
    }
    let body = null;
    if (init.body && typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = null;
      }
    }
    try {
      const handled = await handleApi((init.method || 'GET').toUpperCase(), url.pathname, url, body);
      if (handled) return handled;
    } catch (error) {
      return errorResponse(error?.message || error, 500);
    }
    return origFetch(input, init);
  };

  // SSE live feed from in-process sync
  const OrigES = window.EventSource;
  window.EventSource = function PatchedEventSource(url, config) {
    const href = String(url || '');
    if (!href.includes('/api/live')) {
      return new OrigES(url, config);
    }
    const target = new EventTarget();
    let closed = false;
    const listener = (payload) => {
      if (closed) return;
      const ev = new MessageEvent('live', { data: JSON.stringify(payload) });
      target.dispatchEvent(ev);
      if (typeof target.onmessage === 'function') target.onmessage(ev);
    };
    liveListeners.add(listener);
    queueMicrotask(() => {
      target.dispatchEvent(new MessageEvent('ready', { data: JSON.stringify({ ok: true }) }));
    });
    return {
      url: href,
      readyState: 1,
      withCredentials: false,
      CONNECTING: 0,
      OPEN: 1,
      CLOSED: 2,
      onopen: null,
      onmessage: null,
      onerror: null,
      addEventListener: (type, fn) => target.addEventListener(type, fn),
      removeEventListener: (type, fn) => target.removeEventListener(type, fn),
      close() {
        closed = true;
        liveListeners.delete(listener);
      },
      dispatchEvent: (e) => target.dispatchEvent(e),
    };
  };
  window.EventSource.CONNECTING = 0;
  window.EventSource.OPEN = 1;
  window.EventSource.CLOSED = 2;

  function isProxyMediaSrc(src) {
    return typeof src === 'string' && /^\/api\/(?:profile-avatar|media|avatar\/)/.test(src);
  }

  async function hydrateMediaNode(node) {
    if (!node) return;
    const imgs = [];
    if (node.matches?.('img[src^="/api/profile-avatar"], img[src^="/api/media"], img[src^="/api/avatar/"]')) {
      imgs.push(node);
    }
    if (node.querySelectorAll) {
      imgs.push(
        ...node.querySelectorAll(
          'img[src^="/api/profile-avatar"], img[src^="/api/media"], img[src^="/api/avatar/"]',
        ),
      );
    }
    for (const img of imgs) {
      const src = img.getAttribute('src');
      if (!isProxyMediaSrc(src) || img.dataset.kitsuHydrated === src) continue;
      try {
        if (blobUrlCache.has(src)) {
          img.dataset.kitsuHydrated = src;
          img.src = blobUrlCache.get(src);
          continue;
        }
        const res = await fetch(src);
        if (!res.ok) continue;
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        blobUrlCache.set(src, objectUrl);
        img.dataset.kitsuHydrated = src;
        img.src = objectUrl;
      } catch {
        /* retry on next hydrator pass */
      }
    }

    const styled = [];
    if (node.nodeType === 1) styled.push(node);
    if (node.querySelectorAll) {
      styled.push(
        ...node.querySelectorAll('[style*="/api/media"], [style*="/api/profile-avatar"], [style*="/api/avatar/"]'),
      );
    }
    for (const el of styled) {
      const bg = el.style?.backgroundImage || '';
      const match = bg.match(/url\(["']?(\/api\/(?:media|profile-avatar|avatar\/)[^"')]+)["']?\)/);
      if (!match) continue;
      const src = match[1];
      if (el.dataset.kitsuBgHydrated === src) continue;
      try {
        let objectUrl = blobUrlCache.get(src);
        if (!objectUrl) {
          const res = await fetch(src);
          if (!res.ok) continue;
          objectUrl = URL.createObjectURL(await res.blob());
          blobUrlCache.set(src, objectUrl);
        }
        el.dataset.kitsuBgHydrated = src;
        el.style.backgroundImage = `url("${objectUrl}")`;
      } catch {
        /* retry on next hydrator pass */
      }
    }
  }

  function startMediaHydrator() {
    const run = (root) => { void hydrateMediaNode(root || document); };
    run(document);
    const mo = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.target?.tagName === 'IMG') {
          void hydrateMediaNode(mutation.target);
        }
        for (const node of mutation.addedNodes || []) {
          if (node.nodeType === 1) void hydrateMediaNode(node);
        }
      }
    });
    mo.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'style'],
    });
    window.setInterval(() => run(document), 2500);
  }

  window.KitsuStandalone = {
    enabled: true,
    publicState,
    boot,
    login,
    logout,
    hydrateMedia: () => hydrateMediaNode(document),
    profileAvatarPath,
    mediaProxy,
  };

  // Boot after SDK script loads
  const start = () => {
    void boot();
    startMediaHydrator();
  };
  if (window.MatrixBrowserSdk) start();
  else {
    const timer = setInterval(() => {
      if (window.MatrixBrowserSdk) {
        clearInterval(timer);
        start();
      }
    }, 50);
    setTimeout(() => clearInterval(timer), 30000);
  }

  console.info('[kitsu] standalone browser backend armed');
})();
