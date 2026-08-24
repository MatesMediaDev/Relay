const fs = require('fs');
const path = require('path');
const { extractUrls } = require('../link-preview/LinkPreview');
const { extractMetadataFromImage } = require('../paarrot/imageMetadata');
const {
  AccountData: PaarrotAccountData,
  StateEvent: PaarrotStateEvent,
  Profile: PaarrotProfile,
} = require('../paarrot/constants');
const {
  getPersonalEmbedFilters,
  getRoomWideEmbedFilters,
  getCombinedEmbedPatterns,
  isUrlEmbedDisabled,
  normalizePatterns,
} = require('../paarrot/embedFilters');
const livekitRtc = require('../voip/LiveKitRtc');
const { ensureCryptoIndexedDb, resetCryptoIndexedDb, recoverCryptoIndexedDb, cryptoDatabasePrefix } = require('./cryptoStore');

/** @type {typeof import('matrix-js-sdk') | null} */
let sdkPromise = null;

function loadSdk() {
  if (!sdkPromise) {
    sdkPromise = import('matrix-js-sdk');
  }
  return sdkPromise;
}

/** Warm the SDK import without blocking — overlaps with HTTP listen / window open. */
function warmSdk() {
  return loadSdk().catch((error) => {
    console.warn('[MatrixSession] sdk warm failed:', error?.message || error);
  });
}

async function loadRecoveryKeyHelpers() {
  return import('matrix-js-sdk/lib/crypto-api/recovery-key.js');
}

/**
 * Server-side Matrix session for Kitsu.
 * Login + sync + room list against any homeserver (e.g. local Synapse).
 */
class MatrixSession {
  constructor(options = {}) {
    this.dataDir = options.dataDir || path.join(__dirname, '..', '..', '.relay-data');
    this.sessionFile = path.join(this.dataDir, 'session.json');
    this.cryptoSecretsFile = path.join(this.dataDir, 'crypto-secrets.json');
    this.pluginHost = options.pluginHost || null;
    /** @type {import('../voip/VoipHub').VoipHub | null} */
    this.voipHub = options.voipHub || null;
    /** @type {import('../live/LiveHub').LiveHub | null} */
    this.liveHub = options.liveHub || null;
    /** @type {import('matrix-js-sdk').MatrixClient | null} */
    this.client = null;
    this.ready = false;
    this.lastError = null;
    this.cryptoReady = false;
    /** True while restore()/startFromSession is in progress. */
    this.restoring = false;
    /** @type {object | null} Cached disk session while crypto/sync boots. */
    this.bootSession = null;
    this.cryptoError = null;
    /** @type {Uint8Array | null} */
    this.secretStoragePrivateKey = null;
    /** @type {string | null} */
    this.cachedRecoveryKey = null;
    /** @type {Array<Record<string, any>>} */
    this.activity = [];
    this.activityCursor = 0;
    /** @type {Map<string, object|null>} */
    this.profileStyleCache = new Map();
    /** @type {Map<string, { meta: object, ts: number, avatarKey: string }>} */
    this.avatarMetaCache = new Map();
    /** @type {Promise<object> | null} */
    this._presenceSetPromise = null;
    this._presenceSetAt = 0;
  }

  ensureDataDir() {
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  readStoredSession() {
    try {
      return JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'));
    } catch {
      return null;
    }
  }

  writeStoredSession(session) {
    this.ensureDataDir();
    fs.writeFileSync(this.sessionFile, JSON.stringify(session, null, 2), 'utf8');
  }

  clearStoredSession() {
    try {
      fs.unlinkSync(this.sessionFile);
    } catch {
      // ignore
    }
  }

  readCryptoSecrets() {
    try {
      return JSON.parse(fs.readFileSync(this.cryptoSecretsFile, 'utf8'));
    } catch {
      return null;
    }
  }

  writeCryptoSecrets(payload) {
    this.ensureDataDir();
    fs.writeFileSync(this.cryptoSecretsFile, JSON.stringify(payload, null, 2), 'utf8');
  }

  async loadCachedSecretStorageKey() {
    const secrets = this.readCryptoSecrets();
    const encoded = secrets?.recoveryKey;
    if (!encoded) return;
    try {
      const { decodeRecoveryKey } = await loadRecoveryKeyHelpers();
      this.secretStoragePrivateKey = decodeRecoveryKey(encoded);
      this.cachedRecoveryKey = encoded;
    } catch (error) {
      console.warn('[MatrixSession] failed to load recovery key:', error?.message || error);
    }
  }

  rememberSecretStorageKey(privateKey, encodedPrivateKey) {
    if (privateKey) this.secretStoragePrivateKey = privateKey;
    if (encodedPrivateKey) {
      this.cachedRecoveryKey = encodedPrivateKey;
      this.writeCryptoSecrets({
        recoveryKey: encodedPrivateKey,
        updatedAt: Date.now(),
      });
    }
  }

  getPublicState() {
    if (!this.client) {
      const boot = this.bootSession;
      // Only advertise a "connected" boot session while restore is actually running.
      // After a failed restore, bootSession is cleared — avoids empty chat chrome forever.
      if (boot?.userId && boot?.accessToken && this.restoring) {
        return {
          connected: true,
          ready: false,
          restoring: true,
          userId: boot.userId,
          displayName: boot.userId,
          homeserver: boot.baseUrl || null,
          deviceId: boot.deviceId || null,
          avatarUrl: null,
          hasAvatar: false,
          error: this.lastError,
        };
      }
      return {
        connected: false,
        ready: false,
        restoring: Boolean(this.restoring),
        userId: null,
        displayName: null,
        homeserver: null,
        deviceId: null,
        avatarUrl: null,
        error: this.lastError,
      };
    }

    const userId = this.client.getUserId();
    let displayName = userId;
    try {
      const user = this.client.getUser?.(userId);
      displayName = user?.displayName || userId;
    } catch {
      // ignore
    }

    return {
      connected: true,
      ready: this.ready,
      restoring: Boolean(this.restoring) && !this.ready,
      userId,
      displayName,
      homeserver: this.client.getHomeserverUrl(),
      deviceId: this.client.getDeviceId(),
      avatarUrl: this.getLocalProfileAvatarPath(userId, 96),
      hasAvatar: Boolean(this.getProfileAvatarRemoteUrl(userId, 96)),
      ...this.getSelfPresence(),
      error: this.lastError,
    };
  }

  getAccessTokenForDevtools() {
    if (!this.client) throw new Error('Not logged in');
    const token = this.client.getAccessToken?.();
    if (!token) throw new Error('No access token available');
    return { accessToken: token };
  }

  listAccountDataEvents() {
    if (!this.client) throw new Error('Not logged in');
    const map = this.client.store?.accountData;
    /** @type {string[]} */
    const types = [];
    if (map && typeof map.keys === 'function') {
      for (const type of map.keys()) {
        if (type) types.push(String(type));
      }
    }
    types.sort((a, b) => a.localeCompare(b));
    return {
      events: types.map((type) => ({ type })),
      total: types.length,
    };
  }

  getAccountDataEvent(eventType) {
    if (!this.client) throw new Error('Not logged in');
    const type = String(eventType || '').trim();
    if (!type) throw new Error('Event type required');
    const event = this.client.getAccountData?.(type);
    if (!event) throw new Error(`No account data for ${type}`);
    return {
      type,
      content: event.getContent?.() || {},
    };
  }

  async setAccountDataEvent(eventType, content) {
    if (!this.client) throw new Error('Not logged in');
    const type = String(eventType || '').trim();
    if (!type) throw new Error('Event type required');
    if (!content || typeof content !== 'object' || Array.isArray(content)) {
      throw new Error('Content must be a JSON object');
    }
    await this.client.setAccountData(type, content);
    return this.getAccountDataEvent(type);
  }

  getAvatarMxc(userId, room = null) {
    if (!this.client || !userId) return null;
    try {
      const fromUser = this.client.getUser?.(userId)?.avatarUrl || null;
      if (fromUser) return fromUser;
    } catch {
      // ignore
    }
    if (room) {
      try {
        const member = room.getMember?.(userId);
        const fromMember =
          (typeof member?.getMxcAvatarUrl === 'function' && member.getMxcAvatarUrl()) ||
          member?.events?.member?.getContent?.()?.avatar_url ||
          null;
        if (fromMember) return fromMember;
      } catch {
        // ignore
      }
    }
    return null;
  }

  mxcToHttpAvatar(mxc, size = 96) {
    if (!this.client || !mxc) return null;
    try {
      return (
        this.client.mxcUrlToHttp(mxc, size, size, 'crop', false, true, true) || null
      );
    } catch {
      return null;
    }
  }

  getProfileAvatarRemoteUrl(userId, size = 96) {
    if (!this.client || !userId) return null;
    return this.mxcToHttpAvatar(this.getAvatarMxc(userId), size);
  }

  getProfileAvatarFullRemoteUrl(userId) {
    if (!this.client || !userId) return null;
    const mxc = this.getAvatarMxc(userId);
    if (!mxc) return null;
    try {
      return (
        this.client.mxcUrlToHttp(mxc, undefined, undefined, undefined, false, true, true) || null
      );
    } catch {
      return null;
    }
  }

  /**
   * Paarrot colors live in avatar metadata (PNG tEXt; JPEG/WebP/GIF XMP color).
   */
  async fetchAvatarPaarrotColors(userId) {
    if (!this.client || !userId) return null;
    const avatarKey = this.getAvatarMxc(userId) || '';
    const cached = this.avatarMetaCache.get(userId);
    if (cached && cached.avatarKey === avatarKey && Date.now() - cached.ts < 5 * 60 * 1000) {
      return cached.meta;
    }

    let buffer = null;
    try {
      const fullUrl = this.getProfileAvatarFullRemoteUrl(userId);
      if (fullUrl) {
        const token = this.client.getAccessToken();
        const response = await fetch(fullUrl, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          redirect: 'follow',
        });
        if (response.ok) buffer = Buffer.from(await response.arrayBuffer());
      }
    } catch {
      // fall through
    }

    if (!buffer) {
      try {
        const thumb = await this.fetchProfileAvatarBuffer(userId, 256);
        buffer = thumb?.buffer || null;
      } catch {
        buffer = null;
      }
    }

    const meta = buffer ? extractMetadataFromImage(buffer) : {};
    const has =
      Boolean(meta.color) ||
      Boolean(meta.avatarBorderColor) ||
      Boolean(meta.gradient) ||
      Boolean(meta.banner);
    const result = has ? meta : null;
    if (this.avatarMetaCache.size > 250) {
      const drop = this.avatarMetaCache.keys().next().value;
      if (drop !== undefined) this.avatarMetaCache.delete(drop);
    }
    this.avatarMetaCache.set(userId, { meta: result, ts: Date.now(), avatarKey });
    return result;
  }

  getEmbedFilters(roomId) {
    if (!this.client) throw new Error('Not logged in');
    const room = this.client.getRoom(roomId);
    if (!room) throw new Error('Room not found');
    const personal = getPersonalEmbedFilters(room);
    const roomWide = getRoomWideEmbedFilters(room);
    return {
      personal,
      roomWide,
      combined: getCombinedEmbedPatterns(room),
    };
  }

  async setPersonalEmbedFilters(roomId, disabledPatterns) {
    if (!this.client) throw new Error('Not logged in');
    const content = normalizePatterns({ disabledPatterns });
    await this.client.setRoomAccountData(roomId, PaarrotAccountData.EmbedFilters, content);
    return content;
  }

  async setRoomWideEmbedFilters(roomId, disabledPatterns) {
    if (!this.client) throw new Error('Not logged in');
    const content = normalizePatterns({ disabledPatterns });
    await this.client.sendStateEvent(roomId, PaarrotStateEvent.RoomEmbedFilters, content, '');
    return content;
  }

  shouldDisableEmbed(roomId, url) {
    if (!this.client || !roomId || !url) return false;
    const room = this.client.getRoom(roomId);
    if (!room) return false;
    return isUrlEmbedDisabled(url, getCombinedEmbedPatterns(room));
  }

  getFavEmojis() {
    if (!this.client) throw new Error('Not logged in');
    const event = this.client.getAccountData?.(PaarrotAccountData.FavEmojis);
    const content = event?.getContent?.() || {};
    return content && typeof content === 'object' ? content : {};
  }

  async setFavEmojis(usage) {
    if (!this.client) throw new Error('Not logged in');
    const content =
      usage && typeof usage === 'object' && !Array.isArray(usage) ? usage : {};
    await this.client.setAccountData(PaarrotAccountData.FavEmojis, content);
    return content;
  }

  getRoomEmotes(roomId) {
    if (!this.client) throw new Error('Not logged in');
    const room = this.client.getRoom(roomId);
    if (!room) throw new Error('Room not found');
    const events = room.currentState?.getStateEvents?.(PaarrotStateEvent.RoomEmotes) || [];
    const packs = [];
    for (const event of Array.isArray(events) ? events : [events].filter(Boolean)) {
      const content = event?.getContent?.() || {};
      packs.push({
        stateKey: event.getStateKey?.() || '',
        pack: content.pack || null,
        images: content.images || {},
      });
    }
    return { packs };
  }

  getLocalProfileAvatarPath(userId, size = 96) {
    if (!userId) return null;
    return `/api/profile-avatar?userId=${encodeURIComponent(userId)}&size=${size}`;
  }

  getMemberPowerLevel(room, userId) {
    if (!room || !userId) return 0;
    try {
      const member = room.getMember?.(userId);
      if (typeof member?.powerLevel === 'number') return member.powerLevel;
    } catch {
      // ignore
    }
    try {
      const event = room.currentState?.getStateEvents?.('m.room.power_levels', '');
      const content = event?.getContent?.() || {};
      if (typeof content.users?.[userId] === 'number') return content.users[userId];
      if (typeof content.users_default === 'number') return content.users_default;
    } catch {
      // ignore
    }
    return 0;
  }

  roleFromPowerLevel(level) {
    if (level >= 100) return 'Admin';
    if (level >= 50) return 'Moderator';
    return null;
  }

  findDirectRoomId(userId) {
    if (!this.client || !userId) return null;
    try {
      const event = this.client.getAccountData?.('m.direct');
      const content = event?.getContent?.() || {};
      const rooms = content[userId];
      if (Array.isArray(rooms)) {
        for (const roomId of rooms) {
          const room = this.client.getRoom(roomId);
          if (room && this.isJoinedRoom(room) && !this.isSpaceRoom(room)) {
            return roomId;
          }
        }
      }
    } catch {
      // ignore
    }

    const myId = this.client.getUserId();
    for (const room of this.client.getRooms() || []) {
      if (!this.isJoinedRoom(room) || this.isSpaceRoom(room)) continue;
      try {
        const members = room.getJoinedMembers?.() || [];
        const ids = members.map((m) => m.userId).filter(Boolean);
        if (ids.length === 2 && ids.includes(myId) && ids.includes(userId)) {
          return room.roomId;
        }
      } catch {
        // ignore
      }
    }
    return null;
  }

  async getUserProfile(userId, { roomId = null } = {}) {
    if (!this.client) throw new Error('Not logged in');
    const id = String(userId || '').trim();
    if (!id.startsWith('@') || !id.includes(':')) {
      throw new Error('Invalid Matrix user ID');
    }

    let displayName = this.getMemberDisplayName(
      roomId ? this.client.getRoom(roomId) : null,
      id,
    );
    let avatarMxc = null;
    let bannerMxc = null;
    let profileRaw = null;
    try {
      profileRaw = await this.client.getProfileInfo(id);
      if (profileRaw?.displayname) displayName = profileRaw.displayname;
      if (profileRaw?.avatar_url) avatarMxc = profileRaw.avatar_url;
      bannerMxc = this.bannerMxcFromProfile(profileRaw);
    } catch {
      // fall back to local store
    }

    try {
      if (typeof this.client.getExtendedProfileProperty === 'function') {
        const supported = await this.client.doesServerSupportExtendedProfiles?.();
        if (supported) {
          for (const key of [
            'app.relay.profile_style',
            PaarrotProfile.Colors,
            PaarrotProfile.ColorPreference,
            PaarrotProfile.ColorPreferenceUnstable,
            PaarrotProfile.BannerUrl,
          ]) {
            try {
              const value = await this.client.getExtendedProfileProperty(id, key);
              if (value != null) {
                profileRaw = { ...(profileRaw || {}), [key]: value };
              }
            } catch {
              // ignore missing extended keys
            }
          }
          if (!bannerMxc) bannerMxc = this.bannerMxcFromProfile(profileRaw);
        }
      }
    } catch {
      // ignore extended profile gaps
    }

    const user = this.client.getUser?.(id);
    if (!avatarMxc) avatarMxc = user?.avatarUrl || null;
    const presence = this.getUserPresence(id) || 'offline';
    const statusMsg = user?.presenceStatusMsg || '';
    const room = roomId ? this.client.getRoom(roomId) : null;
    const powerLevel = room ? this.getMemberPowerLevel(room, id) : 0;
    const role = this.roleFromPowerLevel(powerLevel);
    const server = id.split(':').slice(1).join(':') || '';
    const dmRoomId = this.findDirectRoomId(id);
    const isSelf = id === this.client.getUserId();

    let bannerUrl = this.httpBannerUrl(bannerMxc);

    // MSC4522 / Paarrot 4.11+: prefer Matrix profile colors; avatar tEXt is legacy fallback.
    const accountStyle = this.parseProfileStyle(profileRaw);
    const roomColorPref = room ? this.getMemberColorPreference(room, id) : null;
    let paarrotColors = null;
    try {
      paarrotColors = await this.fetchAvatarPaarrotColors(id);
    } catch {
      paarrotColors = null;
    }

    const style = this.mergeProfileStyles({
      roomColorPref,
      accountStyle,
      avatarMeta: paarrotColors,
    });
    this.cacheProfileStyle(id, style);

    if (!bannerUrl && paarrotColors?.banner?.startsWith?.('mxc://')) {
      bannerUrl = this.httpBannerUrl(paarrotColors.banner);
    }

    return {
      userId: id,
      displayName: displayName || id.slice(1).split(':')[0] || id,
      avatarUrl: this.getLocalProfileAvatarPath(id, 128),
      hasAvatar: Boolean(avatarMxc || this.getProfileAvatarRemoteUrl(id, 128)),
      bannerUrl,
      presence,
      online: presence === 'online',
      statusMsg,
      server,
      role,
      powerLevel,
      permalink: `https://matrix.to/#/${id}`,
      dmRoomId,
      isSelf,
      roomId: roomId || null,
      style,
      colorPreference: style?.colorPreference || null,
      paarrotColors,
    };
  }

  bannerMxcFromProfile(profileRaw) {
    if (!profileRaw || typeof profileRaw !== 'object') return null;
    const raw =
      profileRaw[PaarrotProfile.BannerUrl] ||
      profileRaw['chat.commet.profile_banner'] ||
      profileRaw.banner_url ||
      null;
    if (typeof raw === 'string' && raw.startsWith('mxc://')) return raw;
    if (raw && typeof raw === 'object' && typeof raw.url === 'string' && raw.url.startsWith('mxc://')) {
      return raw.url;
    }
    return null;
  }

  httpBannerUrl(bannerMxc) {
    if (!this.client || typeof bannerMxc !== 'string' || !bannerMxc.startsWith('mxc://')) {
      return null;
    }
    try {
      const remote =
        this.client.mxcUrlToHttp(bannerMxc, 1280, 480, 'scale', false, true, true) ||
        this.client.mxcUrlToHttp(bannerMxc, undefined, undefined, undefined, false, true, true) ||
        null;
      return remote ? `/api/media?url=${encodeURIComponent(remote)}` : null;
    } catch {
      return null;
    }
  }

  normalizeHexColor(value) {
    const raw = String(value || '').trim();
    if (/^#[0-9a-fA-F]{3}$/.test(raw)) {
      return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`.toLowerCase();
    }
    if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
    return null;
  }

  normalizeColorPreference(raw) {
    if (!raw) return null;
    let parsed = raw;
    if (typeof raw === 'string') {
      try {
        parsed = JSON.parse(raw);
      } catch {
        const hex = this.normalizeHexColor(raw);
        return hex ? { on_dark: hex, on_light: hex } : null;
      }
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const onDark =
      this.normalizeHexColor(parsed.on_dark) ||
      this.normalizeHexColor(parsed.onDark) ||
      this.normalizeHexColor(parsed.dark) ||
      this.normalizeHexColor(parsed.color);
    const onLight =
      this.normalizeHexColor(parsed.on_light) ||
      this.normalizeHexColor(parsed.onLight) ||
      this.normalizeHexColor(parsed.light) ||
      this.normalizeHexColor(parsed.color);
    if (!onDark && !onLight) return null;
    return {
      on_dark: onDark || onLight,
      on_light: onLight || onDark,
    };
  }

  colorPreferenceFromSources(...sources) {
    for (const source of sources) {
      const pref = this.normalizeColorPreference(source);
      if (pref) return pref;
    }
    return null;
  }

  getMemberColorPreference(room, userId) {
    if (!room || !userId) return null;
    try {
      const member = room.getMember?.(userId);
      const content = member?.events?.member?.getContent?.() || member?.event?.content || null;
      if (!content || typeof content !== 'object') return null;
      return this.colorPreferenceFromSources(
        content[PaarrotProfile.ColorPreference],
        content[PaarrotProfile.ColorPreferenceUnstable],
        content[PaarrotProfile.Colors],
      );
    } catch {
      return null;
    }
  }

  styleFromPaarrotAvatarMeta(meta) {
    if (!meta) return null;
    const dir = String(meta.gradient?.direction || '');
    const m = dir.match(/(-?\d+(?:\.\d+)?)\s*deg/i);
    const color = this.normalizeHexColor(meta.color);
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

  mergeProfileStyles({ roomColorPref = null, accountStyle = null, avatarMeta = null } = {}) {
    const avatarStyle = this.styleFromPaarrotAvatarMeta(avatarMeta);
    const base = {
      avatarBorder: accountStyle?.avatarBorder || avatarStyle?.avatarBorder || null,
      gradientStart: accountStyle?.gradientStart || avatarStyle?.gradientStart || null,
      gradientEnd: accountStyle?.gradientEnd || avatarStyle?.gradientEnd || null,
      gradientAngle:
        accountStyle?.gradientAngle ??
        avatarStyle?.gradientAngle ??
        180,
      nameplate: accountStyle?.nameplate || null,
      nameGradientStart: accountStyle?.nameGradientStart || null,
      nameGradientEnd: accountStyle?.nameGradientEnd || null,
      color: null,
      colorPreference: null,
    };

    // MSC4522 precedence: per-room → account profile → avatar-embedded legacy.
    const colorPreference =
      this.normalizeColorPreference(roomColorPref) ||
      accountStyle?.colorPreference ||
      this.normalizeColorPreference(accountStyle?.color) ||
      (accountStyle?.nameGradientStart
        ? {
            on_dark: this.normalizeHexColor(accountStyle.nameGradientStart),
            on_light: this.normalizeHexColor(
              accountStyle.nameGradientEnd || accountStyle.nameGradientStart,
            ),
          }
        : null) ||
      avatarStyle?.colorPreference ||
      null;

    if (colorPreference?.on_dark || colorPreference?.on_light) {
      base.colorPreference = {
        on_dark: colorPreference.on_dark || colorPreference.on_light,
        on_light: colorPreference.on_light || colorPreference.on_dark,
      };
      // Default solid for callers that don't pick a theme yet.
      base.color = base.colorPreference.on_dark;
      if (!base.nameGradientStart) base.nameGradientStart = base.colorPreference.on_dark;
      if (!base.nameGradientEnd) base.nameGradientEnd = base.colorPreference.on_light;
    }

    if (!base.avatarBorder && !base.gradientStart && !base.color && !base.nameplate) {
      return null;
    }
    return base;
  }

  async getAccountEmails() {
    if (!this.client) return [];
    try {
      const data = await this.client.getThreePids();
      const list = Array.isArray(data?.threepids) ? data.threepids : [];
      return list
        .filter((entry) => entry?.medium === 'email' && entry?.address)
        .map((entry) => String(entry.address));
    } catch {
      return [];
    }
  }

  async setDisplayName(displayName) {
    if (!this.client) throw new Error('Not logged in');
    const name = String(displayName || '').trim();
    if (!name) throw new Error('Display name required');
    await this.client.setDisplayName(name);
    return { ok: true, displayName: name };
  }

  normalizeProfileStyle(parsed) {
    if (!parsed || typeof parsed !== 'object') return null;
    const nameplate =
      typeof parsed.nameplate === 'string' && parsed.nameplate.trim()
        ? parsed.nameplate.trim()
        : null;
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
      this.normalizeColorPreference(parsed.colorPreference) ||
      this.normalizeColorPreference(parsed[PaarrotProfile.ColorPreference]) ||
      this.normalizeColorPreference(parsed[PaarrotProfile.ColorPreferenceUnstable]) ||
      this.normalizeColorPreference({
        on_dark: parsed.on_dark || parsed.onDark,
        on_light: parsed.on_light || parsed.onLight,
      }) ||
      this.normalizeColorPreference(parsed.color) ||
      (nameGradientStart
        ? {
            on_dark: this.normalizeHexColor(nameGradientStart),
            on_light: this.normalizeHexColor(nameGradientEnd || nameGradientStart),
          }
        : null);
    return {
      avatarBorder: typeof parsed.avatarBorder === 'string' ? parsed.avatarBorder : null,
      gradientStart: typeof parsed.gradientStart === 'string' ? parsed.gradientStart : null,
      gradientEnd: typeof parsed.gradientEnd === 'string' ? parsed.gradientEnd : null,
      gradientAngle: Number.isFinite(Number(parsed.gradientAngle))
        ? Number(parsed.gradientAngle)
        : 180,
      nameplate,
      nameGradientStart,
      nameGradientEnd,
      color: colorPreference?.on_dark || this.normalizeHexColor(parsed.color) || null,
      colorPreference,
    };
  }

  parseProfileStyle(profileRaw) {
    if (!profileRaw || typeof profileRaw !== 'object') return null;

    const colorPreference = this.colorPreferenceFromSources(
      profileRaw[PaarrotProfile.ColorPreference],
      profileRaw[PaarrotProfile.ColorPreferenceUnstable],
      profileRaw[PaarrotProfile.Colors],
    );

    const raw =
      profileRaw[PaarrotProfile.Colors] ||
      profileRaw['app.relay.profile_style'] ||
      profileRaw['im.vector.custom.relay_profile_style'] ||
      null;

    let style = null;
    if (raw) {
      try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        style = this.normalizeProfileStyle(parsed);
      } catch {
        style = null;
      }
    }

    if (!style && colorPreference) {
      style = this.normalizeProfileStyle({ colorPreference });
    } else if (style && colorPreference && !style.colorPreference) {
      style = {
        ...style,
        colorPreference,
        color: colorPreference.on_dark || style.color,
      };
    } else if (style && colorPreference) {
      // MSC4522 profile field wins over nested blob colors when both exist.
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

  cacheProfileStyle(userId, style) {
    if (!userId) return style;
    this.profileStyleCache.set(userId, style || null);
    return style;
  }

  getCachedProfileStyle(userId) {
    if (!userId) return null;
    if (this.profileStyleCache.has(userId)) return this.profileStyleCache.get(userId);
    return null;
  }

  async setProfileStyle(style) {
    if (!this.client) throw new Error('Not logged in');
    const colorPreference =
      this.normalizeColorPreference(style?.colorPreference) ||
      this.normalizeColorPreference({
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
    const userId = this.client.getUserId?.();
    const colorPrefValue = colorPreference || null;

    try {
      if (payload && typeof this.client.setExtendedProfileProperty === 'function') {
        const supported = await this.client.doesServerSupportExtendedProfiles?.();
        if (supported) {
          await this.client.setExtendedProfileProperty(PaarrotProfile.Colors, value);
          await this.client.setExtendedProfileProperty('app.relay.profile_style', value);
          if (colorPrefValue) {
            await this.client.setExtendedProfileProperty(
              PaarrotProfile.ColorPreference,
              colorPrefValue,
            );
            try {
              await this.client.setExtendedProfileProperty(
                PaarrotProfile.ColorPreferenceUnstable,
                colorPrefValue,
              );
            } catch {
              // optional unstable key
            }
          }
          this.cacheProfileStyle(userId, payload);
          return { ok: true, style: payload, via: 'extended' };
        }
      }
    } catch {
      // fall through to classic profile field
    }

    if (!payload) {
      for (const key of [
        PaarrotProfile.Colors,
        'app.relay.profile_style',
        PaarrotProfile.ColorPreference,
        PaarrotProfile.ColorPreferenceUnstable,
      ]) {
        try {
          await this.client.setProfileInfo(key, { [key]: key.includes('color') ? null : '' });
        } catch {
          // ignore delete failures
        }
      }
      this.cacheProfileStyle(userId, null);
      return { ok: true, style: null };
    }

    try {
      await this.client.setProfileInfo(PaarrotProfile.Colors, {
        [PaarrotProfile.Colors]: value,
      });
    } catch {
      // optional key — Relay style still saved below
    }
    try {
      if (colorPrefValue) {
        await this.client.setProfileInfo(PaarrotProfile.ColorPreference, {
          [PaarrotProfile.ColorPreference]: colorPrefValue,
        });
      }
    } catch {
      // optional MSC4522 key
    }
    await this.client.setProfileInfo('app.relay.profile_style', {
      'app.relay.profile_style': value,
    });
    this.cacheProfileStyle(userId, payload);
    return { ok: true, style: payload, via: 'profile' };
  }

  async setCustomStatus(statusMsg) {
    if (!this.client) throw new Error('Not logged in');
    const message = String(statusMsg || '').trim();
    const self = this.getSelfPresence();
    return this.setPresenceState(self.presence || 'online', { statusMsg: message });
  }

  presenceRequestError(error) {
    const status = error?.httpStatus ?? error?.status;
    const errcode = String(error?.errcode || '');
    const message = String(error?.message || error || '');
    if (
      status === 429 ||
      errcode === 'M_LIMIT_EXCEEDED' ||
      /\b429\b|too many requests|rate.?limit/i.test(message)
    ) {
      return new Error('Presence updates are rate-limited. Wait a moment and try again.');
    }
    return error instanceof Error ? error : new Error(message || 'Presence update failed');
  }

  getSelfPresence() {
    if (!this.client) return { presence: 'offline', statusMsg: '' };
    const userId = this.client.getUserId();
    const user = this.client.getUser?.(userId);
    const presence = this.getUserPresence(userId) || 'offline';
    return {
      presence,
      statusMsg: user?.presenceStatusMsg || '',
      online: presence === 'online',
    };
  }

  async setPresenceState(presence, { statusMsg = undefined } = {}) {
    if (!this.client) throw new Error('Not logged in');
    const allowed = new Set(['online', 'unavailable', 'offline']);
    const next = allowed.has(presence) ? presence : 'online';
    const userId = this.client.getUserId();
    const user = this.client.getUser?.(userId);
    const message =
      statusMsg !== undefined ? String(statusMsg || '').trim() : user?.presenceStatusMsg || '';
    const current = this.getSelfPresence();
    if (current.presence === next && current.statusMsg === message) {
      return {
        ok: true,
        presence: next,
        statusMsg: message,
        online: next === 'online',
        unchanged: true,
      };
    }

    if (this._presenceSetPromise) {
      try {
        await this._presenceSetPromise;
      } catch {
        // latest request still runs below
      }
      const after = this.getSelfPresence();
      if (after.presence === next && after.statusMsg === message) {
        return {
          ok: true,
          presence: next,
          statusMsg: message,
          online: next === 'online',
          unchanged: true,
        };
      }
    }

    this._presenceSetPromise = (async () => {
      try {
        await this.client.setPresence({
          presence: next,
          status_msg: message || undefined,
        });
        this._presenceSetAt = Date.now();
        return {
          ok: true,
          presence: next,
          statusMsg: message,
          online: next === 'online',
        };
      } catch (error) {
        throw this.presenceRequestError(error);
      } finally {
        this._presenceSetPromise = null;
      }
    })();

    return this._presenceSetPromise;
  }

  notificationModeFromRule(rule) {
    if (!rule || rule.enabled === false) return 'off';
    const actions = Array.isArray(rule.actions) ? rule.actions : [];
    if (!actions.length) return 'off';
    if (actions.includes('dont_notify')) return 'off';
    const notifies = actions.includes('notify') || actions.includes('coalesce');
    if (!notifies) return 'off';
    const hasSound = actions.some(
      (action) => action && typeof action === 'object' && action.set_tweak === 'sound',
    );
    return hasSound ? 'loud' : 'notify';
  }

  actionsForNotificationMode(mode) {
    if (mode === 'loud') {
      return ['notify', { set_tweak: 'sound', value: 'default' }];
    }
    if (mode === 'notify') {
      return ['notify'];
    }
    return ['dont_notify'];
  }

  findPushRule(kind, ruleId) {
    const rules = this.client?.pushRules?.global?.[kind];
    if (!Array.isArray(rules)) return null;
    return rules.find((rule) => rule.rule_id === ruleId) || null;
  }

  async ensurePushRulesLoaded() {
    if (!this.client) throw new Error('Not logged in');
    if (!this.client.pushRules) {
      const rules = await this.client.getPushRules();
      this.client.setPushRules(rules);
    }
    return this.client.pushRules;
  }

  async getNotificationSettings() {
    await this.ensurePushRulesLoaded();
    const userId = this.client.getUserId() || '';
    const local = userId.startsWith('@') ? userId.slice(1).split(':')[0] : '';
    let displayName = local;
    try {
      const profile = await this.client.getProfileInfo(userId);
      if (profile?.displayname) displayName = profile.displayname;
    } catch {
      // ignore
    }

    const underride = [
      {
        id: 'dm',
        label: '1-to-1 Chats',
        kind: 'underride',
        ruleId: '.m.rule.room_one_to_one',
      },
      {
        id: 'dm-encrypted',
        label: '1-to-1 Chats (Encrypted)',
        kind: 'underride',
        ruleId: '.m.rule.encrypted_room_one_to_one',
      },
      {
        id: 'room',
        label: 'Rooms',
        kind: 'underride',
        ruleId: '.m.rule.message',
      },
      {
        id: 'room-encrypted',
        label: 'Rooms (Encrypted)',
        kind: 'underride',
        ruleId: '.m.rule.encrypted',
      },
    ].map((entry) => {
      const rule = this.findPushRule(entry.kind, entry.ruleId);
      return {
        ...entry,
        mode: this.notificationModeFromRule(rule),
        enabled: Boolean(rule?.enabled),
      };
    });

    const special = [
      {
        id: 'user-mention',
        label: `Mention User ID (“${userId}”)`,
        kind: 'override',
        ruleId: '.m.rule.is_user_mention',
        fallbackKind: 'content',
        fallbackRuleId: '.m.rule.contains_user_name',
      },
      {
        id: 'displayname',
        label: `Contains Displayname (“${displayName}”)`,
        kind: 'override',
        ruleId: '.m.rule.contains_display_name',
      },
      {
        id: 'username',
        label: `Contains Username (“${local}”)`,
        kind: 'content',
        ruleId: '.m.rule.contains_user_name',
      },
      {
        id: 'room-mention',
        label: 'Mention @room',
        kind: 'override',
        ruleId: '.m.rule.is_room_mention',
        fallbackKind: 'override',
        fallbackRuleId: '.m.rule.roomnotif',
      },
      {
        id: 'contains-room',
        label: 'Contains @room',
        kind: 'override',
        ruleId: '.m.rule.roomnotif',
      },
    ].map((entry) => {
      let rule = this.findPushRule(entry.kind, entry.ruleId);
      let kind = entry.kind;
      let ruleId = entry.ruleId;
      if (!rule && entry.fallbackRuleId) {
        rule = this.findPushRule(entry.fallbackKind, entry.fallbackRuleId);
        if (rule) {
          kind = entry.fallbackKind;
          ruleId = entry.fallbackRuleId;
        }
      }
      return {
        id: entry.id,
        label: entry.label,
        kind,
        ruleId,
        mode: this.notificationModeFromRule(rule),
        enabled: Boolean(rule?.enabled),
      };
    });

    const contentRules = this.client.pushRules?.global?.content || [];
    const keywords = contentRules
      .filter((rule) => !rule.default && rule.pattern)
      .map((rule) => ({
        id: rule.rule_id,
        pattern: rule.pattern,
        kind: 'content',
        ruleId: rule.rule_id,
        mode: this.notificationModeFromRule(rule),
        enabled: Boolean(rule.enabled),
      }));

    const emails = await this.getAccountEmails();

    return {
      userId,
      displayName,
      username: local,
      emails,
      email: emails[0] || null,
      underride,
      special,
      keywords,
    };
  }

  async setNotificationRuleMode(kind, ruleId, mode) {
    if (!this.client) throw new Error('Not logged in');
    const nextMode = ['off', 'notify', 'loud'].includes(mode) ? mode : 'notify';
    const ruleKind = String(kind || '').trim();
    const id = String(ruleId || '').trim();
    if (!ruleKind || !id) throw new Error('Rule required');

    await this.ensurePushRulesLoaded();
    const actions = this.actionsForNotificationMode(nextMode);
    if (nextMode === 'off') {
      await this.client.setPushRuleActions('global', ruleKind, id, actions);
      await this.client.setPushRuleEnabled('global', ruleKind, id, false);
    } else {
      await this.client.setPushRuleEnabled('global', ruleKind, id, true);
      await this.client.setPushRuleActions('global', ruleKind, id, actions);
    }
    const rules = await this.client.getPushRules();
    this.client.setPushRules(rules);
    return this.getNotificationSettings();
  }

  async addNotificationKeyword(keyword, mode = 'loud') {
    if (!this.client) throw new Error('Not logged in');
    const pattern = String(keyword || '').trim();
    if (!pattern) throw new Error('Keyword required');
    if (pattern.startsWith('.')) throw new Error('Invalid keyword');

    await this.ensurePushRulesLoaded();
    const existing = (this.client.pushRules?.global?.content || []).find(
      (rule) => !rule.default && String(rule.pattern || '').toLowerCase() === pattern.toLowerCase(),
    );
    if (existing) {
      return this.setNotificationRuleMode('content', existing.rule_id, mode);
    }

    const ruleId = pattern;
    await this.client.addPushRule('global', 'content', ruleId, {
      actions: this.actionsForNotificationMode(mode === 'off' ? 'notify' : mode),
      pattern,
    });
    if (mode === 'off') {
      await this.client.setPushRuleEnabled('global', 'content', ruleId, false);
    }
    const rules = await this.client.getPushRules();
    this.client.setPushRules(rules);
    return this.getNotificationSettings();
  }

  async removeNotificationKeyword(ruleId) {
    if (!this.client) throw new Error('Not logged in');
    const id = String(ruleId || '').trim();
    if (!id) throw new Error('Keyword required');
    await this.client.deletePushRule('global', 'content', id);
    const rules = await this.client.getPushRules();
    this.client.setPushRules(rules);
    return this.getNotificationSettings();
  }

  async uploadProfileImage(dataUrl, { asBanner = false } = {}) {
    if (!this.client) throw new Error('Not logged in');
    const match = /^data:([^;]+);base64,(.+)$/s.exec(String(dataUrl || ''));
    if (!match) throw new Error('Invalid image data');
    const buffer = Buffer.from(match[2], 'base64');
    const contentType = this.normalizeImageContentType(match[1] || 'image/png', '', buffer);
    const ext =
      contentType === 'image/jpeg'
        ? 'jpg'
        : contentType === 'image/gif'
          ? 'gif'
          : contentType === 'image/webp'
            ? 'webp'
            : contentType === 'image/apng'
              ? 'apng'
              : contentType === 'image/avif'
                ? 'avif'
                : 'png';
    const upload = await this.client.uploadContent(buffer, {
      type: contentType === 'image/apng' ? 'image/png' : contentType,
      name: asBanner ? `banner.${ext}` : `avatar.${ext}`,
      rawResponse: false,
    });
    const mxc = typeof upload === 'string' ? upload : upload?.content_uri;
    if (!mxc) throw new Error('Upload failed');

    if (asBanner) {
      await this.client.setProfileInfo('m.banner_url', { 'm.banner_url': mxc });
      return { ok: true, mxc, kind: 'banner' };
    }
    await this.client.setAvatarUrl(mxc);
    return { ok: true, mxc, kind: 'avatar' };
  }

  getIgnoredUsers() {
    if (!this.client) return [];
    try {
      return this.client.getIgnoredUsers?.() || [];
    } catch {
      return [];
    }
  }

  async blockUser(userId) {
    if (!this.client) throw new Error('Not logged in');
    const id = String(userId || '').trim();
    if (!id.startsWith('@') || !id.includes(':')) {
      throw new Error('Block needs a full Matrix ID like @user:server');
    }
    const current = new Set(this.getIgnoredUsers());
    current.add(id);
    await this.client.setIgnoredUsers([...current]);
    return { ok: true, ignored: [...current] };
  }

  async unblockUser(userId) {
    if (!this.client) throw new Error('Not logged in');
    const id = String(userId || '').trim();
    const current = this.getIgnoredUsers().filter((entry) => entry !== id);
    await this.client.setIgnoredUsers(current);
    return { ok: true, ignored: current };
  }

  async ensureDirectRoom(userId, { encrypted = true } = {}) {
    if (!this.client) throw new Error('Not logged in');
    const id = String(userId || '').trim();
    if (!id.startsWith('@') || !id.includes(':')) {
      throw new Error('Invalid Matrix user ID');
    }
    if (id === this.client.getUserId()) {
      throw new Error('Cannot open a DM with yourself');
    }

    const existing = this.findDirectRoomId(id);
    if (existing) return { roomId: existing, created: false };

    const initial_state = [
      {
        type: 'm.room.guest_access',
        state_key: '',
        content: { guest_access: 'can_join' },
      },
    ];
    if (encrypted !== false) {
      initial_state.push({
        type: 'm.room.encryption',
        state_key: '',
        content: { algorithm: 'm.megolm.v1.aes-sha2' },
      });
    }

    const result = await this.client.createRoom({
      is_direct: true,
      preset: 'trusted_private_chat',
      invite: [id],
      initial_state,
    });
    const roomId = result?.room_id || result?.roomId;
    if (!roomId) throw new Error('Failed to create DM');

    try {
      const event = this.client.getAccountData?.('m.direct');
      const content = { ...(event?.getContent?.() || {}) };
      const list = Array.isArray(content[id]) ? [...content[id]] : [];
      if (!list.includes(roomId)) list.unshift(roomId);
      content[id] = list;
      await this.client.setAccountData('m.direct', content);
    } catch {
      // DM still works without m.direct update
    }

    return { roomId, created: true, encrypted: encrypted !== false };
  }

  async fetchProfileAvatarBuffer(userId, size = 96) {
    if (!this.client) throw new Error('Not logged in');
    const remoteUrl = this.getProfileAvatarRemoteUrl(userId, size);
    if (!remoteUrl) return null;

    const token = this.client.getAccessToken();
    const response = await fetch(remoteUrl, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      redirect: 'follow',
    });
    if (!response.ok) throw new Error(`Avatar fetch failed (${response.status})`);
    const contentType = response.headers.get('content-type') || 'image/png';
    const buffer = Buffer.from(await response.arrayBuffer());
    return { contentType, buffer };
  }

  normalizeHomeserver(input) {
    let url = String(input || '').trim();
    if (!url) throw new Error('Homeserver URL is required');
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    return url.replace(/\/+$/, '');
  }

  /**
   * Resolve a user-entered server name / URL to a Matrix client API base URL.
   * Supports bare domains via .well-known (e.g. example.com → matrix.example.com).
   */
  async resolveHomeserverBaseUrl(input, sdk) {
    const raw = String(input || '').trim();
    if (!raw) throw new Error('Homeserver URL is required');

    // Full URL with path — use as-is (advanced / direct Synapse URL).
    if (/^https?:\/\//i.test(raw) && /\/_matrix(\/|$)/i.test(raw)) {
      return raw.replace(/\/+$/, '');
    }

    let serverName = raw;
    if (/^https?:\/\//i.test(serverName)) {
      try {
        serverName = new URL(serverName).host;
      } catch {
        serverName = serverName.replace(/^https?:\/\//i, '').split('/')[0];
      }
    }
    serverName = serverName.replace(/\/+$/, '');

    try {
      const discovery = await sdk.AutoDiscovery.findClientConfig(serverName);
      const hs = discovery?.['m.homeserver'];
      if (hs?.state === sdk.AutoDiscovery.SUCCESS && hs.base_url) {
        return String(hs.base_url).replace(/\/+$/, '');
      }
    } catch (error) {
      console.warn('[MatrixSession] well-known discovery failed:', error?.message || error);
    }

    // Fallback: treat input as a direct base URL.
    return this.normalizeHomeserver(raw);
  }

  wireClientEvents(client, sdk) {
    const isChatTimelineType = (type) => {
      if (!type || typeof type !== 'string') return false;
      return (
        type === 'm.room.message' ||
        type === 'm.room.encrypted' ||
        type === 'm.room.redaction' ||
        type === 'm.reaction' ||
        type === 'app.relay.emoji_confetti'
      );
    };

    client.on(sdk.ClientEvent.Sync, (state) => {
      const becameReady =
        !this.ready && (state === 'PREPARED' || state === 'SYNCING');
      if (state === 'PREPARED' || state === 'SYNCING') {
        this.ready = true;
        this.lastError = null;
      }
      this.pluginHost?.emit('sync-state', { state, userId: client.getUserId() });
      // Tell the UI first sync finished so it can reload timelines painted early/empty.
      if (becameReady) {
        this.publishLive({ kind: 'sync', state, live: true });
      }
    });

    const onSessionLoggedOut = (err) => {
      const message = err?.message || err?.errcode || 'Session logged out';
      const errcode = err?.errcode || '';
      console.warn('[MatrixSession] SessionLoggedOut:', errcode || message);
      // Ignore soft/transient auth noise; only drop the saved session on real token death.
      const fatal =
        errcode === 'M_UNKNOWN_TOKEN' ||
        errcode === 'M_MISSING_TOKEN' ||
        /M_UNKNOWN_TOKEN|M_MISSING_TOKEN/i.test(String(message));
      this.lastError = String(message);
      try {
        client.stopClient();
      } catch {
        // ignore
      }
      if (this.client === client) this.client = null;
      this.ready = false;
      if (fatal) this.clearStoredSession();
      this.publishLive({ kind: 'session', connected: false, live: true });
      this.pluginHost?.emit('session-end', { reason: 'logged_out', fatal });
    };
    client.on(sdk.HttpApiEvent.SessionLoggedOut, onSessionLoggedOut);

    client.on(sdk.RoomEvent.Timeline, (event, room, toStartOfTimeline, _removed, data) => {
      if (toStartOfTimeline || !room) return;
      const type = event.getType();
      this.pluginHost?.emit('room-timeline', {
        roomId: room.roomId,
        eventId: event.getId(),
        type,
        sender: event.getSender(),
      });

      if (typeof type === 'string' && type.startsWith('m.call.')) {
        this.voipHub?.publish({
          roomId: room.roomId,
          eventId: event.getId(),
          type,
          sender: event.getSender(),
          content: event.getContent() || {},
          ts: event.getTs(),
        });
      }

      // Only live events after initial sync — avoid notifying for backfill.
      if (data && data.liveEvent === false) return;
      if (!this.ready) return;

      if (isChatTimelineType(type)) {
        const payload = {
          kind: 'timeline',
          roomId: room.roomId,
          eventId: event.getId(),
          type,
          sender: event.getSender(),
          live: true,
        };
        if (type === 'app.relay.emoji_confetti') {
          const content = event.getContent?.() || {};
          payload.kind = 'emoji-confetti';
          payload.emojis = Array.isArray(content.emojis)
            ? content.emojis.map((entry) => String(entry || '')).filter(Boolean).slice(0, 12)
            : [];
          payload.targetEventId =
            typeof content.target_event_id === 'string' ? content.target_event_id : null;
        }
        this.publishLive(payload);
      }

      this.captureActivityFromEvent(event, room);
    });

    client.on(sdk.MatrixEventEvent.Decrypted, (event) => {
      try {
        if (!this.ready) return;
        const roomId = event.getRoomId?.();
        if (!roomId) return;
        const type = event.getType();
        this.pluginHost?.emit('room-timeline', {
          roomId,
          eventId: event.getId(),
          type,
          sender: event.getSender(),
          decrypted: true,
        });
        if (!isChatTimelineType(type)) return;
        this.publishLive({
          kind: 'timeline',
          roomId,
          eventId: event.getId(),
          type,
          sender: event.getSender(),
          decrypted: true,
          live: true,
        });
      } catch {
        // ignore
      }
    });

    if (sdk.RoomEvent?.Receipt) {
      client.on(sdk.RoomEvent.Receipt, (_event, room) => {
        if (!this.ready || !room?.roomId) return;
        this.publishLive({
          kind: 'receipt',
          roomId: room.roomId,
          live: true,
        });
      });
    }

    if (sdk.RoomMemberEvent?.Typing) {
      client.on(sdk.RoomMemberEvent.Typing, (_event, member) => {
        if (!this.ready || !member?.roomId) return;
        this.publishLive({
          kind: 'typing',
          roomId: member.roomId,
          userId: member.userId || null,
          typing: Boolean(member.typing),
          live: true,
        });
      });
    }

    if (sdk.UserEvent?.Presence) {
      client.on(sdk.UserEvent.Presence, (_event, user) => {
        if (!this.ready || !user?.userId) return;
        const presence = user.presence || 'offline';
        this.publishLive({
          kind: 'presence',
          userId: user.userId,
          presence,
          online: presence === 'online',
          live: true,
        });
      });
    }
  }

  publishLive(payload) {
    try {
      this.liveHub?.publish(payload);
    } catch {
      // ignore fan-out failures
    }
  }

  pushActivity(entry) {
    this.activityCursor += 1;
    this.activity.push({
      id: this.activityCursor,
      ...entry,
    });
    if (this.activity.length > 400) {
      this.activity.splice(0, this.activity.length - 400);
    }
  }

  listActivitySince(sinceId = 0) {
    const since = Number(sinceId) || 0;
    return {
      cursor: this.activityCursor,
      items: this.activity.filter((entry) => entry.id > since),
    };
  }

  eventIsHighlight(event, room) {
    if (!event || !room || !this.client) return false;
    try {
      const actions = room.getPushActionsForEvent?.(event);
      if (actions?.tweaks?.highlight) return true;
    } catch {
      // ignore
    }
    const myId = this.client.getUserId();
    if (!myId) return false;
    const body = String(event.getContent?.()?.body || '');
    if (!body) return false;
    if (body.includes(myId)) return true;
    const local = myId.startsWith('@') ? myId.slice(1).split(':')[0] : myId;
    if (local && body.toLowerCase().includes(`@${local.toLowerCase()}`)) return true;
    return false;
  }

  serializeNotificationFromEvent(event, room) {
    if (!event || !room || !this.client) return null;
    const myId = this.client.getUserId();
    const type = event.getType();
    const sender = event.getSender();
    if (!sender || sender === myId) return null;
    const content = event.getContent() || {};

    let kind = 'message';
    let body = '';
    let msgtype = content.msgtype || null;

    if (type === 'm.room.member' && content.membership === 'invite' && event.getStateKey?.() === myId) {
      kind = 'invite';
      body = 'Invited you to join';
      msgtype = null;
    } else if (type === 'm.room.encrypted') {
      body = 'Encrypted message';
    } else if (type === 'm.room.message') {
      if (content.msgtype === 'm.image') body = content.body || 'sent an image';
      else if (content.msgtype === 'm.file' || content.msgtype === 'm.video' || content.msgtype === 'm.audio') {
        body = content.body || content.filename || content.msgtype;
      } else if (content.msgtype === 'm.emote') body = content.body || '';
      else body = typeof content.body === 'string' ? content.body : '';
    } else {
      return null;
    }

    const relates = content['m.relates_to'] || {};
    const inReply = relates['m.in_reply_to'] || null;
    let replyToName = null;
    if (inReply?.event_id && typeof room.findEventById === 'function') {
      try {
        const parent = room.findEventById(inReply.event_id);
        if (parent) replyToName = this.getMemberDisplayName(room, parent.getSender());
      } catch {
        // ignore
      }
    }

    // Strip mx reply fallback prefix for display.
    let displayBody = body;
    if (typeof displayBody === 'string' && displayBody.includes('\n')) {
      const stripped = displayBody.replace(/^>.*\n\n?/gm, '').replace(/^>.*$/gm, '').trim();
      if (stripped) displayBody = stripped;
    }

    const isDirect = this.getDirectRoomIdSet().has(room.roomId);
    return {
      kind,
      roomId: room.roomId,
      roomName: room.name || room.roomId,
      eventId: event.getId(),
      sender,
      senderName: this.getMemberDisplayName(room, sender),
      senderAvatarUrl: this.getLocalProfileAvatarPath(sender, 96),
      body: displayBody,
      msgtype,
      ts: event.getTs(),
      isDirect,
      highlight: kind === 'invite' ? true : this.eventIsHighlight(event, room),
      replyToName,
    };
  }

  captureActivityFromEvent(event, room) {
    if (!this.client || !event || !room) return;
    if (this.isSpaceRoom(room)) return;

    const myId = this.client.getUserId();
    const type = event.getType();
    const sender = event.getSender();
    const content = event.getContent() || {};

    if (type === 'm.room.member' && content.membership === 'invite' && event.getStateKey?.() === myId) {
      const item = this.serializeNotificationFromEvent(event, room);
      if (item) this.pushActivity(item);
      return;
    }

    if (type !== 'm.room.message' && type !== 'm.room.encrypted') return;
    const item = this.serializeNotificationFromEvent(event, room);
    if (item) this.pushActivity(item);
  }

  /**
   * Fetch TURN credentials from the homeserver (GET /_matrix/client/v3/voip/turnServer).
   * Many Synapse installs return {} when turn_* is unset — callers should fall back to Relay TURN.
   */
  async fetchHomeserverTurn() {
    if (!this.client || typeof this.client.turnServer !== 'function') return null;
    try {
      const res = await this.client.turnServer();
      if (!res?.uris?.length) return null;
      return {
        urls: res.uris,
        username: res.username || undefined,
        credential: res.password || undefined,
        ttl: res.ttl || null,
        source: 'homeserver',
      };
    } catch (error) {
      console.warn('[MatrixSession] turnServer failed:', error?.message || error);
      return null;
    }
  }

  async sendCallEvent(roomId, type, content) {
    if (!this.client) throw new Error('Not logged in');
    const eventType = String(type || '');
    if (!eventType.startsWith('m.call.')) {
      throw new Error('Invalid call event type');
    }
    const room = this.client.getRoom(roomId);
    if (!room) throw new Error('Room not found');
    const result = await this.client.sendEvent(roomId, eventType, content || {});
    return { eventId: result?.event_id || null };
  }

  getActiveCallMembers(roomId) {
    if (!this.client) throw new Error('Not logged in');
    const room = this.client.getRoom(roomId);
    if (!room) return [];
    return livekitRtc.getActiveCallMembersFromRoom(room);
  }

  getVoiceParticipantsForRoom(room) {
    if (!room) return [];
    const active = livekitRtc.getActiveCallMembersFromRoom(room);
    const byUser = new Map();
    for (const entry of active) {
      const userId = entry?.userId;
      if (!userId || byUser.has(userId)) continue;
      const member = room.getMember?.(userId);
      const avatarMxc =
        (typeof member?.getMxcAvatarUrl === 'function' && member.getMxcAvatarUrl()) ||
        this.getAvatarMxc(userId, room) ||
        null;
      byUser.set(userId, {
        userId,
        displayName: this.getMemberDisplayName(room, userId),
        avatarUrl: this.getLocalProfileAvatarPath(userId, 96),
        hasAvatar: Boolean(avatarMxc),
      });
    }
    return [...byUser.values()].sort((a, b) =>
      String(a.displayName).localeCompare(String(b.displayName), undefined, {
        sensitivity: 'base',
      }),
    );
  }

  async getLiveKitStatus(roomId) {
    if (!this.client) throw new Error('Not logged in');
    const room = this.client.getRoom(roomId);
    if (!room) throw new Error('Room not found');
    const userHomeserver = this.client.getHomeserverUrl();
    const myUserId = this.client.getUserId();
    const servers = livekitRtc.homeserverPriority({
      room,
      userHomeserver,
      myUserId,
    });
    const members = livekitRtc.getActiveCallMembersFromRoom(room);
    let supported = false;
    const foci = [];
    for (const server of servers) {
      try {
        const wellKnown = await livekitRtc.fetchWellKnown(server);
        const focus = livekitRtc.getLiveKitFocus(wellKnown);
        if (focus) {
          supported = true;
          foci.push({ homeserver: server, livekitServiceUrl: focus.livekit_service_url });
        }
      } catch {
        // try next
      }
    }
    return {
      supported,
      members,
      foci,
      servers,
      backend: supported ? 'livekit' : 'webrtc',
    };
  }

  async joinLiveKit(roomId) {
    if (!this.client) throw new Error('Not logged in');
    const room = this.client.getRoom(roomId);
    if (!room) throw new Error('Room not found');
    const userHomeserver = this.client.getHomeserverUrl();
    const userId = this.client.getUserId();
    const deviceId = this.client.getDeviceId();
    const accessToken = this.client.getAccessToken();
    if (!userId || !deviceId || !accessToken) throw new Error('Missing Matrix credentials');

    const homeservers = livekitRtc.homeserverPriority({
      room,
      userHomeserver,
      myUserId: userId,
    });
    const result = await livekitRtc.fetchLiveKitJWTFromServers({
      homeservers,
      userHomeserver,
      roomId,
      userId,
      deviceId,
      accessToken,
    });
    if (!result?.jwt) {
      throw new Error(
        `LiveKit unavailable (${(result?.errors || []).slice(0, 3).join('; ') || 'no foci'})`,
      );
    }
    return {
      jwt: result.jwt.jwt,
      url: result.jwt.url,
      homeserver: result.homeserver,
      livekitServiceUrl: result.livekitServiceUrl,
      userId,
      deviceId,
      members: livekitRtc.getActiveCallMembersFromRoom(room),
    };
  }

  async setCallMembership(roomId, { active = true, callId = null, livekitServiceUrl = null } = {}) {
    if (!this.client) throw new Error('Not logged in');
    const room = this.client.getRoom(roomId);
    if (!room) throw new Error('Room not found');
    const userId = this.client.getUserId();
    const deviceId = this.client.getDeviceId();
    if (!userId || !deviceId) throw new Error('Missing Matrix credentials');
    // Room-scoped MatrixRTC uses empty call_id (Element Call / Paarrot).
    const id = active ? String(callId || '') : '';
    const roomVersion = room.getVersion?.() || null;
    const stateKey = livekitRtc.makeMembershipStateKey(userId, deviceId, roomVersion);
    const content = livekitRtc.buildCallMemberContent({
      callId: id,
      deviceId,
      active: Boolean(active),
      livekitServiceUrl,
    });
    try {
      await this.client.sendStateEvent(roomId, livekitRtc.CALL_MEMBER_EVENT, content, stateKey);
      // Clear legacy userId-keyed memberships so old events don't linger.
      if (!active) {
        try {
          await this.client.sendStateEvent(roomId, livekitRtc.CALL_MEMBER_EVENT, {}, userId);
        } catch {
          // ignore
        }
      }
    } catch (error) {
      // Soft-fail for rooms where power levels block call member state.
      console.warn('[MatrixSession] call member state failed:', error?.message || error);
      return { ok: false, callId: id, error: error?.message || String(error) };
    }
    return { ok: true, callId: id };
  }

  async login({ homeserver, user, password, deviceName }) {
    await this.logout({ clearStorage: false });

    const sdk = await loadSdk();
    const baseUrl = await this.resolveHomeserverBaseUrl(homeserver, sdk);
    const bootstrap = sdk.createClient({ baseUrl });

    const userId = String(user || '').trim();
    const loginBody = {
      user: userId,
      password: String(password || ''),
      initial_device_display_name: deviceName || 'Kitsu Desktop',
    };

    if (!loginBody.user || !loginBody.password) {
      throw new Error('Username and password are required');
    }

    let response;
    try {
      response = await bootstrap.login('m.login.password', loginBody);
    } catch (error) {
      const message = error?.message || String(error);
      if (/Unexpected token|<!DOCTYPE|is not valid JSON/i.test(message)) {
        throw new Error(
          `Homeserver at ${baseUrl} did not return a Matrix API response. Try your server name (e.g. matrix.org) or the client API URL.`,
        );
      }
      throw error;
    }

    const session = {
      baseUrl,
      accessToken: response.access_token,
      userId: response.user_id,
      deviceId: response.device_id,
    };

    this.writeStoredSession(session);
    await this.startFromSession(session);
    return this.getPublicState();
  }

  async startFromSession(session) {
    if (!session?.accessToken || !session?.userId || !session?.baseUrl) {
      throw new Error('Invalid session');
    }

    await ensureCryptoIndexedDb(this.dataDir);
    await this.loadCachedSecretStorageKey();

    const sdk = await loadSdk();
    const self = this;
    const client = sdk.createClient({
      baseUrl: session.baseUrl,
      accessToken: session.accessToken,
      userId: session.userId,
      deviceId: session.deviceId,
      cryptoCallbacks: {
        getSecretStorageKey: async ({ keys }) => {
          if (!self.secretStoragePrivateKey) return null;
          const keyIds = Object.keys(keys || {});
          if (!keyIds.length) return null;
          return [keyIds[0], self.secretStoragePrivateKey];
        },
        cacheSecretStorageKey: (_keyId, _keyInfo, key) => {
          if (key) self.secretStoragePrivateKey = key;
        },
      },
    });

    this.wireClientEvents(client, sdk);
    this.client = client;
    this.ready = false;
    this.lastError = null;
    this.cryptoReady = false;
    this.cryptoError = null;

    const prefix = cryptoDatabasePrefix(session.userId, session.deviceId);
    const initCrypto = async () => {
      await client.initRustCrypto({
        useIndexedDB: true,
        cryptoDatabasePrefix: prefix,
      });
      this.cryptoReady = true;
      // Don't block login/sync on backup probe — run after first paint / sync starts.
      void client
        .getCrypto()
        ?.checkKeyBackupAndEnable?.()
        ?.catch(() => {
          // backup may not exist yet
        });
    };

    try {
      await initCrypto();
    } catch (error) {
      const message = error?.message || String(error);
      this.cryptoError = message;
      console.warn('[MatrixSession] rust crypto init failed:', message);
      const mismatch = /doesn't match the account in the constructor|account in the store/i.test(
        message,
      );
      const dbClosed = /Database is not open|IO error|LOCK|LEVEL_LOCKED/i.test(message);
      if (mismatch || dbClosed) {
        console.warn(
          `[MatrixSession] recovering crypto store (${mismatch ? 'account mismatch' : 'db lock'})`,
        );
        try {
          await recoverCryptoIndexedDb(this.dataDir, { wipe: mismatch });
          await initCrypto();
          this.cryptoError = null;
          console.warn('[MatrixSession] rust crypto recovered');
        } catch (retryError) {
          // Last resort: wipe store once more for lock corruption.
          if (dbClosed && !mismatch) {
            try {
              await recoverCryptoIndexedDb(this.dataDir, { wipe: true });
              await initCrypto();
              this.cryptoError = null;
              console.warn('[MatrixSession] rust crypto recovered after wipe');
            } catch (wipeError) {
              this.cryptoError = wipeError?.message || String(wipeError);
              console.warn('[MatrixSession] rust crypto recovery failed:', this.cryptoError);
            }
          } else {
            this.cryptoError = retryError?.message || String(retryError);
            console.warn('[MatrixSession] rust crypto recovery failed:', this.cryptoError);
          }
        }
      }
    }

    // Seed a larger first window; older history still back-paginates on demand.
    await client.startClient({
      initialSyncLimit: 100,
      lazyLoadMembers: true,
    });

    // startClient resolves before the first /sync completes — wait for PREPARED so
    // room timelines are populated before the UI fetches messages.
    await this.waitForInitialSync(client, sdk);

    this.pluginHost?.emit('session-start', {
      userId: session.userId,
      homeserver: session.baseUrl,
      crypto: this.cryptoReady,
    });
  }

  waitForInitialSync(client, sdk, timeoutMs = 45000) {
    if (!client) return Promise.resolve();
    const state = client.getSyncState?.();
    if (state === 'PREPARED' || state === 'SYNCING' || this.ready) {
      this.ready = true;
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        try {
          client.removeListener(sdk.ClientEvent.Sync, onSync);
        } catch {
          // ignore
        }
        clearTimeout(timer);
        resolve();
      };
      const onSync = (next) => {
        if (next === 'PREPARED' || next === 'SYNCING') {
          this.ready = true;
          finish();
        }
      };
      const timer = setTimeout(() => {
        console.warn('[MatrixSession] initial sync wait timed out; continuing');
        finish();
      }, timeoutMs);
      client.on(sdk.ClientEvent.Sync, onSync);
      // Race: sync may have completed between getSyncState and listener attach.
      const now = client.getSyncState?.();
      if (now === 'PREPARED' || now === 'SYNCING' || this.ready) {
        this.ready = true;
        finish();
      }
    });
  }

  /** Expose stored credentials immediately so UI can leave login before crypto finishes. */
  primeBootSession() {
    if (this.client || this.bootSession) return Boolean(this.bootSession || this.client);
    const session = this.readStoredSession();
    if (!session?.accessToken || !session?.userId) return false;
    this.bootSession = session;
    this.restoring = true;
    return true;
  }

  async restore() {
    const session = this.readStoredSession();
    if (!session) {
      this.bootSession = null;
      this.restoring = false;
      return this.getPublicState();
    }

    this.bootSession = session;
    this.restoring = true;
    const started = Date.now();
    try {
      await this.startFromSession(session);
      console.log(`[MatrixSession] restore ok in ${Date.now() - started}ms`);
    } catch (error) {
      const message = error?.message || String(error);
      this.lastError = message;
      console.warn('[MatrixSession] restore failed (keeping session on disk):', message);
      try {
        this.client?.stopClient?.();
      } catch {
        // ignore
      }
      this.client = null;
      this.ready = false;

      // Only wipe credentials on definitive auth rejection — not transient crypto/network blips.
      const authDead =
        /M_UNKNOWN_TOKEN|M_MISSING_TOKEN|Invalid session|401|unauthorized|logged out/i.test(
          message,
        );
      if (authDead) {
        console.warn('[MatrixSession] clearing stored session after auth failure');
        this.clearStoredSession();
        this.bootSession = null;
      } else if (/Database is not open|IO error|LOCK|LEVEL_LOCKED/i.test(message)) {
        // One automatic recovery pass so a crash-lock doesn't leave empty chat UI.
        try {
          console.warn('[MatrixSession] retrying restore after crypto DB recovery');
          await recoverCryptoIndexedDb(this.dataDir, { wipe: false });
          await this.startFromSession(session);
          console.log(`[MatrixSession] restore recovered in ${Date.now() - started}ms`);
        } catch (retryError) {
          console.warn(
            '[MatrixSession] restore recovery failed:',
            retryError?.message || retryError,
          );
          this.lastError = retryError?.message || String(retryError);
          this.bootSession = null;
        }
      } else {
        // Failed restore must not keep advertising a fake connected session.
        this.bootSession = null;
      }
    } finally {
      this.restoring = false;
      if (this.client) this.bootSession = null;
    }

    return this.getPublicState();
  }

  async logout({ clearStorage = true } = {}) {
    if (this.client) {
      try {
        this.client.stopClient();
      } catch {
        // ignore
      }
      try {
        await this.client.logout();
      } catch {
        // ignore network logout failures
      }
      this.client = null;
    }

    this.ready = false;
    this.lastError = null;
    if (clearStorage) this.clearStoredSession();
    this.pluginHost?.emit('session-end', {});
  }

  isSpaceRoom(room) {
    if (!room) return false;
    if (typeof room.isSpaceRoom === 'function') return room.isSpaceRoom();
    if (typeof room.getType === 'function' && room.getType() === 'm.space') return true;
    try {
      const create = room.currentState?.getStateEvents?.('m.room.create', '');
      return create?.getContent?.()?.type === 'm.space';
    } catch {
      return false;
    }
  }

  /** Create-event type: m.space, m.forum, etc. (Paarrot-compatible). */
  getRoomCreateType(room) {
    if (!room) return null;
    try {
      if (typeof room.getType === 'function') {
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

  /** im.paarrot.room.kind state (e.g. forum_space). */
  getPaarrotRoomKind(room) {
    if (!room) return null;
    try {
      const event = room.currentState?.getStateEvents?.('im.paarrot.room.kind', '');
      const kind = event?.getContent?.()?.kind;
      return typeof kind === 'string' && kind ? kind : null;
    } catch {
      return null;
    }
  }

  /**
   * Forum board root — Paarrot isForumContainer / shouldShowForumLobby.
   * m.forum create type often fails SDK isSpaceRoom() but still has m.space.child.
   */
  isForumContainer(room) {
    if (!room) return false;
    if (this.getPaarrotRoomKind(room) === 'forum_space') return true;
    if (this.getRoomCreateType(room) !== 'm.forum') return false;
    if (this.isSpaceRoom(room)) return true;
    return this.getSpaceChildEntries(room).length > 0;
  }

  /** Space rail / sidebar: normal spaces plus forum containers. */
  isSpaceLikeRoom(room) {
    return this.isSpaceRoom(room) || this.isForumContainer(room);
  }

  isJoinedRoom(room) {
    if (!room) return false;
    try {
      return room.getMyMembership?.() === 'join';
    } catch {
      return false;
    }
  }

  /** Collapse "Telegram" / "Telegram (user)" style bridge duplicates. */
  spaceDedupeKey(name) {
    return String(name || '')
      .trim()
      .toLowerCase()
      .replace(/\s*\([^)]*\)\s*$/u, '')
      .replace(/\s+/gu, ' ')
      .trim();
  }

  getJoinedParentSpaceIds(room) {
    const ids = new Set();
    if (!room?.currentState?.getStateEvents) return ids;
    const events = room.currentState.getStateEvents('m.space.parent') || [];
    for (const event of events) {
      const parentId = event.getStateKey?.();
      const content = event.getContent?.() || {};
      if (!parentId || !content || Object.keys(content).length === 0) continue;
      // Spec: canonical parent links include via; keep empty-via parents if we are joined.
      ids.add(parentId);
    }
    return ids;
  }

  getRoomAvatarMxc(room) {
    if (!room) return null;
    try {
      if (typeof room.getMxcAvatarUrl === 'function') {
        const mxc = room.getMxcAvatarUrl();
        if (mxc) return mxc;
      }
      const event = room.currentState?.getStateEvents?.('m.room.avatar', '');
      const url = event?.getContent?.()?.url;
      return typeof url === 'string' && url.startsWith('mxc://') ? url : null;
    } catch {
      return null;
    }
  }

  getRoomAvatarUrl(room, size = 64, { original = false } = {}) {
    if (!this.client || !room) return null;

    const mxcFromRoom = () => this.getRoomAvatarMxc(room);

    try {
      if (original) {
        const mxc = mxcFromRoom();
        if (mxc) {
          // Original media keeps PNG/WebP alpha; crop thumbnails often flatten to JPEG.
          return (
            this.client.mxcUrlToHttp(mxc, undefined, undefined, undefined, false, true, true) ||
            null
          );
        }
      } else if (typeof room.getAvatarUrl === 'function') {
        // Authenticated media endpoint (MSC3916). Browser <img> can't send the
        // bearer token, so the UI should use /api/avatar/:roomId instead.
        const roomAvatar =
          room.getAvatarUrl(this.client.getHomeserverUrl(), size, size, 'crop', false, true) ||
          null;
        if (roomAvatar) return roomAvatar;
      }
      // Some SDK/room shapes leave getAvatarUrl empty even when m.room.avatar is set.
      const mxc = mxcFromRoom();
      if (mxc) {
        return this.mxcToHttpAvatar(mxc, size) || mxc;
      }
    } catch {
      // fall through to DM/member fallback
    }

    // DMs rarely set m.room.avatar — use the peer profile/member avatar.
    const peerId = this.getDmPeerUserId(room);
    if (peerId) {
      if (original) {
        const full = this.getProfileAvatarFullRemoteUrl(peerId);
        if (full) return full;
      }
      const peerUrl = this.mxcToHttpAvatar(this.getAvatarMxc(peerId, room), size);
      if (peerUrl) return peerUrl;
    }

    try {
      const fallback = room.getAvatarFallbackMember?.();
      const fallbackId = fallback?.userId || null;
      if (fallbackId && fallbackId !== this.client.getUserId()) {
        const mxc =
          this.getAvatarMxc(fallbackId, room) ||
          (typeof fallback.getMxcAvatarUrl === 'function' && fallback.getMxcAvatarUrl()) ||
          null;
        if (original && mxc) {
          const full =
            this.client.mxcUrlToHttp(mxc, undefined, undefined, undefined, false, true, true) ||
            null;
          if (full) return full;
        }
        const url = this.mxcToHttpAvatar(mxc, size);
        if (url) return url;
      }
    } catch {
      // ignore
    }

    return null;
  }

  getLocalAvatarPath(roomId, size = 96, { original = false } = {}) {
    if (!roomId) return null;
    const params = new URLSearchParams({ size: String(size) });
    if (original) params.set('original', '1');
    return `/api/avatar/${encodeURIComponent(roomId)}?${params.toString()}`;
  }

  async fetchRoomAvatarBuffer(roomId, size = 96, { original = false } = {}) {
    if (!this.client) throw new Error('Not logged in');
    const room = this.client.getRoom(roomId);
    if (!room) throw new Error('Room not found');

    const remoteUrl = this.getRoomAvatarUrl(room, size, { original });
    if (remoteUrl) {
      const token = this.client.getAccessToken();
      const response = await fetch(remoteUrl, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        redirect: 'follow',
      });
      if (response.ok) {
        const contentType = response.headers.get('content-type') || 'image/png';
        const buffer = Buffer.from(await response.arrayBuffer());
        return { contentType, buffer };
      }
    }

    // If original failed, try cropped thumbnail as last resort.
    if (original) {
      try {
        return await this.fetchRoomAvatarBuffer(roomId, size, { original: false });
      } catch {
        // continue to peer fallback
      }
    }

    const peerId = this.getDmPeerUserId(room);
    if (peerId) {
      try {
        return await this.fetchProfileAvatarBuffer(peerId, size);
      } catch {
        return null;
      }
    }

    return null;
  }

  getDirectRoomIdSet() {
    const ids = new Set();
    if (!this.client) return ids;

    try {
      const event = this.client.getAccountData?.('m.direct');
      const content = event?.getContent?.() || {};
      for (const value of Object.values(content)) {
        if (Array.isArray(value)) {
          for (const roomId of value) {
            if (typeof roomId === 'string') ids.add(roomId);
          }
        }
      }
    } catch {
      // ignore
    }

    return ids;
  }

  getSpaceChildEntries(spaceRoom) {
    const entries = [];
    if (!spaceRoom?.currentState?.getStateEvents) return entries;

    const events = spaceRoom.currentState.getStateEvents('m.space.child') || [];
    const byId = new Map();
    for (const event of events) {
      const roomId = event.getStateKey?.();
      const content = event.getContent?.() || {};
      if (!roomId) continue;
      // Tombstoned / removed children usually have empty content.
      if (!content || Object.keys(content).length === 0) continue;
      const next = {
        roomId,
        order: typeof content.order === 'string' ? content.order : null,
        suggested: Boolean(content.suggested),
      };
      const prev = byId.get(roomId);
      if (!prev) {
        byId.set(roomId, next);
        continue;
      }
      // Prefer the entry that has an order key; keep suggested if either marks it.
      if (!prev.order && next.order) {
        byId.set(roomId, { ...next, suggested: prev.suggested || next.suggested });
      } else {
        prev.suggested = prev.suggested || next.suggested;
      }
    }

    entries.push(...byId.values());
    entries.sort((a, b) => {
      if (a.order && b.order && a.order !== b.order) {
        return a.order < b.order ? -1 : 1;
      }
      if (a.order && !b.order) return -1;
      if (!a.order && b.order) return 1;
      return String(a.roomId).localeCompare(String(b.roomId));
    });
    return entries;
  }

  getSpaceChildIds(spaceRoom) {
    return new Set(this.getSpaceChildEntries(spaceRoom).map((entry) => entry.roomId));
  }

  /**
   * Room ids listed under any joined space (recursive m.space.child), excluding space rooms themselves.
   */
  getSpaceOrganizedRoomIds() {
    const ids = new Set();
    if (!this.client) return ids;

    const walk = (spaceRoom, depth = 0) => {
      if (!spaceRoom || depth > 8) return;
      for (const entry of this.getSpaceChildEntries(spaceRoom)) {
        const child = this.client.getRoom(entry.roomId);
        if (!child) continue;
        if (this.isSpaceLikeRoom(child)) {
          walk(child, depth + 1);
        } else {
          ids.add(entry.roomId);
        }
      }
    };

    for (const room of this.client.getRooms() || []) {
      if (!this.isSpaceLikeRoom(room) || !this.isJoinedRoom(room)) continue;
      walk(room);
    }
    return ids;
  }

  isRoomInJoinedSpaceHierarchy(room, organizedIds = null) {
    if (!this.client || !room) return false;
    for (const parentId of this.getJoinedParentSpaceIds(room)) {
      const parent = this.client.getRoom(parentId);
      if (parent && this.isSpaceLikeRoom(parent) && this.isJoinedRoom(parent)) {
        return true;
      }
    }
    const ids = organizedIds || this.getSpaceOrganizedRoomIds();
    return ids.has(room.roomId);
  }

  getDmPeerUserId(room) {
    if (!this.client || !room) return null;
    const myId = this.client.getUserId();
    try {
      const direct = this.client.getAccountData?.('m.direct')?.getContent?.() || {};
      for (const [userId, rooms] of Object.entries(direct)) {
        if (userId && userId !== myId && Array.isArray(rooms) && rooms.includes(room.roomId)) {
          return userId;
        }
      }
    } catch {
      // fall through
    }
    try {
      const members =
        typeof room.getJoinedMembers === 'function'
          ? room.getJoinedMembers()
          : [];
      const others = members
        .map((member) => member?.userId || member?.user_id)
        .filter((id) => id && id !== myId);
      if (others.length === 1) return others[0];
    } catch {
      // ignore
    }
    return null;
  }

  getUserPresence(userId) {
    if (!this.client || !userId) return null;
    try {
      const user = this.client.getUser?.(userId);
      const presence = user?.presence || null;
      if (presence === 'online' || presence === 'unavailable' || presence === 'offline') {
        return presence;
      }
    } catch {
      // ignore
    }
    return null;
  }

  getJoinRule(room) {
    try {
      if (typeof room?.getJoinRule === 'function') {
        const rule = room.getJoinRule();
        if (rule) return rule;
      }
      const event = room?.currentState?.getStateEvents?.('m.room.join_rules', '');
      const rule = event?.getContent?.()?.join_rule;
      return typeof rule === 'string' ? rule : 'invite';
    } catch {
      return 'invite';
    }
  }

  getPaarrotSubRoomIds(room) {
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

  getRoomCreatorInfo(room) {
    try {
      const create = room.currentState?.getStateEvents?.('m.room.create', '');
      if (!create) return { creatorUserId: null, creatorName: null, createdTs: null };
      const creatorUserId =
        create.getSender?.() ||
        (typeof create.getContent?.()?.creator === 'string' ? create.getContent().creator : null) ||
        null;
      return {
        creatorUserId,
        creatorName: creatorUserId ? this.getMemberDisplayName(room, creatorUserId) || creatorUserId : null,
        createdTs: typeof create.getTs === 'function' ? create.getTs() : null,
      };
    } catch {
      return { creatorUserId: null, creatorName: null, createdTs: null };
    }
  }

  getDmSidebarStatus(room) {
    const typingUsers = this.getTypingUsers(room.roomId);
    const typing = typingUsers.length > 0;
    const typingLabel = typing
      ? typingUsers.length === 1
        ? 'Typing…'
        : `${typingUsers.length} typing…`
      : '';
    let lastMine = false;
    let peerRead = false;
    if (!this.client) {
      return { typing, typingLabel, lastMine, peerRead };
    }
    const myId = this.client.getUserId();
    const peerId = this.getDmPeerUserId(room);
    const liveEvents =
      typeof room.getLiveTimeline === 'function'
        ? room.getLiveTimeline()?.getEvents?.() || []
        : [];
    let sawLastMessage = false;
    let lastOutboundId = null;
    for (let i = liveEvents.length - 1; i >= 0; i -= 1) {
      const ev = liveEvents[i];
      if (!ev) continue;
      const type = ev.getType?.();
      if (type !== 'm.room.message' && type !== 'm.room.encrypted') continue;
      if (typeof ev.isRedacted === 'function' && ev.isRedacted()) continue;
      const sender = ev.getSender?.();
      if (!sawLastMessage) {
        lastMine = sender === myId;
        sawLastMessage = true;
      }
      if (sender === myId) {
        lastOutboundId = ev.getId?.() || null;
        break;
      }
    }
    if (lastOutboundId && peerId) {
      try {
        if (typeof room.hasUserReadEvent === 'function') {
          peerRead = Boolean(room.hasUserReadEvent(peerId, lastOutboundId));
        } else {
          const peerUpTo =
            (typeof room.getEventReadUpTo === 'function' && room.getEventReadUpTo(peerId)) ||
            null;
          if (peerUpTo === lastOutboundId) {
            peerRead = true;
          } else if (peerUpTo) {
            let peerIdx = -1;
            let outIdx = -1;
            for (let j = 0; j < liveEvents.length; j += 1) {
              const id = liveEvents[j]?.getId?.();
              if (id === peerUpTo) peerIdx = j;
              if (id === lastOutboundId) outIdx = j;
            }
            peerRead = peerIdx >= 0 && outIdx >= 0 && peerIdx >= outIdx;
          }
        }
      } catch {
        peerRead = false;
      }
    }
    return { typing, typingLabel, lastMine, peerRead };
  }

  serializeRoom(room, { isDirect = false } = {}) {
    const last = room.getLastLiveEvent?.() || null;
    const dmUserId = isDirect ? this.getDmPeerUserId(room) : null;
    const presence = dmUserId ? this.getUserPresence(dmUserId) : null;
    const alias = room.getCanonicalAlias?.() || null;
    const topicEvent = room.currentState?.getStateEvents?.('m.room.topic', '');
    const topic = topicEvent?.getContent?.()?.topic || '';
    const creator = this.getRoomCreatorInfo(room);
    const dmStatus = isDirect
      ? this.getDmSidebarStatus(room)
      : { typing: false, typingLabel: '', lastMine: false, peerRead: false };
    return {
      roomId: room.roomId,
      name: room.name || room.roomId,
      topic,
      unread:
        typeof room.getUnreadNotificationCount === 'function'
          ? room.getUnreadNotificationCount()
          : 0,
      lastEventTs: last ? last.getTs() : 0,
      encrypted:
        typeof room.hasEncryptionStateEvent === 'function'
          ? room.hasEncryptionStateEvent()
          : false,
      isSpace: this.isSpaceRoom(room),
      isDirect,
      dmUserId,
      presence,
      online: presence === 'online',
      typing: dmStatus.typing,
      typingLabel: dmStatus.typingLabel,
      lastMine: dmStatus.lastMine,
      peerRead: dmStatus.peerRead,
      alias,
      permalink: alias
        ? `https://matrix.to/#/${alias}`
        : `https://matrix.to/#/${room.roomId}`,
      avatarUrl: this.getLocalAvatarPath(room.roomId, 96),
      avatarUrlLg: this.getLocalAvatarPath(room.roomId, 128, { original: true }),
      hasAvatar: Boolean(this.getRoomAvatarMxc(room) || this.getRoomAvatarUrl(room, 96)),
      memberCount:
        typeof room.getJoinedMemberCount === 'function'
          ? room.getJoinedMemberCount()
          : room.getJoinedMembers?.()?.length || 0,
      pinnedCount: this.getPinnedEventIds(room).length,
      voiceMembers: this.getVoiceParticipantsForRoom(room),
      creatorUserId: creator.creatorUserId,
      creatorName: creator.creatorName,
      createdTs: creator.createdTs,
      joinRule: this.getJoinRule(room),
    };
  }

  listSpaces() {
    if (!this.client) return [];

    // Left/invite rooms can linger in the store and break Leave with 403.
    // Include Paarrot forum containers (m.forum / forum_space) even when SDK isSpaceRoom is false.
    const spaces = (this.client.getRooms() || []).filter(
      (room) => this.isSpaceLikeRoom(room) && this.isJoinedRoom(room),
    );
    const joinedIds = new Set(spaces.map((room) => room.roomId));

    // Only orphan/root spaces belong on the guild rail (same idea as Cinny/Paarrot).
    const childOfSpace = new Set();
    for (const space of spaces) {
      for (const childId of this.getSpaceChildIds(space)) {
        childOfSpace.add(childId);
      }
    }

    const roots = spaces
      .filter((room) => {
        if (childOfSpace.has(room.roomId)) return false;
        // Also hide spaces that declare a joined parent (even without reciprocal child).
        for (const parentId of this.getJoinedParentSpaceIds(room)) {
          if (joinedIds.has(parentId) && parentId !== room.roomId) return false;
        }
        return true;
      })
      .map((room) => {
        const summary = this.getSpaceSummary(room.roomId);
        return {
          spaceId: room.roomId,
          name: summary?.name || room.name || room.roomId,
          avatarUrl: this.getLocalAvatarPath(room.roomId, 96, { original: true }),
          hasAvatar: Boolean(this.getRoomAvatarUrl(room, 96, { original: true })),
          childCount: summary?.childCount || 0,
          unread: summary?.unread || 0,
          permalink: summary?.permalink || `https://matrix.to/#/${room.roomId}`,
          isForum: Boolean(summary?.isForum),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    // Deduplicate identical / bridge-variant names
    // (e.g. "Telegram" + "Telegram (excaliburau)", two "The Madhouse" joins).
    const byName = new Map();
    for (const space of roots) {
      const key = this.spaceDedupeKey(space.name);
      if (!key) continue;
      const existing = byName.get(key);
      if (!existing) {
        byName.set(key, space);
        continue;
      }
      // Prefer the shorter canonical name, then the richer hierarchy.
      const preferNew =
        space.childCount > existing.childCount ||
        (space.childCount === existing.childCount &&
          space.name.length < existing.name.length);
      if (preferNew) byName.set(key, space);
    }

    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  getSpaceSummary(spaceId) {
    if (!this.client) return null;
    const room = this.client.getRoom(spaceId);
    if (!room || !this.isSpaceLikeRoom(room)) return null;

    const childIds = [...this.getSpaceChildIds(room)];
    let unread = 0;
    for (const childId of childIds) {
      const child = this.client.getRoom(childId);
      if (!child || this.isSpaceLikeRoom(child)) continue;
      if (typeof child.getUnreadNotificationCount === 'function') {
        unread += child.getUnreadNotificationCount() || 0;
      }
    }
    if (typeof room.getUnreadNotificationCount === 'function') {
      unread += room.getUnreadNotificationCount() || 0;
    }

    const alias = room.getCanonicalAlias?.() || null;
    const topicEvent = room.currentState?.getStateEvents?.('m.room.topic', '');
    const topic = topicEvent?.getContent?.()?.topic || '';

    return {
      spaceId: room.roomId,
      name: room.name || room.roomId,
      topic,
      alias,
      permalink: alias
        ? `https://matrix.to/#/${alias}`
        : `https://matrix.to/#/${room.roomId}`,
      childCount: childIds.length,
      unread,
      avatarUrl: this.getLocalAvatarPath(room.roomId, 96, { original: true }),
      hasAvatar: Boolean(this.getRoomAvatarUrl(room, 96, { original: true })),
      isForum: this.isForumContainer(room),
    };
  }

  async markSpaceRead(spaceId) {
    if (!this.client) throw new Error('Not logged in');
    const room = this.client.getRoom(spaceId);
    if (!room) throw new Error('Space not found');

    const targets = [room];
    for (const childId of this.getSpaceChildIds(room)) {
      const child = this.client.getRoom(childId);
      if (child && !this.isSpaceRoom(child)) targets.push(child);
    }

    for (const target of targets) {
      const events = target.getLiveTimeline?.().getEvents?.() || [];
      const last = events[events.length - 1];
      if (!last) continue;
      try {
        // Unthreaded public receipts so other clients (and the other DM party) see them.
        await this.client.sendReadReceipt(last, undefined, true);
      } catch {
        // ignore per-room receipt failures
      }
      try {
        if (typeof this.client.setRoomReadMarkers === 'function') {
          await this.client.setRoomReadMarkers(target.roomId, last.getId(), last, last);
        }
      } catch {
        // ignore
      }
    }

    return this.getSpaceSummary(spaceId);
  }

  async inviteToSpace(spaceId, userId) {
    if (!this.client) throw new Error('Not logged in');
    const user = String(userId || '').trim();
    if (!user.startsWith('@') || !user.includes(':')) {
      throw new Error('Invite needs a full Matrix ID like @user:server');
    }
    await this.client.invite(spaceId, user);
    return { ok: true, spaceId, userId: user };
  }

  async leaveSpace(spaceId) {
    return this.leaveRoom(spaceId);
  }

  /**
   * Remove a child room/space link from a parent space (clears m.space.child).
   * Matrix treats empty content as "unlisted" / removed from the hierarchy.
   */
  async removeSpaceChild(parentSpaceId, childId) {
    if (!this.client) throw new Error('Not logged in');
    const parentId = String(parentSpaceId || '').trim();
    const childRoomId = String(childId || '').trim();
    if (!parentId.startsWith('!') || !childRoomId.startsWith('!')) {
      throw new Error('Parent space and child id are required');
    }
    const parent = this.client.getRoom(parentId);
    if (!parent || !this.isSpaceLikeRoom(parent)) throw new Error('Parent space not found');
    if (!this.isJoinedRoom(parent)) throw new Error('Join the parent space first');

    await this.client.sendStateEvent(parentId, 'm.space.child', {}, childRoomId);
    return { ok: true, parentSpaceId: parentId, childId: childRoomId };
  }

  getSpaceChildStateContent(parentSpaceId, childId) {
    const parent = this.client?.getRoom?.(parentSpaceId);
    if (!parent?.currentState?.getStateEvents) return null;
    const event = parent.currentState.getStateEvents('m.space.child', childId);
    const content = event?.getContent?.() || null;
    if (!content || Object.keys(content).length === 0) return null;
    return { ...content };
  }

  spaceChildOrderKey(index) {
    return `a${String(Math.max(0, Number(index) || 0)).padStart(4, '0')}`;
  }

  /**
   * Lexicographic m.space.child order strictly between two sibling keys (either may be null).
   */
  orderKeyBetween(before, after) {
    const lo = typeof before === 'string' && before ? before : null;
    const hi = typeof after === 'string' && after ? after : null;
    if (!lo && !hi) return this.spaceChildOrderKey(0);
    if (!lo) {
      const tail = hi;
      if (tail.length > 1) {
        const candidate = `${tail.slice(0, -1)}${String.fromCharCode(Math.max(33, tail.charCodeAt(tail.length - 1) - 1))}`;
        if (candidate < tail) return candidate;
      }
      return `\u0000${tail}`;
    }
    if (!hi) return `${lo}a`;
    if (lo >= hi) return `${lo}a`;

    let prefix = '';
    const maxLen = Math.max(lo.length, hi.length);
    for (let i = 0; i < maxLen; i += 1) {
      const lc = i < lo.length ? lo.charCodeAt(i) : 96;
      const hc = i < hi.length ? hi.charCodeAt(i) : 123;
      if (lc === hc) {
        prefix += lo[i] || hi[i];
        continue;
      }
      if (hc - lc > 1) {
        return prefix + String.fromCharCode(Math.floor((lc + hc) / 2));
      }
      prefix += lo[i];
      return `${prefix}a`;
    }
    return `${lo}a`;
  }

  resolveSpaceChildVia(parentId, childId, existingVia) {
    if (Array.isArray(existingVia) && existingVia.length) {
      return existingVia.map((entry) => String(entry || '').trim()).filter(Boolean);
    }
    const via = [];
    const myDomain = String(this.client?.getUserId?.() || '').split(':')[1];
    if (myDomain) via.push(myDomain);
    for (const id of [parentId, childId]) {
      const domain = String(id || '').split(':')[1];
      if (domain && !via.includes(domain)) via.push(domain);
    }
    return via.slice(0, 3);
  }

  /**
   * Create/update an m.space.child link, optionally setting lexicographic `order`.
   */
  async setSpaceChild(parentSpaceId, childId, { order = undefined, suggested = undefined, via = undefined } = {}) {
    if (!this.client) throw new Error('Not logged in');
    const parentId = String(parentSpaceId || '').trim();
    const childRoomId = String(childId || '').trim();
    if (!parentId.startsWith('!') || !childRoomId.startsWith('!')) {
      throw new Error('Parent space and child id are required');
    }
    const parent = this.client.getRoom(parentId);
    if (!parent || !this.isSpaceLikeRoom(parent)) throw new Error('Parent space not found');
    if (!this.isJoinedRoom(parent)) throw new Error('Join the parent space first');

    const prev = this.getSpaceChildStateContent(parentId, childRoomId) || {};
    const nextVia = this.resolveSpaceChildVia(parentId, childRoomId, via ?? prev.via);
    const content = {
      auto_join: Boolean(prev.auto_join),
      suggested: suggested !== undefined ? Boolean(suggested) : Boolean(prev.suggested),
      ...(nextVia.length ? { via: nextVia } : {}),
    };
    if (order !== undefined && order !== null) {
      content.order = String(order);
    } else if (typeof prev.order === 'string') {
      content.order = prev.order;
    }

    await this.client.sendStateEvent(parentId, 'm.space.child', content, childRoomId);
    return { ok: true, parentSpaceId: parentId, childId: childRoomId, content };
  }

  /**
   * Joined rooms that can be linked into a space (not already a direct child).
   * Excludes DMs and the parent space itself; includes other spaces as subspaces.
   */
  listAddableRoomsForSpace(spaceId) {
    if (!this.client) return [];
    const parentId = String(spaceId || '').trim();
    if (!parentId.startsWith('!')) return [];
    const parent = this.client.getRoom(parentId);
    if (!parent || !this.isSpaceLikeRoom(parent)) return [];
    const childIds = this.getSpaceChildIds(parent);
    const directIds = this.getDirectRoomIdSet();

    return (this.client.getRooms() || [])
      .filter((room) => {
        if (!this.isJoinedRoom(room)) return false;
        if (room.roomId === parentId) return false;
        if (childIds.has(room.roomId)) return false;
        if (directIds.has(room.roomId) || this.isDirectRoom(room)) return false;
        return true;
      })
      .map((room) => ({
        ...this.serializeRoom(room, { isDirect: false }),
        isSpace: this.isSpaceLikeRoom(room),
      }))
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  }

  async addExistingRoomToSpace(spaceId, roomId) {
    if (!this.client) throw new Error('Not logged in');
    const parentId = String(spaceId || '').trim();
    const childId = String(roomId || '').trim();
    if (!parentId.startsWith('!') || !childId.startsWith('!')) {
      throw new Error('Space and room id are required');
    }
    if (parentId === childId) throw new Error('A space cannot contain itself');
    const parent = this.client.getRoom(parentId);
    if (!parent || !this.isSpaceLikeRoom(parent)) throw new Error('Space not found');
    if (!this.isJoinedRoom(parent)) throw new Error('Join the space first');
    const child = this.client.getRoom(childId);
    if (!child) throw new Error('Room not found');
    if (!this.isJoinedRoom(child)) throw new Error('Join the room before adding it to this space');
    if (this.isDirectRoom(child)) throw new Error('Direct messages cannot be added to a space');
    if (this.getSpaceChildIds(parent).has(childId)) {
      return {
        ok: true,
        parentSpaceId: parentId,
        roomId: childId,
        alreadyLinked: true,
        summary: this.isSpaceLikeRoom(child)
          ? this.getSpaceSummary(childId)
          : this.getRoomSummary(childId),
      };
    }

    const entries = this.getSpaceChildEntries(parent);
    const lastOrder =
      entries.length > 0
        ? this.getSpaceChildStateContent(parentId, entries[entries.length - 1].roomId)?.order || null
        : null;
    const order = this.orderKeyBetween(lastOrder, null);
    await this.setSpaceChild(parentId, childId, { order });
    return {
      ok: true,
      parentSpaceId: parentId,
      roomId: childId,
      isSpace: this.isSpaceLikeRoom(child),
      summary: this.isSpaceLikeRoom(child)
        ? this.getSpaceSummary(childId)
        : this.getRoomSummary(childId),
    };
  }

  /**
   * Rewrite m.space.child `order` for ids in orderedChildIds (only sends events that changed).
   */
  async reorderSpaceChildren(parentSpaceId, orderedChildIds = []) {
    if (!this.client) throw new Error('Not logged in');
    const parentId = String(parentSpaceId || '').trim();
    if (!parentId.startsWith('!')) throw new Error('Parent space is required');
    const ids = (Array.isArray(orderedChildIds) ? orderedChildIds : [])
      .map((id) => String(id || '').trim())
      .filter((id, index, all) => id.startsWith('!') && all.indexOf(id) === index);
    if (!ids.length) throw new Error('childIds are required');

    const updates = [];
    for (let i = 0; i < ids.length; i += 1) {
      const order = this.spaceChildOrderKey(i);
      const prev = this.getSpaceChildStateContent(parentId, ids[i]);
      if (prev?.order === order) continue;
      updates.push({ id: ids[i], order });
    }
    if (updates.length) {
      await Promise.all(
        updates.map(({ id, order }) => this.setSpaceChild(parentId, id, { order })),
      );
    }
    return { ok: true, parentSpaceId: parentId, childIds: ids, updated: updates.length };
  }

  /**
   * Reorder only space-like children (categories) under a parent, preserving
   * relative slots of non-space children (channels) in the m.space.child list.
   */
  async reorderSpaceCategories(parentSpaceId, orderedCategoryIds = []) {
    if (!this.client) throw new Error('Not logged in');
    const parentId = String(parentSpaceId || '').trim();
    if (!parentId.startsWith('!')) throw new Error('Parent space is required');
    const parent = this.client.getRoom(parentId);
    if (!parent || !this.isSpaceLikeRoom(parent)) throw new Error('Parent space not found');

    const wanted = (Array.isArray(orderedCategoryIds) ? orderedCategoryIds : [])
      .map((id) => String(id || '').trim())
      .filter((id, index, all) => id.startsWith('!') && all.indexOf(id) === index);
    if (!wanted.length) throw new Error('categoryIds are required');

    const entries = this.getSpaceChildEntries(parent);
    const isCategoryId = (id) => {
      const room = this.client.getRoom(id);
      return Boolean(room && this.isSpaceLikeRoom(room));
    };

    const next = [];
    const emitted = new Set();
    let wantIdx = 0;
    for (const entry of entries) {
      if (isCategoryId(entry.roomId)) {
        while (wantIdx < wanted.length && emitted.has(wanted[wantIdx])) wantIdx += 1;
        if (wantIdx < wanted.length) {
          const id = wanted[wantIdx];
          wantIdx += 1;
          next.push(id);
          emitted.add(id);
        }
      } else {
        next.push(entry.roomId);
      }
    }
    while (wantIdx < wanted.length) {
      const id = wanted[wantIdx];
      wantIdx += 1;
      if (emitted.has(id)) continue;
      next.push(id);
      emitted.add(id);
    }

    // Keep any existing non-listed categories that were skipped (shouldn't happen).
    for (const entry of entries) {
      if (isCategoryId(entry.roomId) && !emitted.has(entry.roomId)) {
        next.push(entry.roomId);
        emitted.add(entry.roomId);
      }
    }

    await this.reorderSpaceChildren(parentId, next);
    return { ok: true, parentSpaceId: parentId, categoryIds: wanted, childIds: next };
  }

  /**
   * Move a child room/space to another parent (or reorder within the same parent).
   * beforeId = place before this sibling; afterId = place after this sibling; null = append.
   */
  async moveSpaceChild({
    fromParentId = null,
    toParentId,
    childId,
    beforeId = null,
    afterId = null,
  } = {}) {
    if (!this.client) throw new Error('Not logged in');
    const childRoomId = String(childId || '').trim();
    const destParentId = String(toParentId || '').trim();
    const srcParentId = String(fromParentId || '').trim();
    if (!childRoomId.startsWith('!') || !destParentId.startsWith('!')) {
      throw new Error('toParentId and childId are required');
    }
    if (childRoomId === destParentId) throw new Error('Cannot move a space into itself');

    const dest = this.client.getRoom(destParentId);
    if (!dest || !this.isSpaceLikeRoom(dest)) throw new Error('Destination space not found');

    const destEntries = this.getSpaceChildEntries(dest);
    const orderById = new Map(destEntries.map((entry) => [entry.roomId, entry.order]));
    const siblings = destEntries.map((entry) => entry.roomId).filter((id) => id !== childRoomId);

    let insertIdx = siblings.length;
    const before = String(beforeId || '').trim();
    const after = String(afterId || '').trim();
    if (before.startsWith('!') && siblings.includes(before)) {
      insertIdx = siblings.indexOf(before);
    } else if (after.startsWith('!') && siblings.includes(after)) {
      insertIdx = siblings.indexOf(after) + 1;
    }

    const beforeOrder = insertIdx > 0 ? orderById.get(siblings[insertIdx - 1]) : null;
    const afterOrder = insertIdx < siblings.length ? orderById.get(siblings[insertIdx]) : null;
    const newOrder = this.orderKeyBetween(beforeOrder, afterOrder);

    if (srcParentId.startsWith('!') && srcParentId !== destParentId) {
      try {
        await this.removeSpaceChild(srcParentId, childRoomId);
      } catch (error) {
        console.warn('[MatrixSession] removeSpaceChild on move failed', error?.message || error);
      }
      // Keep canonical parent pointer when possible.
      try {
        const via = this.resolveSpaceChildVia(destParentId, childRoomId);
        await this.client.sendStateEvent(
          childRoomId,
          'm.space.parent',
          { via, canonical: true },
          destParentId,
        );
      } catch {
        // ignore — not all rooms allow parent state edits
      }
    }

    await this.setSpaceChild(destParentId, childRoomId, { order: newOrder });

    const next = [...siblings];
    next.splice(insertIdx, 0, childRoomId);
    return {
      ok: true,
      childId: childRoomId,
      fromParentId: srcParentId || null,
      toParentId: destParentId,
      childIds: next,
    };
  }

  /**
   * Delete a category (nested space): unlink from parent, then leave (+ forget).
   */
  async deleteCategory(categoryId, { parentSpaceId = null } = {}) {
    if (!this.client) throw new Error('Not logged in');
    const categoryRoomId = String(categoryId || '').trim();
    if (!categoryRoomId.startsWith('!')) throw new Error('Category id is required');

    let parentId = String(parentSpaceId || '').trim();
    if (!parentId.startsWith('!')) {
      const categoryRoom = this.client.getRoom(categoryRoomId);
      if (categoryRoom) {
        const parents = [...this.getJoinedParentSpaceIds(categoryRoom)];
        parentId = parents.find((id) => id && id !== categoryRoomId) || '';
      }
    }

    let unlinked = false;
    if (parentId.startsWith('!')) {
      try {
        await this.removeSpaceChild(parentId, categoryRoomId);
        unlinked = true;
      } catch (error) {
        // Still leave the category even if we lack power to edit parent state.
        console.warn(
          '[MatrixSession] removeSpaceChild failed',
          error?.message || error,
        );
      }
    }

    const left = await this.leaveSpace(categoryRoomId);
    return {
      ok: true,
      categoryId: categoryRoomId,
      parentSpaceId: parentId || null,
      unlinked,
      ...left,
    };
  }

  async leaveRoom(roomId) {
    if (!this.client) throw new Error('Not logged in');
    const room = this.client.getRoom(roomId);
    const membership = room?.getMyMembership?.() || null;

    const forgetQuietly = async () => {
      if (typeof this.client.forget !== 'function') return;
      try {
        await this.client.forget(roomId);
      } catch {
        // ignore — room may already be forgotten
      }
    };

    if (!membership || membership === 'leave') {
      await forgetQuietly();
      return { ok: true, roomId, alreadyLeft: true };
    }

    try {
      await this.client.leave(roomId);
    } catch (error) {
      const status = error?.httpStatus || error?.statusCode || error?.errcode;
      const message = error?.message || String(error);
      if (
        status === 403 ||
        status === 'M_FORBIDDEN' ||
        /not in room/i.test(message)
      ) {
        await forgetQuietly();
        return { ok: true, roomId, alreadyLeft: true };
      }
      throw error;
    }

    await forgetQuietly();
    return { ok: true, roomId };
  }

  async markRoomRead(roomId) {
    if (!this.client) throw new Error('Not logged in');
    const room = this.client.getRoom(roomId);
    if (!room) throw new Error('Room not found');

    const events = room.getLiveTimeline?.().getEvents?.() || [];
    const last = events[events.length - 1];
    if (!last) {
      try {
        room.setUnreadNotificationCount?.('total', 0);
        room.setUnreadNotificationCount?.('highlight', 0);
      } catch {
        // ignore
      }
      return { ok: true, roomId };
    }

    try {
      // Unthreaded public receipts so the other party can see we've read.
      await this.client.sendReadReceipt(last, undefined, true);
    } catch {
      // ignore
    }
    try {
      if (typeof this.client.setRoomReadMarkers === 'function') {
        await this.client.setRoomReadMarkers(room.roomId, last.getId(), last, last);
      }
    } catch {
      // ignore
    }
    try {
      room.setUnreadNotificationCount?.('total', 0);
      room.setUnreadNotificationCount?.('highlight', 0);
      if (typeof room.fixupNotifications === 'function') {
        room.fixupNotifications(this.client.getUserId());
      }
    } catch {
      // ignore
    }
    return { ok: true, roomId };
  }

  async listDevices() {
    if (!this.client) throw new Error('Not logged in');
    const currentId = this.client.getDeviceId();
    const userId = this.client.getUserId();
    const response = await this.client.getDevices();
    const devices = Array.isArray(response?.devices) ? response.devices : [];
    const crypto = typeof this.client.getCrypto === 'function' ? this.client.getCrypto() : null;
    let verification = 'unavailable';
    let verificationLabel = 'Unavailable';
    let keyBackup = 'unavailable';
    let keyBackupLabel = 'Not connected';
    let securityNote = this.cryptoError
      ? `Crypto failed to start: ${this.cryptoError}`
      : 'End-to-end encryption is starting…';
    let crossSigningReady = false;
    let secretStorageReady = false;

    if (crypto) {
      securityNote = '';
      try {
        crossSigningReady = Boolean(await crypto.isCrossSigningReady());
      } catch {
        crossSigningReady = false;
      }
      try {
        secretStorageReady = Boolean(await crypto.isSecretStorageReady());
      } catch {
        secretStorageReady = false;
      }
      try {
        const status =
          typeof crypto.getDeviceVerificationStatus === 'function' && currentId
            ? await crypto.getDeviceVerificationStatus(userId, currentId)
            : null;
        // Match Paarrot/Cinny: trust comes from cross-signing, not local-only flags.
        const deviceVerified = Boolean(status?.crossSigningVerified);
        if (crossSigningReady && deviceVerified) {
          verification = 'verified';
          verificationLabel = 'Verified';
        } else if (crossSigningReady) {
          verification = 'unverified';
          verificationLabel = 'Unverified';
        } else {
          verification = 'unverified';
          verificationLabel = 'Unverified';
          securityNote =
            'This device is not verified yet. Verify it (or enter your recovery key) before trusting other sessions.';
        }
      } catch {
        verification = 'unverified';
        verificationLabel = 'Unverified';
      }
      try {
        const backupVersion =
          typeof crypto.getActiveSessionBackupVersion === 'function'
            ? await crypto.getActiveSessionBackupVersion()
            : null;
        const info =
          typeof crypto.getKeyBackupInfo === 'function' ? await crypto.getKeyBackupInfo() : null;
        if (backupVersion || info?.version) {
          keyBackup = 'connected';
          keyBackupLabel = 'Connected';
        } else if (secretStorageReady) {
          keyBackup = 'disabled';
          keyBackupLabel = 'Not connected';
        } else {
          keyBackup = 'disabled';
          keyBackupLabel = 'Not connected';
          if (!securityNote) {
            securityNote =
              'Encryption backup is not connected. Set up backup to recover keys on new devices.';
          }
        }
      } catch {
        keyBackup = 'disabled';
        keyBackupLabel = 'Not connected';
      }
    } else if (!this.cryptoReady && !this.cryptoError) {
      securityNote = 'End-to-end encryption is not enabled yet.';
    }

    const mapped = [];
    for (const device of devices) {
      const deviceId = device.device_id;
      let verified = false;
      let signedByOwner = false;
      if (crypto && userId && deviceId) {
        try {
          const status =
            typeof crypto.getDeviceVerificationStatus === 'function'
              ? await crypto.getDeviceVerificationStatus(userId, deviceId)
              : null;
          // Same rule as Paarrot `verifiedDevice`: crossSigningVerified only.
          verified = Boolean(status?.crossSigningVerified);
          signedByOwner = Boolean(status?.signedByOwner);
        } catch {
          verified = false;
          signedByOwner = false;
        }
      }
      mapped.push({
        deviceId,
        displayName: device.display_name || device.device_id,
        lastSeenTs: device.last_seen_ts || null,
        lastSeenIp: device.last_seen_ip || null,
        isCurrent: Boolean(currentId && deviceId === currentId),
        verified,
        signedByOwner,
      });
    }

    mapped.sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
      return (b.lastSeenTs || 0) - (a.lastSeenTs || 0);
    });

    const currentVerified = verification === 'verified';
    // Paarrot only surfaces "N Unverified" after *this* device is verified.
    // Until then every other session looks untrusted and the count is meaningless.
    const otherUnverifiedCount = mapped.filter(
      (device) => !device.isCurrent && !device.verified,
    ).length;
    const unverifiedCount = currentVerified ? otherUnverifiedCount : 0;
    if (currentVerified && otherUnverifiedCount > 0) {
      verificationLabel = `${otherUnverifiedCount} Unverified`;
    }

    return {
      currentDeviceId: currentId || null,
      unverifiedCount,
      otherUnverifiedCount,
      currentDeviceUnverified: Boolean(crypto) && !currentVerified,
      showOtherVerification: currentVerified,
      security: {
        verification,
        verificationLabel,
        keyBackup,
        keyBackupLabel,
        note: securityNote,
        cryptoEnabled: Boolean(crypto),
        crossSigningReady,
        secretStorageReady,
        hasRecoveryKey: Boolean(this.cachedRecoveryKey),
        unverifiedCount,
        otherUnverifiedCount,
        currentDeviceUnverified: Boolean(crypto) && !currentVerified,
        showOtherVerification: currentVerified,
      },
      devices: mapped,
    };
  }

  async setupEncryption({
    recoveryKey = null,
    password = null,
    setupNewCrossSigning = false,
    setupBackup = true,
  } = {}) {
    if (!this.client) throw new Error('Not logged in');
    const crypto = this.client.getCrypto?.();
    if (!crypto) throw new Error('Crypto is not available');
    const userId = this.client.getUserId();
    if (!userId) throw new Error('Missing user id');

    const trimmedRecovery = String(recoveryKey || '')
      .trim()
      .replace(/\s+/g, ' ');
    if (trimmedRecovery) {
      try {
        const { decodeRecoveryKey } = await loadRecoveryKeyHelpers();
        const key = decodeRecoveryKey(trimmedRecovery);
        this.rememberSecretStorageKey(key, trimmedRecovery);
      } catch {
        throw new Error('Invalid recovery key. Check the key and try again.');
      }
    }

    if (!this.secretStoragePrivateKey) {
      throw new Error('Recovery key is required');
    }

    const { encodeRecoveryKey } = await loadRecoveryKeyHelpers();
    const encoded =
      this.cachedRecoveryKey || encodeRecoveryKey(this.secretStoragePrivateKey);

    // Unlock existing secret storage with the recovery key (no account password).
    try {
      await crypto.bootstrapSecretStorage({
        createSecretStorageKey: async () => ({
          privateKey: this.secretStoragePrivateKey,
          encodedPrivateKey: encoded,
        }),
        setupNewSecretStorage: Boolean(setupNewCrossSigning),
        setupNewKeyBackup: Boolean(setupBackup) && Boolean(setupNewCrossSigning),
      });
    } catch (error) {
      const message = error?.message || String(error);
      if (/secret.?storage|default key|m\.secret_storage|wrong|decrypt|mac/i.test(message)) {
        throw new Error(
          'Could not open secret storage with this recovery key. Confirm it matches a verified client.',
        );
      }
      throw error;
    }

    const authUploadDeviceSigningKeys = async (makeRequest) => {
      try {
        return await makeRequest(null);
      } catch (error) {
        const data = error?.data || {};
        const status = error?.httpStatus || error?.statusCode || error?.status;
        const needsUia =
          Number(status) === 401 ||
          Boolean(data.session) ||
          Array.isArray(data.flows);
        if (!needsUia) throw error;
        const pwd = String(password || '');
        if (!pwd) {
          const err = new Error(
            'Account password required to finish verifying this device.',
          );
          err.code = 'NEEDS_PASSWORD';
          err.needsPassword = true;
          err.session = data.session || null;
          throw err;
        }
        return makeRequest(this.buildPasswordAuth(data, pwd));
      }
    };

    try {
      await crypto.bootstrapCrossSigning({
        setupNewCrossSigning: Boolean(setupNewCrossSigning),
        authUploadDeviceSigningKeys,
      });
    } catch (error) {
      if (error?.code === 'NEEDS_PASSWORD' || error?.needsPassword) throw error;
      const message = error?.message || String(error);
      if (/NEEDS_PASSWORD|password required/i.test(message)) {
        const err = new Error(
          'Account password required to finish verifying this device.',
        );
        err.code = 'NEEDS_PASSWORD';
        err.needsPassword = true;
        throw err;
      }
      if (/authUploadDeviceSigningKeys|UIA|401|403|password/i.test(message)) {
        throw new Error(
          'Could not finish cross-signing. Check your recovery key, or try again with your account password.',
        );
      }
      throw error;
    }

    if (setupBackup) {
      try {
        await crypto.loadSessionBackupPrivateKeyFromSecretStorage?.();
      } catch {
        // may not exist yet
      }
      try {
        await crypto.checkKeyBackupAndEnable();
      } catch (error) {
        console.warn('[MatrixSession] key backup enable failed:', error?.message || error);
      }
    }

    const deviceId = this.client.getDeviceId();
    if (deviceId) {
      try {
        await crypto.crossSignDevice(deviceId);
      } catch {
        // may already be signed
      }
    }

    const devices = await this.listDevices();
    return {
      ok: true,
      recoveryKey: this.cachedRecoveryKey || encoded,
      security: devices.security,
      devices: devices.devices,
      currentDeviceId: devices.currentDeviceId,
    };
  }

  async enableKeyBackup({ recoveryKey, password } = {}) {
    return this.setupEncryption({
      recoveryKey,
      password,
      setupNewCrossSigning: false,
      setupBackup: true,
    });
  }

  async verifyOwnDevice({ recoveryKey, password } = {}) {
    return this.setupEncryption({
      recoveryKey,
      password,
      setupNewCrossSigning: false,
      setupBackup: true,
    });
  }

  async verifyDevice(deviceId) {
    if (!this.client) throw new Error('Not logged in');
    const id = String(deviceId || '').trim();
    if (!id) throw new Error('Device id required');
    const crypto = this.client.getCrypto?.();
    if (!crypto) throw new Error('Crypto is not available');
    const crossSigningReady = Boolean(await crypto.isCrossSigningReady?.());
    if (!crossSigningReady) {
      throw new Error('Verify this Kitsu device first, then you can verify others.');
    }
    if (typeof crypto.crossSignDevice !== 'function') {
      throw new Error('Device verification is not supported by this crypto stack');
    }
    await crypto.crossSignDevice(id);
    return this.listDevices();
  }

  async resetCrossSigning({ recoveryKey, password } = {}) {
    return this.setupEncryption({
      recoveryKey,
      password,
      setupNewCrossSigning: true,
      setupBackup: true,
    });
  }

  getCachedRecoveryKey() {
    return this.cachedRecoveryKey;
  }

  async decryptTimelineEvent(event) {
    if (!this.client || !event) return event;
    try {
      if (typeof event.isEncrypted === 'function' && event.isEncrypted()) {
        await this.client.decryptEventIfNeeded(event);
      }
    } catch {
      // leave undecrypted
    }
    return event;
  }

  async renameDevice(deviceId, displayName) {
    if (!this.client) throw new Error('Not logged in');
    const id = String(deviceId || '').trim();
    const name = String(displayName || '').trim();
    if (!id) throw new Error('Device id required');
    if (!name) throw new Error('Display name required');
    await this.client.setDeviceDetails(id, { display_name: name });
    return this.listDevices();
  }

  buildPasswordAuth(uiaData, password) {
    const userId = this.client?.getUserId?.();
    if (!userId) throw new Error('Missing user id');
    const pwd = String(password || '');
    if (!pwd) {
      const err = new Error('Password required to remove devices');
      err.code = 'NEEDS_PASSWORD';
      err.session = uiaData?.session || null;
      throw err;
    }
    return {
      type: 'm.login.password',
      identifier: {
        type: 'm.id.user',
        user: userId,
      },
      user: userId,
      password: pwd,
      session: uiaData?.session,
    };
  }

  async withDeviceDeleteAuth(run, { password } = {}) {
    try {
      await run(null);
      return;
    } catch (error) {
      const data = error?.data || {};
      const status = error?.httpStatus || error?.statusCode || error?.status;
      const uia =
        Number(status) === 401 &&
        (Boolean(data.session) || Array.isArray(data.flows));
      if (!uia) throw error;
      if (!password) {
        const err = new Error('Password required to remove devices');
        err.code = 'NEEDS_PASSWORD';
        err.session = data.session || null;
        throw err;
      }
      await run(this.buildPasswordAuth(data, password));
    }
  }

  async logoutDevice(deviceId, { password } = {}) {
    if (!this.client) throw new Error('Not logged in');
    const id = String(deviceId || '').trim();
    if (!id) throw new Error('Device id required');
    if (id === this.client.getDeviceId()) {
      throw new Error('Cannot log out the current device from here. Use Log out.');
    }
    await this.withDeviceDeleteAuth(
      (auth) => this.client.deleteDevice(id, auth || undefined),
      { password },
    );
    return this.listDevices();
  }

  async logoutDevices(deviceIds, { password } = {}) {
    if (!this.client) throw new Error('Not logged in');
    const currentId = this.client.getDeviceId();
    const ids = [...new Set((Array.isArray(deviceIds) ? deviceIds : []).map((id) => String(id || '').trim()).filter(Boolean))]
      .filter((id) => id !== currentId);
    if (!ids.length) throw new Error('No devices to remove');
    await this.withDeviceDeleteAuth(
      (auth) => this.client.deleteMultipleDevices(ids, auth || undefined),
      { password },
    );
    return this.listDevices();
  }

  async setTyping(roomId, typing, timeoutMs = 20000) {
    if (!this.client) throw new Error('Not logged in');
    const room = this.client.getRoom(roomId);
    if (!room) throw new Error('Room not found');
    await this.client.sendTyping(roomId, Boolean(typing), Number(timeoutMs) || 20000);
    return { ok: true, roomId, typing: Boolean(typing) };
  }

  getTypingUsers(roomId) {
    if (!this.client) return [];
    const room = this.client.getRoom(roomId);
    if (!room) return [];
    const myId = this.client.getUserId();
    const members =
      typeof room.getJoinedMembers === 'function' ? room.getJoinedMembers() : [];
    return members
      .filter((member) => member?.typing && member.userId && member.userId !== myId)
      .map((member) => ({
        userId: member.userId,
        displayName: this.getMemberDisplayName(room, member.userId),
        avatarUrl: this.getLocalProfileAvatarPath(member.userId, 64),
        hasAvatar: Boolean(this.getAvatarMxc(member.userId, room)),
      }))
      .sort((a, b) =>
        String(a.displayName).localeCompare(String(b.displayName), undefined, {
          sensitivity: 'base',
        }),
      );
  }

  getReadReceiptsByEventId(room) {
    const byEvent = new Map();
    if (!room || !this.client) return byEvent;
    const myId = this.client.getUserId();
    const liveEvents =
      typeof room.getLiveTimeline === 'function'
        ? room.getLiveTimeline()?.getEvents?.() || []
        : [];
    const eventIndex = new Map();
    for (let i = 0; i < liveEvents.length; i += 1) {
      const id = liveEvents[i]?.getId?.();
      if (id) eventIndex.set(id, i);
    }

    const members =
      typeof room.getJoinedMembers === 'function' ? room.getJoinedMembers() : [];
    const dmPeerId = this.getDmPeerUserId(room);
    const readers = [];
    for (const member of members) {
      const userId = member?.userId;
      // Only other people — never treat yourself as a "seen by" entry.
      if (!userId || userId === myId) continue;
      // Bridge DMs: only the human peer counts, not bots/apps in the room.
      if (dmPeerId && userId !== dmPeerId) continue;
      let eventId = null;
      try {
        eventId =
          (typeof room.getEventReadUpTo === 'function' && room.getEventReadUpTo(userId)) ||
          null;
      } catch {
        eventId = null;
      }
      readers.push({
        userId,
        eventId,
        index: eventId && eventIndex.has(eventId) ? eventIndex.get(eventId) : -1,
        displayName: this.getMemberDisplayName(room, userId),
        avatarUrl: this.getLocalProfileAvatarPath(userId, 64),
        hasAvatar: Boolean(this.getAvatarMxc(userId, room)),
      });
    }

    const userHasRead = (userId, eventId, fallbackIndex) => {
      if (!userId || !eventId) return false;
      try {
        if (typeof room.hasUserReadEvent === 'function') {
          return Boolean(room.hasUserReadEvent(userId, eventId));
        }
      } catch {
        // fall through to index walk
      }
      if (fallbackIndex < 0) return false;
      const eventIdx = eventIndex.has(eventId) ? eventIndex.get(eventId) : -1;
      if (eventIdx < 0) return false;
      return fallbackIndex >= eventIdx;
    };

    // Matrix receipts are "read up to": anyone whose marker is at or after an
    // event has seen that event (Paarrot/Cinny getUsersReadUpTo walk).
    for (let i = 0; i < liveEvents.length; i += 1) {
      const id = liveEvents[i]?.getId?.();
      if (!id) continue;
      const list = [];
      for (const reader of readers) {
        if (!userHasRead(reader.userId, id, reader.index)) continue;
        list.push({
          userId: reader.userId,
          displayName: reader.displayName,
          avatarUrl: reader.avatarUrl,
          hasAvatar: reader.hasAvatar,
        });
      }
      if (list.length) byEvent.set(id, list);
    }

    // Exact marker events missing from the live timeline still get their reader.
    for (const reader of readers) {
      if (!reader.eventId || byEvent.has(reader.eventId)) continue;
      byEvent.set(reader.eventId, [
        {
          userId: reader.userId,
          displayName: reader.displayName,
          avatarUrl: reader.avatarUrl,
          hasAvatar: reader.hasAvatar,
        },
      ]);
    }

    return byEvent;
  }

  async inviteToRoom(roomId, userId) {
    if (!this.client) throw new Error('Not logged in');
    const user = String(userId || '').trim();
    if (!user.startsWith('@') || !user.includes(':')) {
      throw new Error('Invite needs a full Matrix ID like @user:server');
    }
    await this.client.invite(roomId, user);
    return { ok: true, roomId, userId: user };
  }

  isDirectInviteRoom(room) {
    if (!room) return false;
    try {
      const create = room.currentState?.getStateEvents?.('m.room.create', '')?.getContent?.();
      if (create?.is_direct) return true;
    } catch {
      // ignore
    }
    try {
      const joined = room.getMembersWithMembership?.('join') || [];
      const invited = room.getMembersWithMembership?.('invite') || [];
      if (joined.length + invited.length === 2) return true;
    } catch {
      // ignore
    }
    return false;
  }

  isDirectRoom(room) {
    if (!room) return false;
    if (this.getDirectRoomIdSet().has(room.roomId)) return true;
    try {
      const create = room.currentState?.getStateEvents?.('m.room.create', '')?.getContent?.();
      if (create?.is_direct) return true;
    } catch {
      // ignore
    }
    return false;
  }

  isDmSidebarRoom(room, organizedIds = null) {
    if (!this.isDirectRoom(room)) return false;
    return !this.isRoomInJoinedSpaceHierarchy(room, organizedIds);
  }

  /** Joined channels that are neither DMs nor listed under any joined space. */
  isHomeSidebarRoom(room, organizedIds = null) {
    if (!room || !this.isJoinedRoom(room) || this.isSpaceLikeRoom(room)) return false;
    if (this.isDirectRoom(room)) return false;
    return !this.isRoomInJoinedSpaceHierarchy(room, organizedIds);
  }

  async ensureDirectRoomInAccountData(room) {
    if (!this.client || !room || !this.isDirectRoom(room)) return;
    const peerId = this.getDmPeerUserId(room);
    if (!peerId) return;
    try {
      const event = this.client.getAccountData?.('m.direct');
      const content = { ...(event?.getContent?.() || {}) };
      const list = Array.isArray(content[peerId]) ? [...content[peerId]] : [];
      if (!list.includes(room.roomId)) list.unshift(room.roomId);
      content[peerId] = list;
      await this.client.setAccountData('m.direct', content);
    } catch {
      // DM still works without m.direct update
    }
  }

  findSpaceFilterForRoom(roomId) {
    if (!this.client || !roomId) return 'dms';
    const room = this.client.getRoom(roomId);

    const collectSidebarRoomIds = (spaceId) => {
      const ids = new Set();
      const sidebar = this.listSpaceSidebar(spaceId);
      for (const entry of sidebar.rooms || []) {
        if (entry?.roomId) ids.add(entry.roomId);
      }
      for (const group of sidebar.groups || []) {
        for (const item of group.items || []) {
          if (item?.roomId) ids.add(item.roomId);
          if (item?.type === 'subspace' && item.spaceId) {
            for (const nestedId of collectSidebarRoomIds(item.spaceId)) {
              ids.add(nestedId);
            }
          }
        }
      }
      return ids;
    };

    for (const space of this.listSpaces()) {
      if (space.spaceId === roomId) return space.spaceId;
      if (collectSidebarRoomIds(space.spaceId).has(roomId)) return space.spaceId;
    }

    // Nested spaces that are not on the guild rail still need a filter target.
    for (const candidate of this.client.getRooms() || []) {
      if (!this.isSpaceLikeRoom(candidate) || !this.isJoinedRoom(candidate)) continue;
      if (candidate.roomId === roomId) return candidate.roomId;
      if (this.getSpaceChildIds(candidate).has(roomId)) return candidate.roomId;
    }

    if (room && this.isDmSidebarRoom(room)) return 'dms';
    if (room && this.isHomeSidebarRoom(room)) return 'dms';
    return 'dms';
  }

  getInviteInviter(room) {
    if (!room || !this.client) return null;
    try {
      const dmInviter = room.getDMInviter?.();
      if (dmInviter) return dmInviter;
    } catch {
      // ignore
    }
    try {
      const me = room.getMember?.(this.client.getUserId());
      const event = me?.events?.member;
      if (event?.getSender && event.getSender() !== this.client.getUserId()) {
        return event.getSender();
      }
    } catch {
      // ignore
    }
    return null;
  }

  serializeInvite(room) {
    const inviterId = this.getInviteInviter(room);
    const alias = room.getCanonicalAlias?.() || null;
    const isDirect = this.isDirectInviteRoom(room);
    const topicEvent = room.currentState?.getStateEvents?.('m.room.topic', '');
    const topic = String(topicEvent?.getContent?.()?.topic || '').trim();
    const name = room.name || alias || room.roomId;
    return {
      roomId: room.roomId,
      name,
      topic,
      isSpace: this.isSpaceRoom(room),
      isDirect,
      inviterId,
      inviterName: inviterId ? this.getMemberDisplayName(room, inviterId) : null,
      inviterAvatarUrl: inviterId ? this.getLocalProfileAvatarPath(inviterId, 48) : null,
      hasInviterAvatar: inviterId
        ? Boolean(this.getProfileAvatarRemoteUrl(inviterId, 48))
        : false,
      avatarUrl: this.getLocalAvatarPath(room.roomId, 48),
      hasAvatar: Boolean(this.getRoomAvatarUrl(room, 48)),
      alias,
      permalink: alias
        ? `https://matrix.to/#/${alias}`
        : `https://matrix.to/#/${room.roomId}`,
    };
  }

  listInvites() {
    if (!this.client) return [];
    const byId = new Map();
    for (const room of this.client.getRooms() || []) {
      try {
        if (room.getMyMembership?.() !== 'invite') continue;
      } catch {
        continue;
      }
      if (!room.roomId || byId.has(room.roomId)) continue;
      byId.set(room.roomId, this.serializeInvite(room));
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async acceptInvite(roomId) {
    if (!this.client) throw new Error('Not logged in');
    const id = String(roomId || '').trim();
    if (!id) throw new Error('Room ID is required');
    await this.client.joinRoom(id);
    let room = this.client.getRoom(id);
    for (let i = 0; i < 20 && !room; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      room = this.client.getRoom(id);
    }
    if (room) await this.ensureDirectRoomInAccountData(room);
    const isSpace = room ? this.isSpaceRoom(room) : false;
    const isDirect = room ? this.isDirectRoom(room) : false;
    const spaceFilter = isSpace ? id : this.findSpaceFilterForRoom(id);
    return {
      ok: true,
      roomId: id,
      isSpace,
      isDirect,
      spaceFilter,
      summary: room
        ? isSpace
          ? this.getSpaceSummary(id)
          : this.getRoomSummary(id)
        : null,
    };
  }

  async rejectInvite(roomId) {
    return this.leaveRoom(roomId);
  }

  async createSpace({
    name,
    topic = '',
    access = 'private',
    forumLayout = false,
    allowFederation = true,
  } = {}) {
    if (!this.client) throw new Error('Not logged in');
    const spaceName = String(name || '').trim();
    if (!spaceName) throw new Error('Space name is required');
    const spaceTopic = String(topic || '').trim();
    const wantPublic = String(access || 'private').toLowerCase() === 'public';
    const wantForum = Boolean(forumLayout);
    const federate = allowFederation !== false;

    const initial_state = [
      {
        type: 'm.room.guest_access',
        state_key: '',
        content: { guest_access: 'can_join' },
      },
      {
        type: 'm.room.history_visibility',
        state_key: '',
        content: { history_visibility: 'shared' },
      },
      {
        type: 'm.room.join_rules',
        state_key: '',
        content: { join_rule: wantPublic ? 'public' : 'invite' },
      },
    ];
    if (spaceTopic) {
      initial_state.push({
        type: 'm.room.topic',
        state_key: '',
        content: { topic: spaceTopic },
      });
    }
    if (wantForum) {
      initial_state.push({
        type: 'im.paarrot.room.kind',
        state_key: '',
        content: { kind: 'forum_space' },
      });
    }

    const creation_content = {
      type: wantForum ? 'm.forum' : 'm.space',
    };
    if (!federate) {
      creation_content['m.federate'] = false;
    }

    const result = await this.client.createRoom({
      name: spaceName,
      topic: spaceTopic || undefined,
      preset: wantPublic ? 'public_chat' : 'private_chat',
      visibility: wantPublic ? 'public' : 'private',
      creation_content,
      power_level_content_override: {
        events_default: 100,
        invite: 50,
      },
      initial_state,
    });

    const roomId = result?.room_id || result?.roomId;
    if (!roomId) throw new Error('Failed to create space');

    return {
      ok: true,
      roomId,
      isSpace: true,
      summary: this.getSpaceSummary(roomId) || {
        spaceId: roomId,
        name: spaceName,
        permalink: `https://matrix.to/#/${roomId}`,
      },
    };
  }

  async createSpaceChild(
    parentSpaceId,
    {
      name,
      topic = '',
      isSpace = false,
      access = 'restricted',
      encryption = false,
      forumLayout = false,
      knock = false,
      allowFederation = true,
      aliasLocalPart = '',
      roomVersion = null,
    } = {},
  ) {
    if (!this.client) throw new Error('Not logged in');
    const parentId = String(parentSpaceId || '').trim();
    const parent = this.client.getRoom(parentId);
    if (!parent || !this.isSpaceLikeRoom(parent)) throw new Error('Parent space not found');
    if (!this.isJoinedRoom(parent)) throw new Error('Join the parent space first');

    const childName = String(name || '').trim();
    if (!childName) throw new Error(isSpace ? 'Space name is required' : 'Room name is required');
    const childTopic = String(topic || '').trim();
    const accessKind = String(access || 'restricted').toLowerCase();
    const wantPublic = accessKind === 'public';
    const wantRestricted = accessKind === 'restricted';
    const wantKnock = Boolean(knock) && !wantPublic;
    const wantEncryption = Boolean(encryption) && !wantPublic;
    const wantForum = Boolean(forumLayout);
    const federate = allowFederation !== false;
    const alias = String(aliasLocalPart || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9._=-]/g, '');

    const via = [];
    try {
      const hs = String(this.client.getDomain?.() || this.client.getHomeserverUrl?.() || '')
        .replace(/^https?:\/\//i, '')
        .split('/')[0]
        .split(':')[0];
      if (hs) via.push(hs);
    } catch {
      // ignore
    }

    const initial_state = [
      {
        type: 'm.room.guest_access',
        state_key: '',
        content: { guest_access: 'can_join' },
      },
      {
        type: 'm.room.history_visibility',
        state_key: '',
        content: { history_visibility: 'shared' },
      },
      {
        type: 'm.space.parent',
        state_key: parentId,
        content: { ...(via.length ? { via } : {}), canonical: true },
      },
    ];

    if (childTopic) {
      initial_state.push({
        type: 'm.room.topic',
        state_key: '',
        content: { topic: childTopic },
      });
    }

    if (wantEncryption) {
      initial_state.push({
        type: 'm.room.encryption',
        state_key: '',
        content: { algorithm: 'm.megolm.v1.aes-sha2' },
      });
    }

    if (wantRestricted) {
      initial_state.push({
        type: 'm.room.join_rules',
        state_key: '',
        content: {
          join_rule: wantKnock ? 'knock_restricted' : 'restricted',
          allow: [{ type: 'm.room_membership', room_id: parentId }],
        },
      });
    } else if (wantPublic) {
      initial_state.push({
        type: 'm.room.join_rules',
        state_key: '',
        content: { join_rule: 'public' },
      });
    } else {
      initial_state.push({
        type: 'm.room.join_rules',
        state_key: '',
        content: { join_rule: wantKnock ? 'knock' : 'invite' },
      });
    }

    if (wantForum) {
      initial_state.push({
        type: 'im.paarrot.room.kind',
        state_key: '',
        content: { kind: isSpace ? 'forum_space' : 'forum' },
      });
    }

    const creation_content = {};
    if (wantForum) {
      creation_content.type = 'm.forum';
    } else if (isSpace) {
      creation_content.type = 'm.space';
    }
    if (!federate) {
      creation_content['m.federate'] = false;
    }

    const createOpts = {
      name: childName,
      topic: childTopic || undefined,
      visibility: wantPublic ? 'public' : 'private',
      preset: wantPublic ? 'public_chat' : 'private_chat',
      initial_state,
    };
    if (Object.keys(creation_content).length) {
      createOpts.creation_content = creation_content;
    }
    if (wantPublic && alias) {
      createOpts.room_alias_name = alias;
    }
    if (roomVersion) {
      createOpts.room_version = String(roomVersion);
    }
    if (isSpace) {
      createOpts.power_level_content_override = { events_default: 100, invite: 50 };
    } else if (wantForum) {
      createOpts.power_level_content_override = { invite: 50 };
    }

    const result = await this.client.createRoom(createOpts);
    const roomId = result?.room_id || result?.roomId;
    if (!roomId) throw new Error(isSpace ? 'Failed to create space' : 'Failed to create room');

    const childContent = {
      auto_join: false,
      suggested: false,
      ...(via.length ? { via } : {}),
    };
    await this.client.sendStateEvent(parentId, 'm.space.child', childContent, roomId);

    const createdRoom = this.client.getRoom(roomId);
    const isCreatedSpace = Boolean(isSpace) || (wantForum && isSpace);
    let room = null;
    if (!isCreatedSpace) {
      room = createdRoom
        ? this.serializeRoom(createdRoom)
        : {
            roomId,
            name: childName,
            topic: childTopic || '',
            unread: 0,
            lastEventTs: Date.now(),
            encrypted: Boolean(encryption) && !wantPublic,
            isSpace: false,
            isDirect: false,
            permalink: `https://matrix.to/#/${roomId}`,
            avatarUrl: null,
            hasAvatar: false,
            memberCount: 1,
            joinRule: wantPublic ? 'public' : wantRestricted ? 'restricted' : 'invite',
          };
      if (room && room.name !== childName) room = { ...room, name: childName };
    }

    return {
      ok: true,
      roomId,
      parentSpaceId: parentId,
      isSpace: isCreatedSpace,
      isForum: wantForum && Boolean(isSpace),
      name: childName,
      room,
    };
  }

  async addPaarrotSubRoom(parentRoomId, childRoomId) {
    if (!this.client) throw new Error('Not logged in');
    const parent = this.client.getRoom(parentRoomId);
    if (!parent || this.isSpaceRoom(parent)) throw new Error('Parent room not found');
    if (!this.isJoinedRoom(parent)) throw new Error('Join the parent room first');
    const existing = this.getPaarrotSubRoomIds(parent);
    if (existing.includes(childRoomId)) return { ok: true, children: existing };
    const children = [...existing, childRoomId];
    await this.client.sendStateEvent(parentRoomId, 'im.paarrot.sub_rooms', { children }, '');
    return { ok: true, children };
  }

  async createSubRoom(parentRoomId, { name, topic = '', spaceId = null } = {}) {
    if (!this.client) throw new Error('Not logged in');
    const parentId = String(parentRoomId || '').trim();
    const parent = this.client.getRoom(parentId);
    if (!parent || this.isSpaceRoom(parent)) throw new Error('Parent room not found');
    if (!this.isJoinedRoom(parent)) throw new Error('Join the parent room first');

    const childName = String(name || '').trim();
    if (!childName) throw new Error('Room name is required');
    const childTopic = String(topic || '').trim();

    const space =
      spaceId && String(spaceId).startsWith('!')
        ? this.client.getRoom(String(spaceId))
        : null;
    const parentSpace =
      space && this.isSpaceRoom(space) && this.isJoinedRoom(space) ? space : null;

    const initial_state = [
      {
        type: 'm.room.guest_access',
        state_key: '',
        content: { guest_access: 'can_join' },
      },
      {
        type: 'm.room.history_visibility',
        state_key: '',
        content: { history_visibility: 'shared' },
      },
    ];
    if (childTopic) {
      initial_state.push({
        type: 'm.room.topic',
        state_key: '',
        content: { topic: childTopic },
      });
    }
    if (parentSpace) {
      initial_state.push({
        type: 'm.room.join_rules',
        state_key: '',
        content: {
          join_rule: 'restricted',
          allow: [{ type: 'm.room_membership', room_id: parentSpace.roomId }],
        },
      });
    }

    const result = await this.client.createRoom({
      name: childName,
      topic: childTopic || undefined,
      preset: 'private_chat',
      visibility: 'private',
      initial_state,
    });
    const roomId = result?.room_id || result?.roomId;
    if (!roomId) throw new Error('Failed to create room');

    const via = [];
    try {
      const hs = String(this.client.getDomain?.() || this.client.getHomeserverUrl?.() || '')
        .replace(/^https?:\/\//i, '')
        .split('/')[0]
        .split(':')[0];
      if (hs) via.push(hs);
    } catch {
      // ignore
    }
    const childContent = via.length ? { via } : {};

    if (parentSpace) {
      try {
        await this.client.sendStateEvent(
          parentSpace.roomId,
          'm.space.child',
          childContent,
          roomId,
        );
      } catch {
        // Space link best-effort; sub-room nesting still works via im.paarrot.sub_rooms.
      }
      try {
        await this.client.sendStateEvent(
          roomId,
          'm.space.parent',
          { ...(via.length ? { via } : {}), canonical: true },
          parentSpace.roomId,
        );
      } catch {
        // ignore
      }
    }

    await this.addPaarrotSubRoom(parentId, roomId);

    return {
      ok: true,
      roomId,
      parentRoomId: parentId,
      parentSpaceId: parentSpace?.roomId || null,
      isSpace: false,
      isSubRoom: true,
      name: childName,
    };
  }

  /**
   * Browse public rooms/spaces on a remote homeserver directory.
   * Does not default to the user's own homeserver — callers pick the server.
   */
  async explorePublicRooms({
    server,
    term = '',
    limit = 24,
    since = null,
    roomTypes,
  } = {}) {
    if (!this.client) throw new Error('Not logged in');
    const serverName = String(server || '')
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/\/+$/, '')
      .split('/')[0];
    if (!serverName) throw new Error('Server is required');

    const opts = {
      server: serverName,
      limit: Math.min(Math.max(Number(limit) || 24, 1), 100),
    };
    if (since) opts.since = String(since);

    const filter = {};
    const search = String(term || '').trim();
    if (search) filter.generic_search_term = search;
    if (Array.isArray(roomTypes)) filter.room_types = roomTypes;
    if (Object.keys(filter).length) opts.filter = filter;

    const result = await this.client.publicRooms(opts);
    const rooms = (result?.chunk || []).map((room) => {
      const avatarMxc = room?.avatar_url || null;
      let avatarHttp = null;
      if (avatarMxc && typeof this.client.mxcUrlToHttp === 'function') {
        try {
          avatarHttp =
            this.client.mxcUrlToHttp(avatarMxc, 96, 96, 'crop', false, true, true) || null;
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

    return {
      server: serverName,
      rooms,
      nextBatch: result?.next_batch || null,
      total: result?.total_room_count_estimate ?? null,
    };
  }

  /**
   * Join a room/space by room ID, alias (#room:server), or matrix.to link.
   */
  async joinByIdOrAlias(raw, { autoJoinSpaceRooms = false } = {}) {
    if (!this.client) throw new Error('Not logged in');
    let value = String(raw || '').trim();
    if (!value) throw new Error('Room ID, alias, or link is required');

    const matrixTo = value.match(/matrix\.to\/#\/([^?/\s]+)/i);
    if (matrixTo) {
      value = decodeURIComponent(matrixTo[1]);
    }

    // Accept bare local aliases by appending HS domain when possible.
    if (value.startsWith('#') && !value.includes(':')) {
      const userId = this.client.getUserId() || '';
      const domain = userId.includes(':') ? userId.split(':').slice(1).join(':') : '';
      if (domain) value = `${value}:${domain}`;
    }

    if (!(value.startsWith('!') || value.startsWith('#') || value.startsWith('@'))) {
      // Allow pasting room IDs without bang in rare cases — still try joinRoom
    }

    const room = await this.client.joinRoom(value);
    const roomId = room?.roomId || value;
    const joined = this.client.getRoom(roomId) || room;
    const isSpace = joined ? this.isSpaceRoom(joined) : false;
    const joinedChildren = [];

    if (isSpace && autoJoinSpaceRooms) {
      for (const childId of this.getSpaceChildIds(joined)) {
        const child = this.client.getRoom(childId);
        if (child && this.isSpaceRoom(child)) continue;
        const membership = child?.getMyMembership?.();
        if (membership === 'join') continue;
        try {
          await this.client.joinRoom(childId);
          joinedChildren.push(childId);
          try {
            await this.setRoomMuted(childId, true);
          } catch {
            // optional: Mentions-style quieter notifications
          }
        } catch {
          // skip rooms we cannot join (invite-only / knock / etc.)
        }
      }
    }

    return {
      ok: true,
      roomId,
      isSpace,
      joinedChildren,
      summary: joined
        ? isSpace
          ? this.getSpaceSummary(roomId)
          : this.getRoomSummary(roomId)
        : null,
    };
  }

  getRoomSummary(roomId) {
    if (!this.client) return null;
    const room = this.client.getRoom(roomId);
    if (!room || this.isSpaceRoom(room)) return null;
    const directIds = this.getDirectRoomIdSet();
    const summary = this.serializeRoom(room, { isDirect: directIds.has(room.roomId) });
    return {
      ...summary,
      spaceFilter: this.findSpaceFilterForRoom(roomId),
    };
  }

  getPinnedEventIds(room) {
    if (!room) return [];
    try {
      const event = room.currentState?.getStateEvents?.('m.room.pinned_events', '');
      const pinned = event?.getContent?.()?.pinned;
      return Array.isArray(pinned) ? pinned.filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  canPinEvents(room) {
    const myId = this.client?.getUserId?.();
    if (!room || !myId) return false;
    try {
      return Boolean(room.currentState?.maySendStateEvent?.('m.room.pinned_events', myId));
    } catch {
      return false;
    }
  }

  async resolveRoomEvent(room, eventId) {
    if (!room || !eventId || !this.client) return null;
    let event = null;
    try {
      event = room.findEventById?.(eventId) || null;
    } catch {
      event = null;
    }
    if (event) return event;

    try {
      const raw = await this.client.fetchRoomEvent(room.roomId, eventId);
      if (!raw) return null;
      const sdk = await loadSdk();
      event = new sdk.MatrixEvent(raw);
      if (typeof this.client.decryptEventIfNeeded === 'function') {
        try {
          await this.client.decryptEventIfNeeded(event);
        } catch {
          // leave encrypted placeholder
        }
      }
      return event;
    } catch {
      return null;
    }
  }

  serializePinnedMessage(room, event) {
    if (!room || !event) return null;
    const myId = this.client?.getUserId?.();
    const eventId = event.getId?.();
    if (!eventId) return null;

    if (typeof event.isRedacted === 'function' && event.isRedacted()) {
      return {
        eventId,
        missing: false,
        redacted: true,
        sender: event.getSender?.() || null,
        senderName: 'Unknown',
        senderAvatarUrl: null,
        hasSenderAvatar: false,
        senderStyle: null,
        isMine: false,
        canUnpin: this.canPinEvents(room),
        ts: event.getTs?.() || 0,
        body: 'Message deleted',
        html: null,
        msgtype: null,
        imageUrl: null,
        urls: [],
        encrypted: false,
      };
    }

    const type = event.getType?.();
    const encrypted = Boolean(event.isEncrypted?.() || type === 'm.room.encrypted');
    const content = event.getContent?.() || {};
    const sender = event.getSender?.();
    const msgtype = content.msgtype || null;
    const body = typeof content.body === 'string' ? content.body : null;
    const formattedBody =
      typeof content.formatted_body === 'string' && content.formatted_body.trim()
        ? content.formatted_body
        : null;
    const filename =
      (typeof content.filename === 'string' && content.filename) || body || 'file';
    const mime = (typeof content.info?.mimetype === 'string' && content.info.mimetype) || '';

    let imageUrl = null;
    let imageFullUrl = null;
    if (msgtype === 'm.image' && content.url && this.client) {
      const useOriginal = this.prefersOriginalImageMedia(mime, filename);
      const resolved = this.resolveMediaHttp(content.url, { preferOriginal: useOriginal });
      imageUrl = resolved.url;
      imageFullUrl = resolved.fullUrl;
    }

    return {
      eventId,
      missing: false,
      redacted: false,
      type,
      sender,
      senderName: this.getMemberDisplayName(room, sender),
      senderAvatarUrl: this.getLocalProfileAvatarPath(sender, 96),
      hasSenderAvatar: Boolean(this.getProfileAvatarRemoteUrl(sender, 48)),
      senderStyle: this.getCachedProfileStyle(sender),
      senderPresence: this.getUserPresence(sender) || 'offline',
      senderOnline: this.getUserPresence(sender) === 'online',
      isMine: Boolean(myId && sender === myId),
      canUnpin: this.canPinEvents(room),
      ts: event.getTs?.() || 0,
      body,
      html: formattedBody,
      msgtype,
      imageUrl,
      imageFullUrl,
      urls:
        typeof body === 'string' && msgtype !== 'm.image' && msgtype !== 'm.video'
          ? extractUrls(body, { limit: 2 })
          : [],
      encrypted,
    };
  }

  async listPinnedMessages(roomId) {
    if (!this.client) throw new Error('Not logged in');
    const room = this.client.getRoom(roomId);
    if (!room) throw new Error('Room not found');

    const eventIds = this.getPinnedEventIds(room);
    const newestFirst = [...eventIds].reverse();
    const pinned = [];

    for (const eventId of newestFirst) {
      const event = await this.resolveRoomEvent(room, eventId);
      if (!event) {
        pinned.push({
          eventId,
          missing: true,
          redacted: false,
          sender: null,
          senderName: 'Unavailable',
          senderAvatarUrl: null,
          hasSenderAvatar: false,
          senderStyle: null,
          isMine: false,
          canUnpin: this.canPinEvents(room),
          ts: 0,
          body: 'Pinned message is no longer available',
          html: null,
          msgtype: null,
          imageUrl: null,
          urls: [],
          encrypted: false,
        });
        continue;
      }
      const serialized = this.serializePinnedMessage(room, event);
      if (serialized) pinned.push(serialized);
    }

    return {
      ok: true,
      roomId,
      eventIds,
      pinnedCount: eventIds.length,
      canPin: this.canPinEvents(room),
      pinned,
    };
  }

  async searchMessages({ term, roomIds = null, limit = 40 } = {}) {
    if (!this.client) throw new Error('Not logged in');
    const query = String(term || '').trim();
    if (!query) return { ok: true, term: '', count: 0, results: [] };

    const roomsFilter =
      Array.isArray(roomIds) && roomIds.length > 0 ? { rooms: roomIds.slice(0, 40) } : undefined;

    try {
      const raw = await this.client.searchRoomEvents({
        term: query,
        filter: roomsFilter,
      });
      const hits = Array.isArray(raw?.results) ? raw.results : [];
      const results = [];
      for (const hit of hits.slice(0, Math.max(1, Math.min(80, limit)))) {
        const ev =
          (typeof hit?.context?.getEvent === 'function' && hit.context.getEvent()) ||
          hit?.result ||
          null;
        if (!ev || typeof ev.getId !== 'function') continue;
        if (typeof ev.isRedacted === 'function' && ev.isRedacted()) continue;
        const type = ev.getType?.();
        if (type && type !== 'm.room.message' && type !== 'm.room.encrypted') continue;
        const content = ev.getContent?.() || {};
        const body = typeof content.body === 'string' ? content.body : '';
        const roomId = ev.getRoomId?.() || null;
        const sender = ev.getSender?.();
        const room = roomId ? this.client.getRoom(roomId) : null;
        results.push({
          eventId: ev.getId(),
          roomId,
          roomName: room?.name || roomId || 'Room',
          sender,
          senderName: room ? this.getMemberDisplayName(room, sender) : sender,
          senderAvatarUrl: this.getLocalProfileAvatarPath(sender, 96),
          hasSenderAvatar: Boolean(this.getProfileAvatarRemoteUrl(sender, 48)),
          senderStyle: this.getCachedProfileStyle(sender),
          ts: ev.getTs?.() || 0,
          body,
          encrypted: Boolean(ev.isEncrypted?.() || type === 'm.room.encrypted'),
        });
      }
      return {
        ok: true,
        term: query,
        count: typeof raw?.count === 'number' ? raw.count : results.length,
        results,
        source: 'homeserver',
      };
    } catch (error) {
      // Fallback: scan loaded timelines locally (covers E2EE / search-disabled HS).
      const local = this.searchMessagesLocal({ term: query, roomIds, limit });
      return {
        ...local,
        warning: error?.message || String(error),
      };
    }
  }

  searchMessagesLocal({ term, roomIds = null, limit = 40 } = {}) {
    if (!this.client) throw new Error('Not logged in');
    const query = String(term || '').trim().toLowerCase();
    if (!query) return { ok: true, term: '', count: 0, results: [], source: 'local' };

    const wanted =
      Array.isArray(roomIds) && roomIds.length > 0 ? new Set(roomIds) : null;
    const rooms = (this.client.getRooms?.() || []).filter((room) => {
      if (!this.isJoinedRoom(room) || this.isSpaceRoom(room)) return false;
      if (!wanted) return true;
      return wanted.has(room.roomId);
    });

    const results = [];
    for (const room of rooms) {
      const events = room.getLiveTimeline?.()?.getEvents?.() || [];
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const ev = events[i];
        if (!ev || (typeof ev.isRedacted === 'function' && ev.isRedacted())) continue;
        const type = ev.getType?.();
        if (type !== 'm.room.message') continue;
        const content = ev.getContent?.() || {};
        const body = typeof content.body === 'string' ? content.body : '';
        if (!body.toLowerCase().includes(query)) continue;
        const sender = ev.getSender?.();
        results.push({
          eventId: ev.getId(),
          roomId: room.roomId,
          roomName: room.name || room.roomId,
          sender,
          senderName: this.getMemberDisplayName(room, sender),
          senderAvatarUrl: this.getLocalProfileAvatarPath(sender, 96),
          hasSenderAvatar: Boolean(this.getProfileAvatarRemoteUrl(sender, 48)),
          senderStyle: this.getCachedProfileStyle(sender),
          ts: ev.getTs?.() || 0,
          body,
          encrypted: false,
        });
        if (results.length >= limit) break;
      }
      if (results.length >= limit) break;
    }

    results.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return {
      ok: true,
      term: String(term || '').trim(),
      count: results.length,
      results,
      source: 'local',
    };
  }

  async setEventPinned(roomId, eventId, pinned) {
    if (!this.client) throw new Error('Not logged in');
    const room = this.client.getRoom(roomId);
    if (!room) throw new Error('Room not found');
    const id = String(eventId || '').trim();
    if (!id) throw new Error('Missing event id');
    if (!this.canPinEvents(room)) throw new Error('You cannot change pinned messages');

    const current = this.getPinnedEventIds(room);
    const next = pinned
      ? [...current.filter((entry) => entry !== id), id]
      : current.filter((entry) => entry !== id);

    await this.client.sendStateEvent(roomId, 'm.room.pinned_events', { pinned: next }, '');
    return {
      ok: true,
      roomId,
      eventIds: next,
      pinnedCount: next.length,
      pinned: Boolean(pinned),
    };
  }

  async listRoomMembers(roomId) {
    if (!this.client) throw new Error('Not logged in');
    const room = this.client.getRoom(roomId);
    if (!room) throw new Error('Room not found');
    if (typeof room.loadMembersIfNeeded === 'function') {
      try {
        await room.loadMembersIfNeeded();
      } catch {
        // use whatever is already loaded
      }
    }

    const joined =
      typeof room.getJoinedMembers === 'function' ? room.getJoinedMembers() : [];
    const members = joined
      .map((member) => {
        const userId = member?.userId;
        if (!userId) return null;
        const powerLevel = this.getMemberPowerLevel(room, userId);
        const presence = this.getUserPresence(userId) || 'offline';
        const avatarMxc =
          (typeof member.getMxcAvatarUrl === 'function' && member.getMxcAvatarUrl()) ||
          this.getProfileAvatarRemoteUrl?.(userId, 48) ||
          null;
        return {
          userId,
          displayName: this.getMemberDisplayName(room, userId),
          avatarUrl: this.getLocalProfileAvatarPath(userId, 96),
          hasAvatar: Boolean(avatarMxc),
          presence,
          online: presence === 'online',
          role: this.roleFromPowerLevel(powerLevel),
          powerLevel,
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (b.powerLevel !== a.powerLevel) return b.powerLevel - a.powerLevel;
        return String(a.displayName).localeCompare(String(b.displayName), undefined, {
          sensitivity: 'base',
        });
      });

    return {
      ok: true,
      roomId,
      count: members.length,
      pinnedCount: this.getPinnedEventIds(room).length,
      members,
    };
  }

  async setRoomMuted(roomId, muted) {
    if (!this.client) throw new Error('Not logged in');
    if (typeof this.client.setRoomMutePushRule === 'function') {
      await this.client.setRoomMutePushRule('global', roomId, Boolean(muted));
      return { ok: true, roomId, muted: Boolean(muted) };
    }
    throw new Error('Mute is not supported by this Matrix SDK build');
  }

  async setRoomNotificationLevel(roomId, level) {
    if (!this.client) throw new Error('Not logged in');
    const id = String(roomId || '').trim();
    if (!id) throw new Error('Room id required');
    const mode = String(level || 'all').toLowerCase();
    if (!['all', 'mentions', 'mute'].includes(mode)) {
      throw new Error('Level must be all, mentions, or mute');
    }
    // Mute uses the dedicated Matrix push helper; mentions/all clear mute and
    // rely on client-side filtering for mentions-only (desktop alerts).
    if (typeof this.client.setRoomMutePushRule === 'function') {
      await this.client.setRoomMutePushRule('global', id, mode === 'mute');
    }
    return { ok: true, roomId: id, level: mode };
  }

  async updateRoomProfile(roomId, { name, topic, joinRule } = {}) {
    if (!this.client) throw new Error('Not logged in');
    const room = this.client.getRoom(roomId);
    if (!room || !this.isJoinedRoom(room)) throw new Error('Room not found');
    const updates = {};
    if (typeof name === 'string') {
      const next = name.trim();
      if (!next) throw new Error('Room name is required');
      await this.client.sendStateEvent(roomId, 'm.room.name', { name: next }, '');
      updates.name = next;
    }
    if (typeof topic === 'string') {
      const next = topic.trim();
      await this.client.sendStateEvent(roomId, 'm.room.topic', { topic: next }, '');
      updates.topic = next;
    }
    if (typeof joinRule === 'string' && joinRule.trim()) {
      const rule = joinRule.trim();
      await this.client.sendStateEvent(roomId, 'm.room.join_rules', { join_rule: rule }, '');
      updates.joinRule = rule;
    }
    return { ok: true, roomId, ...updates, room: this.serializeRoom(room) };
  }

  async uploadRoomAvatar(roomId, dataUrl) {
    if (!this.client) throw new Error('Not logged in');
    const id = String(roomId || '').trim();
    const room = this.client.getRoom(id);
    if (!room || !this.isJoinedRoom(room)) throw new Error('Room not found');

    const match = /^data:([^;]+);base64,(.+)$/s.exec(String(dataUrl || ''));
    if (!match) throw new Error('Invalid image data');
    const buffer = Buffer.from(match[2], 'base64');
    const contentType = this.normalizeImageContentType(match[1] || 'image/png', '', buffer);
    const ext =
      contentType === 'image/jpeg'
        ? 'jpg'
        : contentType === 'image/gif'
          ? 'gif'
          : contentType === 'image/webp'
            ? 'webp'
            : contentType === 'image/apng'
              ? 'apng'
              : contentType === 'image/avif'
                ? 'avif'
                : 'png';
    const upload = await this.client.uploadContent(buffer, {
      type: contentType === 'image/apng' ? 'image/png' : contentType,
      name: `room-avatar.${ext}`,
      rawResponse: false,
    });
    const mxc = typeof upload === 'string' ? upload : upload?.content_uri;
    if (!mxc) throw new Error('Upload failed');

    await this.client.sendStateEvent(id, 'm.room.avatar', { url: mxc }, '');
    return {
      ok: true,
      roomId: id,
      mxc,
      room: this.serializeRoom(room),
    };
  }

  async removeRoomAvatar(roomId) {
    if (!this.client) throw new Error('Not logged in');
    const id = String(roomId || '').trim();
    const room = this.client.getRoom(id);
    if (!room || !this.isJoinedRoom(room)) throw new Error('Room not found');
    // Empty content clears m.room.avatar (same pattern as removing space children).
    await this.client.sendStateEvent(id, 'm.room.avatar', {}, '');
    return { ok: true, roomId: id, room: this.serializeRoom(room) };
  }

  async moderateMember(roomId, userId, action, { reason } = {}) {
    if (!this.client) throw new Error('Not logged in');
    const room = this.client.getRoom(roomId);
    if (!room || !this.isJoinedRoom(room)) throw new Error('Room not found');
    const user = String(userId || '').trim();
    if (!user.startsWith('@')) throw new Error('Full Matrix user id required');
    const act = String(action || '').toLowerCase();
    const why = typeof reason === 'string' ? reason.trim() : undefined;
    if (act === 'kick') {
      await this.client.kick(roomId, user, why);
    } else if (act === 'ban') {
      await this.client.ban(roomId, user, why);
    } else if (act === 'unban') {
      await this.client.unban(roomId, user);
    } else {
      throw new Error('Action must be kick, ban, or unban');
    }
    return { ok: true, roomId, userId: user, action: act };
  }

  listRoomThreads(roomId) {
    if (!this.client) throw new Error('Not logged in');
    const room = this.client.getRoom(roomId);
    if (!room || !this.isJoinedRoom(room)) throw new Error('Room not found');
    const threads = [];
    const seen = new Set();

    const pushThread = (rootEvent, replyCount = 0, latestTs = null) => {
      if (!rootEvent) return;
      const eventId = rootEvent.getId?.();
      if (!eventId || seen.has(eventId)) return;
      if (typeof rootEvent.isRedacted === 'function' && rootEvent.isRedacted()) return;
      seen.add(eventId);
      const content = rootEvent.getContent?.() || {};
      const body =
        typeof content.body === 'string'
          ? content.body.replace(/\s+/g, ' ').trim().slice(0, 140)
          : '';
      const sender = rootEvent.getSender?.() || '';
      threads.push({
        rootEventId: eventId,
        body: body || 'Thread',
        sender,
        senderName: this.getMemberDisplayName(room, sender),
        replyCount: Number(replyCount) || 0,
        latestTs: latestTs || rootEvent.getTs?.() || 0,
        ts: rootEvent.getTs?.() || 0,
      });
    };

    try {
      const list = typeof room.getThreads === 'function' ? room.getThreads() : [];
      for (const thread of list || []) {
        const root = thread.rootEvent || room.findEventById?.(thread.id);
        const replyCount =
          typeof thread.length === 'number'
            ? Math.max(0, thread.length - 1)
            : (thread.events || []).length;
        const latest =
          thread.replyToEvent?.getTs?.() ||
          thread.events?.[thread.events.length - 1]?.getTs?.() ||
          null;
        pushThread(root, replyCount, latest);
      }
    } catch {
      // fall through to timeline scan
    }

    const replyCounts = new Map();
    for (const event of room.getLiveTimeline?.().getEvents?.() || []) {
      if (event.getType?.() !== 'm.room.message') continue;
      if (typeof event.isRedacted === 'function' && event.isRedacted()) continue;
      const relates = event.getContent?.()?.['m.relates_to'] || {};
      if (relates.rel_type !== 'm.thread') continue;
      const rootId = String(relates.event_id || '');
      if (!rootId) continue;
      const prev = replyCounts.get(rootId) || { count: 0, latestTs: 0 };
      prev.count += 1;
      prev.latestTs = Math.max(prev.latestTs, event.getTs?.() || 0);
      replyCounts.set(rootId, prev);
    }
    for (const [rootId, meta] of replyCounts) {
      if (seen.has(rootId)) {
        const existing = threads.find((t) => t.rootEventId === rootId);
        if (existing) {
          existing.replyCount = Math.max(existing.replyCount, meta.count);
          existing.latestTs = Math.max(existing.latestTs, meta.latestTs);
        }
        continue;
      }
      pushThread(room.findEventById?.(rootId), meta.count, meta.latestTs);
    }

    threads.sort((a, b) => (b.latestTs || 0) - (a.latestTs || 0));
    return { ok: true, roomId, threads };
  }

  async forwardMessage(sourceRoomId, eventId, targetRoomId) {
    if (!this.client) throw new Error('Not logged in');
    const sourceRoom = this.client.getRoom(sourceRoomId);
    const targetRoom = this.client.getRoom(targetRoomId);
    if (!sourceRoom || !this.isJoinedRoom(sourceRoom)) throw new Error('Source room not found');
    if (!targetRoom || !this.isJoinedRoom(targetRoom)) throw new Error('Target room not found');
    const id = String(eventId || '').trim();
    if (!id) throw new Error('Event id required');
    const event = sourceRoom.findEventById?.(id);
    if (!event) throw new Error('Message not found in timeline');
    if (typeof event.isRedacted === 'function' && event.isRedacted()) {
      throw new Error('Cannot forward a deleted message');
    }
    const content = { ...(event.getContent?.() || {}) };
    delete content['m.relates_to'];
    delete content['m.new_content'];
    const msgtype = content.msgtype || 'm.text';
    if (!content.body && msgtype === 'm.text') {
      throw new Error('Nothing to forward');
    }
    const sender = event.getSender?.() || '';
    const senderName = this.getMemberDisplayName(sourceRoom, sender);
    if (typeof content.body === 'string' && content.body.trim()) {
      content.body = `Forwarded from ${senderName}:\n${content.body}`;
      if (typeof content.formatted_body === 'string') {
        content.formatted_body = `<p><em>Forwarded from ${this.escapeHtml(
          senderName,
        )}</em></p>${content.formatted_body}`;
        content.format = 'org.matrix.custom.html';
      }
    }
    const sent = await this.client.sendEvent(targetRoomId, 'm.room.message', content);
    return {
      ok: true,
      sourceRoomId,
      targetRoomId,
      eventId: sent?.event_id || sent?.eventId || null,
    };
  }

  escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async startDeviceVerification(deviceId) {
    if (!this.client) throw new Error('Not logged in');
    const id = String(deviceId || '').trim();
    if (!id) throw new Error('Device id required');
    const crypto = this.client.getCrypto?.();
    if (!crypto) throw new Error('Crypto is not available');
    const myId = this.client.getUserId();
    if (!myId) throw new Error('Not logged in');

    if (typeof crypto.requestDeviceVerification !== 'function') {
      // Fallback to cross-signing when interactive SAS is unavailable.
      await this.verifyDevice(id);
      return { ok: true, mode: 'cross-sign', deviceId: id };
    }

    const request = await crypto.requestDeviceVerification(myId, id);
    this._pendingVerification = { request, deviceId: id, userId: myId };
    if (typeof request.accept === 'function') {
      try {
        await request.accept();
      } catch {
        // other side may accept
      }
    }

    const waitForVerifier = async () => {
      if (request.verifier) return request.verifier;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Verification timed out')), 120000);
        const onChange = () => {
          if (request.verifier) {
            clearTimeout(timer);
            request.off?.('change', onChange);
            resolve(request.verifier);
          }
          if (request.phase === 'done' || request.cancelled || request.done) {
            clearTimeout(timer);
            request.off?.('change', onChange);
            reject(new Error('Verification ended before SAS'));
          }
        };
        request.on?.('change', onChange);
        onChange();
      });
    };

    const verifier = await waitForVerifier();
    let sasPayload = null;
    const sasPromise = new Promise((resolve) => {
      const onSas = (sas) => {
        sasPayload = {
          emojis: Array.isArray(sas?.sas?.emoji)
            ? sas.sas.emoji.map((entry) => ({
                emoji: entry?.[0] || entry?.emoji || '',
                label: entry?.[1] || entry?.label || '',
              }))
            : [],
          decimals: sas?.sas?.decimal || null,
        };
        resolve(sasPayload);
      };
      if (typeof verifier.once === 'function') verifier.once('show_sas', onSas);
      else if (typeof verifier.on === 'function') verifier.on('show_sas', onSas);
      // Newer API uses VerifierEvent.ShowSas via typed emitter; also try camelCase.
      verifier.on?.('ShowSas', onSas);
    });

    // Kick off verify without awaiting — UI confirms SAS first.
    const verifyPromise = verifier.verify?.() || Promise.resolve();
    const sas = await Promise.race([
      sasPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Waiting for emoji SAS timed out')), 60000)),
    ]);

    this._pendingVerification = {
      request,
      verifier,
      verifyPromise,
      deviceId: id,
      userId: myId,
      sas,
    };
    return { ok: true, mode: 'sas', deviceId: id, sas };
  }

  async confirmDeviceVerification(match) {
    const pending = this._pendingVerification;
    if (!pending?.verifier) throw new Error('No verification in progress');
    const verifier = pending.verifier;
    try {
      if (match) {
        if (typeof verifier.sasAgreement === 'function') await verifier.sasAgreement(true);
        else if (typeof pending.request?.verifier?.sasAgreement === 'function') {
          await pending.request.verifier.sasAgreement(true);
        }
        // Some builds expose confirmSASMatch / continueAfterShowSas
        if (typeof verifier.confirmSASMatch === 'function') await verifier.confirmSASMatch();
        await pending.verifyPromise;
        try {
          await this.verifyDevice(pending.deviceId);
        } catch {
          // cross-sign may already be done by SAS success
        }
        this._pendingVerification = null;
        return { ok: true, matched: true, deviceId: pending.deviceId };
      }
      if (typeof verifier.cancel === 'function') await verifier.cancel('m.mismatched_sas');
      else if (typeof pending.request?.cancel === 'function') {
        await pending.request.cancel('m.mismatched_sas');
      }
      this._pendingVerification = null;
      return { ok: true, matched: false, deviceId: pending.deviceId };
    } catch (error) {
      this._pendingVerification = null;
      throw error;
    }
  }

  listSpaceSidebar(spaceId) {
    if (!this.client) return { groups: [], rooms: [] };
    const spaceRoom = this.client.getRoom(spaceId);
    if (!spaceRoom || !this.isSpaceLikeRoom(spaceRoom)) return { groups: [], rooms: [] };

    const directIds = this.getDirectRoomIdSet();
    const flatRooms = [];
    const seen = new Set();
    const placedRooms = new Set();
    const placedSections = new Set();
    const groups = [];
    let current = null;

    // Rooms claimed as im.paarrot.sub_rooms should not also appear as top-level hierarchy rows.
    const globalSubRoomIds = new Set();
    for (const room of this.client.getRooms() || []) {
      for (const childId of this.getPaarrotSubRoomIds(room)) {
        globalSubRoomIds.add(childId);
      }
    }

    const takeRoom = (room) => {
      if (!room || !this.isJoinedRoom(room) || this.isSpaceLikeRoom(room)) return null;
      if (seen.has(room.roomId)) {
        return flatRooms.find((entry) => entry.roomId === room.roomId) || null;
      }
      const item = this.serializeRoom(room, { isDirect: directIds.has(room.roomId) });
      seen.add(room.roomId);
      flatRooms.push(item);
      return item;
    };

    const sectionMeta = (space) => ({
      avatarUrl: this.getLocalAvatarPath(space.roomId, 48),
      hasAvatar: Boolean(this.getRoomAvatarUrl(space, 48)),
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
      const childIds = this.getPaarrotSubRoomIds(parentRoom);
      childIds.forEach((childId, index) => {
        if (placedRooms.has(childId)) return;
        const child = this.client.getRoom(childId);
        if (!child || !this.isJoinedRoom(child) || this.isSpaceLikeRoom(child)) return;
        pushRoomItem(child, { depth: depth + 1 });
        addSubRooms(child, depth + 1);
      });
    };

    // Paarrot Space.tsx: nested spaces become their own nav categories; rooms fill the open section.
    const walkSpaceChildren = (parentSpace) => {
      for (const entry of this.getSpaceChildEntries(parentSpace)) {
        if (globalSubRoomIds.has(entry.roomId) && !this.isSpaceLikeRoom(this.client.getRoom(entry.roomId))) {
          continue;
        }
        const child = this.client.getRoom(entry.roomId);
        if (!child || !this.isJoinedRoom(child)) continue;
        if (this.isSpaceLikeRoom(child)) {
          if (placedSections.has(child.roomId)) continue;
          startSection(child, child.name || child.roomId, { suggested: entry.suggested });
          walkSpaceChildren(child);
          continue;
        }
        pushRoomItem(child, { suggested: entry.suggested, depth: 0 });
        addSubRooms(child, 0);
      }
    };

    for (const entry of this.getSpaceChildEntries(spaceRoom)) {
      const child = this.client.getRoom(entry.roomId);
      if (!child || !this.isJoinedRoom(child)) continue;
      if (this.isSpaceLikeRoom(child)) {
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

    // Keep empty nested categories so Discord-style "Create Category" stays visible.
    const pruned = groups.filter(
      (group) =>
        group.items.length > 0 ||
        group.spaceId === spaceId ||
        group.type === 'folder',
    );

    const parents = [...this.getJoinedParentSpaceIds(spaceRoom)]
      .filter((id) => id && id !== spaceId)
      .map((id) => {
        const parent = this.client.getRoom(id);
        return parent
          ? { spaceId: id, name: parent.name || id }
          : { spaceId: id, name: id };
      });

    return {
      groups: pruned,
      rooms: flatRooms,
      parents,
      space: this.getSpaceSummary(spaceId) || null,
    };
  }

  listRooms({ filter = 'home' } = {}) {
    if (!this.client) return [];

    const directIds = this.getDirectRoomIdSet();
    const rooms = this.client.getRooms() || [];
    let selectedChildIds = null;

    if (filter && filter.startsWith('!')) {
      const spaceRoom = this.client.getRoom(filter);
      // Include direct children + rooms under child spaces (one hierarchy pass).
      selectedChildIds = new Set();
      if (spaceRoom) {
        for (const entry of this.getSpaceChildEntries(spaceRoom)) {
          const child = this.client.getRoom(entry.roomId);
          if (!child) continue;
          if (this.isSpaceLikeRoom(child)) {
            for (const nested of this.getSpaceChildEntries(child)) {
              selectedChildIds.add(nested.roomId);
              const nestedRoom = this.client.getRoom(nested.roomId);
              if (nestedRoom && this.isSpaceLikeRoom(nestedRoom)) {
                for (const deep of this.getSpaceChildEntries(nestedRoom)) {
                  selectedChildIds.add(deep.roomId);
                }
              }
            }
          } else {
            selectedChildIds.add(entry.roomId);
          }
        }
      }
    }

    const spaceOrganizedIds =
      filter === 'dms' || filter === 'home' ? this.getSpaceOrganizedRoomIds() : null;

    return rooms
      .filter((room) => {
        if (!this.isJoinedRoom(room)) return false;
        if (this.isSpaceLikeRoom(room)) return false;

        if (filter === 'dms' || filter === 'home') {
          // Kitsu home (Direct Messages): DMs + orphan rooms not under a joined space.
          return (
            this.isDmSidebarRoom(room, spaceOrganizedIds) ||
            this.isHomeSidebarRoom(room, spaceOrganizedIds)
          );
        }

        if (selectedChildIds) {
          return selectedChildIds.has(room.roomId);
        }

        // Non-space filters: all joined channel rooms (excluding DMs on home).
        return true;
      })
      .map((room) =>
        this.serializeRoom(room, {
          isDirect: this.isDirectRoom(room),
        }),
      )
      .sort((a, b) => {
        const aVoice = Array.isArray(a.voiceMembers) && a.voiceMembers.length > 0 ? 1 : 0;
        const bVoice = Array.isArray(b.voiceMembers) && b.voiceMembers.length > 0 ? 1 : 0;
        if (bVoice !== aVoice) return bVoice - aVoice;
        return b.lastEventTs - a.lastEventTs;
      });
  }

  getMemberDisplayName(room, userId) {
    if (!userId) return 'unknown';
    try {
      const member = room?.getMember?.(userId);
      const memberName = member?.name || member?.rawDisplayName;
      if (memberName && memberName !== userId) return memberName;
    } catch {
      // ignore
    }
    try {
      const user = this.client?.getUser?.(userId);
      if (user?.displayName) return user.displayName;
    } catch {
      // ignore
    }
    if (userId.startsWith('@') && userId.includes(':')) {
      return userId.slice(1).split(':')[0] || userId;
    }
    return userId;
  }

  resolveMediaHttp(mxc, { preferOriginal = false } = {}) {
    if (!this.client || !mxc) return { url: null, fullUrl: null };
    try {
      const original =
        this.client.mxcUrlToHttp(mxc, undefined, undefined, undefined, false, true, true) || null;
      const thumb =
        this.client.mxcUrlToHttp(mxc, 1280, 1280, 'scale', false, true, true) || null;
      const large =
        this.client.mxcUrlToHttp(mxc, 2048, 2048, 'scale', false, true, true) ||
        original ||
        thumb;
      const url = preferOriginal ? original || large || thumb : thumb || large || original;
      return { url, fullUrl: original || large || url };
    } catch {
      return { url: null, fullUrl: null };
    }
  }

  parseMediaInfo(info) {
    if (!info || typeof info !== 'object') return null;
    return {
      width: Number(info.w) || null,
      height: Number(info.h) || null,
      size: Number(info.size) || null,
      duration: Number(info.duration) || null,
      mimeType: typeof info.mimetype === 'string' ? info.mimetype : null,
      blurhash:
        typeof info['xyz.amorgan.blurhash'] === 'string'
          ? info['xyz.amorgan.blurhash']
          : typeof info.blurhash === 'string'
            ? info.blurhash
            : null,
      thumbnailUrl: info.thumbnail_url || null,
    };
  }

  async getRoomTimeline(roomId, limit = 50) {
    if (!this.client) return [];
    const room = this.client.getRoom(roomId);
    if (!room) return [];

    const myId = this.client.getUserId();
    const events = room.getLiveTimeline().getEvents();
    const fetchCount = Math.max(1, Math.min(6000, (Number(limit) || 50) * 3));
    const slice = events.slice(-fetchCount);
    const out = [];
    const receiptsByEvent = this.getReadReceiptsByEventId(room);

    for (const event of slice) {
      await this.decryptTimelineEvent(event);
      const type = event.getType();
      const stillEncrypted =
        (typeof event.isEncrypted === 'function' && event.isEncrypted()) &&
        (type === 'm.room.encrypted' || !event.getContent()?.msgtype);
      const isRedacted =
        (typeof event.isRedacted === 'function' && event.isRedacted()) ||
        (typeof event.localRedactionEvent === 'function' && event.localRedactionEvent());
      if (typeof event.isRedaction === 'function' && event.isRedaction()) continue;
      if (type === 'm.room.redaction') continue;

      if (isRedacted) {
        const sender = event.getSender();
        out.push({
          eventId: event.getId(),
          type: type || 'm.room.message',
          sender,
          senderName: this.getMemberDisplayName(room, sender),
          senderAvatarUrl: this.getLocalProfileAvatarPath(sender, 96),
          hasSenderAvatar: Boolean(this.getProfileAvatarRemoteUrl(sender, 48)),
          senderStyle: this.getCachedProfileStyle(sender),
          senderPresence: this.getUserPresence(sender) || 'offline',
          senderOnline: this.getUserPresence(sender) === 'online',
          isMine: Boolean(myId && sender === myId),
          canRedact: false,
          ts: event.getTs(),
          body: null,
          html: null,
          msgtype: null,
          systemKind: null,
          encrypted: false,
          redacted: true,
          readBy: [],
        });
        continue;
      }

      if (type === 'm.room.member') {
        const content = event.getContent() || {};
        const prev = event.getPrevContent?.() || {};
        const targetId = event.getStateKey?.() || content?.state_key || '';
        const targetName = this.getMemberDisplayName(room, targetId) || targetId;
        const sender = event.getSender();
        const senderName = this.getMemberDisplayName(room, sender) || sender;
        let systemKind = 'membership';
        let systemAction = 'membership';
        let body = '';
        const membership = content.membership || '';
        const prevMembership = prev.membership || '';
        const displayChanged =
          (content.displayname || '') !== (prev.displayname || '') &&
          membership === prevMembership &&
          membership === 'join';
        const avatarChanged =
          (content.avatar_url || '') !== (prev.avatar_url || '') &&
          membership === prevMembership &&
          membership === 'join';

        if (displayChanged || avatarChanged) {
          systemKind = 'profile';
          systemAction = displayChanged && avatarChanged ? 'profile' : displayChanged ? 'profile_name' : 'profile_avatar';
          if (displayChanged && avatarChanged) body = `${targetName} updated their profile`;
          else if (displayChanged) body = `${targetName} changed their display name`;
          else body = `${targetName} changed their avatar`;
        } else if (membership === 'join' && prevMembership !== 'join') {
          systemAction = 'join';
          body = `${targetName} joined the room`;
        } else if (membership === 'leave' && prevMembership !== 'leave') {
          systemAction = sender === targetId ? 'leave' : 'kick';
          body =
            sender === targetId
              ? `${targetName} left the room`
              : `${senderName} removed ${targetName}`;
        } else if (membership === 'ban' && prevMembership !== 'ban') {
          systemAction = 'ban';
          body = `${senderName} banned ${targetName}`;
        } else if (membership === 'invite' && prevMembership !== 'invite') {
          systemAction = 'invite';
          body = `${senderName} invited ${targetName}`;
        } else {
          // Same membership with no profile change (e.g. "@user: join") — timeline noise.
          continue;
        }

        out.push({
          eventId: event.getId(),
          type,
          sender,
          senderName,
          senderAvatarUrl: null,
          hasSenderAvatar: false,
          senderStyle: null,
          isMine: Boolean(myId && sender === myId),
          canRedact: false,
          ts: event.getTs(),
          body,
          html: null,
          msgtype: null,
          systemKind,
          systemAction,
          systemTargetId: targetId || null,
          systemTargetName: targetName || null,
          encrypted: false,
          redacted: false,
          readBy: [],
        });
        continue;
      }

      if (type === 'm.room.name' || type === 'm.room.avatar' || type === 'm.room.topic') {
        const sender = event.getSender();
        const senderName = this.getMemberDisplayName(room, sender) || sender;
        const content = event.getContent() || {};
        let systemAction = 'room_state';
        let body = `${senderName} updated the room`;
        if (type === 'm.room.name') {
          systemAction = 'room_name';
          const name = typeof content.name === 'string' ? content.name.trim() : '';
          body = name
            ? `${senderName} changed the room name to ${name}`
            : `${senderName} changed the room name`;
        } else if (type === 'm.room.avatar') {
          systemAction = 'room_avatar';
          body = `${senderName} changed room avatar`;
        } else if (type === 'm.room.topic') {
          systemAction = 'room_topic';
          body = `${senderName} changed the room topic`;
        }
        out.push({
          eventId: event.getId(),
          type,
          sender,
          senderName,
          senderAvatarUrl: null,
          hasSenderAvatar: false,
          senderStyle: null,
          isMine: Boolean(myId && sender === myId),
          canRedact: false,
          ts: event.getTs(),
          body,
          html: null,
          msgtype: null,
          systemKind: 'room',
          systemAction,
          encrypted: false,
          redacted: false,
          readBy: [],
        });
        continue;
      }

      const encrypted = stillEncrypted || type === 'm.room.encrypted';
      if (type !== 'm.room.message' && !encrypted) continue;

      const content = event.getContent() || {};
      const relatesEarly = content['m.relates_to'] || {};
      if (relatesEarly.rel_type === 'm.replace') continue;

      const sender = event.getSender();
      const msgtype = content.msgtype || null;
      const body =
        encrypted && !msgtype
          ? '[Unable to decrypt]'
          : typeof content.body === 'string'
            ? content.body
            : null;
      const formattedBody =
        typeof content.formatted_body === 'string' && content.formatted_body.trim()
          ? content.formatted_body
          : null;
      const filename =
        typeof content.filename === 'string' && content.filename.trim()
          ? content.filename.trim()
          : null;
      const mime =
        (typeof content.info?.mimetype === 'string' && content.info.mimetype) || '';
      const spoiler = Boolean(
        content['page.codeberg.everypizza.msc4193.spoiler'] ||
          content['m.spoiler'] ||
          content.spoiler,
      );

      let imageUrl = null;
      let imageFullUrl = null;
      let imageMxc = null;
      let imageFilename = null;
      let imageInfo = null;
      let imageSpoiler = false;
      let videoUrl = null;
      let videoFullUrl = null;
      let videoMxc = null;
      let videoFilename = null;
      let videoInfo = null;
      let videoPosterUrl = null;
      let carousel = null;
      let fileUrl = null;
      let fileFullUrl = null;
      let fileMxc = null;
      let fileFilename = null;
      let fileInfo = null;

      if (
        (msgtype === 'm.image' ||
          (msgtype === 'm.file' && this.isPreviewableImageAttachment(mime, filename || ''))) &&
        content.url &&
        this.client
      ) {
        imageMxc = content.url;
        // Prefer explicit filename; legacy clients used body as the filename.
        imageFilename = filename || (typeof body === 'string' ? body : null) || 'image';
        const useOriginal = this.prefersOriginalImageMedia(mime, imageFilename);
        const resolved = this.resolveMediaHttp(content.url, { preferOriginal: useOriginal });
        imageUrl = resolved.url;
        imageFullUrl = resolved.fullUrl;
        imageSpoiler = spoiler;
        imageInfo = this.parseMediaInfo(content.info);
        if (imageInfo && (!imageInfo.mimeType || imageInfo.mimeType === 'application/octet-stream')) {
          imageInfo = {
            ...imageInfo,
            mimeType: this.normalizeImageContentType(mime, imageFilename),
          };
        }
        const uuid = content['com.paarrot.carousel_uuid'];
        const index = content['com.paarrot.carousel_index'];
        const total = content['com.paarrot.carousel_total'];
        if (
          typeof uuid === 'string' &&
          Number.isInteger(index) &&
          index >= 0 &&
          Number.isInteger(total) &&
          total > 1
        ) {
          carousel = { uuid, index, total };
        }
      } else if (
        (msgtype === 'm.video' ||
          (msgtype === 'm.file' &&
            (/^video\//i.test(mime) || /\.(webm|mp4|mov|mkv|ogv)$/i.test(filename || '')))) &&
        content.url &&
        this.client
      ) {
        videoMxc = content.url;
        videoFilename = filename || (typeof body === 'string' ? body : null) || 'video.webm';
        const resolved = this.resolveMediaHttp(content.url, { preferOriginal: true });
        videoUrl = resolved.fullUrl || resolved.url;
        videoFullUrl = resolved.fullUrl || videoUrl;
        videoInfo = this.parseMediaInfo(content.info);
        if (content.info?.thumbnail_url) {
          videoPosterUrl =
            this.resolveMediaHttp(content.info.thumbnail_url, { preferOriginal: false }).url ||
            null;
        }
      } else if (
        (msgtype === 'm.file' || msgtype === 'm.audio') &&
        content.url &&
        this.client
      ) {
        fileMxc = content.url;
        fileFilename = filename || (typeof body === 'string' ? body : null) || 'file';
        const resolved = this.resolveMediaHttp(content.url, { preferOriginal: true });
        fileUrl = resolved.fullUrl || resolved.url;
        fileFullUrl = resolved.fullUrl || fileUrl;
        fileInfo = this.parseMediaInfo(content.info);
      }

      const hasImage = Boolean(imageUrl || imageMxc);
      const hasVideo = Boolean(videoUrl || videoMxc);
      const hasFile = Boolean(fileUrl || fileMxc);
      if (!encrypted && !hasImage && !hasVideo && !hasFile && !(body && body.trim())) continue;

      let canRedact = false;
      try {
        canRedact = Boolean(
          myId && room.currentState?.maySendRedactionForEvent?.(event, myId),
        );
      } catch {
        canRedact = Boolean(myId && sender === myId);
      }

      const relates = content['m.relates_to'] || {};
      const replyToEventId = relates['m.in_reply_to']?.event_id || null;
      let replyToSender = null;
      let replyToSenderName = null;
      let replyToBody = null;
      if (replyToEventId && typeof room.findEventById === 'function') {
        try {
          const parent = room.findEventById(replyToEventId);
          if (parent) {
            replyToSender = parent.getSender?.() || null;
            replyToSenderName = replyToSender
              ? this.getMemberDisplayName(room, replyToSender) || replyToSender
              : null;
            const parentContent = parent.getContent?.() || {};
            const parentBody =
              typeof parentContent.body === 'string' ? parentContent.body : '';
            replyToBody = this.stripReplyFallback(parentBody).slice(0, 160);
          }
        } catch {
          // ignore
        }
      }

      const displayBody =
        typeof body === 'string' && replyToEventId ? this.stripReplyFallback(body) : body;

      out.push({
        eventId: event.getId(),
        type,
        sender,
        senderName: this.getMemberDisplayName(room, sender),
        senderAvatarUrl: this.getLocalProfileAvatarPath(sender, 96),
        hasSenderAvatar: Boolean(this.getProfileAvatarRemoteUrl(sender, 48)),
        senderStyle: this.getCachedProfileStyle(sender),
        senderPresence: this.getUserPresence(sender) || 'offline',
        senderOnline: this.getUserPresence(sender) === 'online',
        isMine: Boolean(myId && sender === myId),
        canRedact,
        ts: event.getTs(),
        body: displayBody,
        html: formattedBody,
        msgtype,
        imageUrl,
        imageFullUrl,
        imageMxc,
        imageFilename,
        imageInfo,
        imageSpoiler,
        videoUrl,
        videoFullUrl,
        videoMxc,
        videoFilename,
        videoInfo,
        videoPosterUrl,
        fileUrl,
        fileFullUrl,
        fileMxc,
        fileFilename,
        fileInfo,
        carousel,
        gallery: null,
        urls:
          typeof displayBody === 'string' &&
          msgtype !== 'm.image' &&
          msgtype !== 'm.video' &&
          msgtype !== 'm.file' &&
          msgtype !== 'm.audio'
            ? extractUrls(displayBody, { limit: 2 })
            : [],
        encrypted,
        redacted: false,
        readBy: receiptsByEvent.get(event.getId()) || [],
        replyToEventId,
        replyToSender,
        replyToSenderName,
        replyToBody,
        reactions: this.collectReactionsForEvent(room, event.getId()),
        isPinned: this.getPinnedEventIds(room).includes(event.getId()),
        canPin: this.canPinEvents(room),
        canEdit: Boolean(
          myId &&
            sender === myId &&
            type === 'm.room.message' &&
            (msgtype === 'm.text' || msgtype === 'm.emote' || !msgtype),
        ),
        source: {
          event_id: event.getId(),
          type,
          sender,
          origin_server_ts: event.getTs(),
          content,
        },
      });
    }

    const grouped = [];
    const consumed = new Set();
    for (let i = 0; i < out.length; i += 1) {
      if (consumed.has(i)) continue;
      const msg = out[i];
      if (!msg.carousel || msg.msgtype !== 'm.image') {
        grouped.push(msg);
        continue;
      }
      const items = [msg];
      consumed.add(i);
      for (let j = i + 1; j < out.length; j += 1) {
        const next = out[j];
        if (
          next.sender !== msg.sender ||
          next.msgtype !== 'm.image' ||
          !next.carousel ||
          next.carousel.uuid !== msg.carousel.uuid
        ) {
          break;
        }
        items.push(next);
        consumed.add(j);
      }
      items.sort((a, b) => (a.carousel?.index || 0) - (b.carousel?.index || 0));
      if (items.length === 1) {
        grouped.push(msg);
        continue;
      }
      const head = items[0];
      const readBy = [];
      const seenReaders = new Set();
      for (const item of items) {
        for (const reader of item.readBy || []) {
          if (!reader?.userId || seenReaders.has(reader.userId)) continue;
          seenReaders.add(reader.userId);
          readBy.push(reader);
        }
      }
      grouped.push({
        ...head,
        body: null,
        readBy,
        gallery: items.map((item) => ({
          eventId: item.eventId,
          imageUrl: item.imageUrl,
          imageFullUrl: item.imageFullUrl,
          imageMxc: item.imageMxc,
          imageFilename: item.imageFilename,
          imageInfo: item.imageInfo,
          imageSpoiler: item.imageSpoiler,
          canRedact: item.canRedact,
        })),
        carousel: {
          uuid: head.carousel.uuid,
          index: 0,
          total: items.length,
        },
      });
    }

    return grouped.slice(-Math.max(1, Math.min(2500, Number(limit) || 50)));
  }

  async isRoomTimelineAtStart(roomId) {
    if (!this.client) return true;
    const room = this.client.getRoom(roomId);
    if (!room) return true;
    const sdk = await loadSdk();
    const token = room.getLiveTimeline()?.getPaginationToken?.(sdk.EventTimeline.BACKWARDS);
    return token == null;
  }

  async scrollbackRoom(roomId, limit = 50) {
    if (!this.client) throw new Error('Not logged in');
    const room = this.client.getRoom(roomId);
    if (!room) throw new Error('Room not found');

    const before = room.getLiveTimeline()?.getEvents?.()?.length || 0;
    const atStartBefore = await this.isRoomTimelineAtStart(roomId);
    if (atStartBefore) {
      return {
        roomId,
        added: 0,
        eventCount: before,
        atStart: true,
      };
    }

    const batch = Math.max(10, Math.min(200, Number(limit) || 50));
    await this.client.scrollback(room, batch);
    const after = room.getLiveTimeline()?.getEvents?.()?.length || 0;
    return {
      roomId,
      added: Math.max(0, after - before),
      eventCount: after,
      atStart: await this.isRoomTimelineAtStart(roomId),
    };
  }

  /** Count chat-like events in the live timeline (not membership/state noise). */
  countRoomChatEvents(roomId) {
    if (!this.client) return 0;
    const room = this.client.getRoom(roomId);
    if (!room) return 0;
    const events = room.getLiveTimeline()?.getEvents?.() || [];
    let count = 0;
    for (const event of events) {
      const type = event.getType?.() || '';
      if (
        type === 'm.room.message' ||
        type === 'm.room.encrypted' ||
        type === 'm.reaction' ||
        type === 'm.sticker' ||
        type === 'app.relay.emoji_confetti'
      ) {
        count += 1;
      }
    }
    return count;
  }

  async ensureRoomHistory(
    roomId,
    { minEvents = 120, minMessages = 0, batchSize = 50, maxBatches = 20 } = {},
  ) {
    if (!this.client) throw new Error('Not logged in');
    const room = this.client.getRoom(roomId);
    if (!room) throw new Error('Room not found');

    const targetEvents = Math.max(30, Math.min(8000, Number(minEvents) || 120));
    const targetMessages = Math.max(0, Math.min(4000, Number(minMessages) || 0));
    const size = Math.max(10, Math.min(200, Number(batchSize) || 50));
    const batches = Math.max(1, Math.min(120, Number(maxBatches) || 20));
    let runs = 0;
    let addedTotal = 0;

    while (runs < batches) {
      const count = room.getLiveTimeline()?.getEvents?.()?.length || 0;
      const chatCount = this.countRoomChatEvents(roomId);
      const eventsOk = count >= targetEvents;
      const messagesOk = !targetMessages || chatCount >= targetMessages;
      if (eventsOk && messagesOk) break;
      if (await this.isRoomTimelineAtStart(roomId)) break;
      const result = await this.scrollbackRoom(roomId, size);
      runs += 1;
      addedTotal += result.added || 0;
      if (result.atStart || !result.added) break;
    }

    return {
      roomId,
      eventCount: room.getLiveTimeline()?.getEvents?.()?.length || 0,
      messageCount: this.countRoomChatEvents(roomId),
      added: addedTotal,
      batches: runs,
      atStart: await this.isRoomTimelineAtStart(roomId),
    };
  }

  /**
   * Pull recent history from the HS when the live timeline is too thin
   * (common after restart — sync only seeds a small window).
   */
  async hydrateRoomTimeline(roomId, { minMessages = 80, maxBatches = 40 } = {}) {
    if (!this.client) return null;
    const room = this.client.getRoom(roomId);
    if (!room) return null;
    const want = Math.max(20, Math.min(2000, Number(minMessages) || 80));
    const have = this.countRoomChatEvents(roomId);
    if (have >= want) {
      return {
        roomId,
        messageCount: have,
        added: 0,
        batches: 0,
        atStart: await this.isRoomTimelineAtStart(roomId),
        hydrated: false,
      };
    }
    return this.ensureRoomHistory(roomId, {
      minEvents: Math.max(want * 2, 200),
      minMessages: want,
      batchSize: 100,
      maxBatches,
    });
  }

  resolveMediaThumb(mxc, size = 320) {
    if (!this.client || !mxc) return null;
    try {
      const dim = Math.max(96, Math.min(512, Number(size) || 320));
      return (
        this.client.mxcUrlToHttp(mxc, dim, dim, 'crop', false, true, true) ||
        this.client.mxcUrlToHttp(mxc, dim, dim, 'scale', false, true, true) ||
        null
      );
    } catch {
      return null;
    }
  }

  async listRoomMedia(roomId, limit = 200) {
    if (!this.client) throw new Error('Not logged in');
    const room = this.client.getRoom(roomId);
    if (!room) throw new Error('Room not found');

    const want = Math.max(80, Math.min(500, Number(limit) || 200));
    await this.ensureRoomHistory(roomId, {
      minEvents: Math.max(want * 2, 200),
      batchSize: 80,
      maxBatches: 25,
    });

    // Keep paginating while media is sparse and history remains.
    let guard = 0;
    while (guard < 20) {
      const preview = await this.collectRoomMediaItems(roomId, want);
      if (preview.length >= want) break;
      if (await this.isRoomTimelineAtStart(roomId)) break;
      const step = await this.scrollbackRoom(roomId, 80);
      guard += 1;
      if (!step.added) break;
    }

    const items = await this.collectRoomMediaItems(roomId, want);
    return {
      roomId,
      items,
      atStart: await this.isRoomTimelineAtStart(roomId),
      eventCount: room.getLiveTimeline()?.getEvents?.()?.length || 0,
    };
  }

  async collectRoomMediaItems(roomId, limit = 200) {
    const messages = await this.getRoomTimeline(roomId, Math.max(80, Number(limit) || 200));
    const items = [];

    const pushImage = (msg, item = null) => {
      const imageMxc = item?.imageMxc || msg.imageMxc || null;
      const imageUrl = item?.imageUrl || msg.imageUrl || null;
      const imageFullUrl = item?.imageFullUrl || msg.imageFullUrl || imageUrl;
      const thumb =
        this.resolveMediaThumb(imageMxc, 320) || imageUrl || imageFullUrl || null;
      if (!thumb && !imageFullUrl) return;
      items.push({
        eventId: item?.eventId || msg.eventId,
        kind: 'image',
        ts: msg.ts || 0,
        sender: msg.sender || null,
        senderName: msg.senderName || msg.sender || 'Unknown',
        senderAvatarUrl: msg.senderAvatarUrl || null,
        hasSenderAvatar: Boolean(msg.hasSenderAvatar),
        imageUrl: thumb,
        imageFullUrl: imageFullUrl || thumb,
        imageMxc,
        imageFilename: item?.imageFilename || msg.imageFilename || msg.body || 'image',
        imageInfo: item?.imageInfo || msg.imageInfo || null,
        imageSpoiler: Boolean(item?.imageSpoiler ?? msg.imageSpoiler),
      });
    };

    for (const msg of messages) {
      if (Array.isArray(msg.gallery) && msg.gallery.length) {
        for (const item of msg.gallery) pushImage(msg, item);
        continue;
      }
      if (msg.msgtype === 'm.image' || msg.imageUrl || msg.imageMxc) {
        pushImage(msg);
        continue;
      }
      if (msg.msgtype === 'm.video' || msg.videoUrl || msg.videoMxc) {
        const posterMxc = msg.videoInfo?.thumbnailUrl || msg.imageMxc || null;
        const poster =
          this.resolveMediaThumb(posterMxc, 320) ||
          msg.videoPosterUrl ||
          msg.imageUrl ||
          null;
        if (!poster && !msg.videoUrl && !msg.videoFullUrl) continue;
        items.push({
          eventId: msg.eventId,
          kind: 'video',
          ts: msg.ts || 0,
          sender: msg.sender || null,
          senderName: msg.senderName || msg.sender || 'Unknown',
          senderAvatarUrl: msg.senderAvatarUrl || null,
          hasSenderAvatar: Boolean(msg.hasSenderAvatar),
          imageUrl: poster,
          imageFullUrl: msg.videoFullUrl || msg.videoUrl || poster,
          imageMxc: posterMxc,
          imageFilename: msg.videoFilename || msg.body || 'video',
          imageInfo: msg.videoInfo || null,
          imageSpoiler: false,
          videoUrl: msg.videoUrl || msg.videoFullUrl || null,
          videoFullUrl: msg.videoFullUrl || msg.videoUrl || null,
          videoMxc: msg.videoMxc || null,
        });
      }
    }

    items.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return items.slice(0, Math.max(1, Math.min(500, Number(limit) || 200)));
  }

  async redactMessage(roomId, eventId, reason = '') {
    if (!this.client) throw new Error('Not logged in');
    const id = String(eventId || '').trim();
    if (!id.startsWith('$')) throw new Error('Invalid event id');
    const room = this.client.getRoom(roomId);
    if (!room) throw new Error('Room not found');
    const event = room.findEventById(id);
    if (!event) throw new Error('Message not found');
    if (typeof event.isRedacted === 'function' && event.isRedacted()) {
      return { ok: true, eventId: id, alreadyRedacted: true };
    }
    const myId = this.client.getUserId();
    const allowed =
      myId && room.currentState?.maySendRedactionForEvent?.(event, myId);
    if (!allowed) throw new Error('You cannot delete this message');
    const txnId = this.client.makeTxnId?.() || `relay-redact-${Date.now()}`;
    const why = String(reason || '').trim();
    await this.client.redactEvent(roomId, id, txnId, why ? { reason: why } : undefined);
    return { ok: true, eventId: id };
  }

  stripReplyFallback(body) {
    let text = String(body || '');
    if (!text) return '';
    // Common Matrix reply fallback: lines of "> …" then blank line.
    if (/^>/.test(text)) {
      const stripped = text.replace(/^(?:>.*(?:\n|$))+/m, '').replace(/^\n+/, '');
      if (stripped.trim()) text = stripped;
    }
    return text.trim();
  }

  collectReactionsForEvent(room, targetEventId) {
    const eventId = String(targetEventId || '').trim();
    if (!room || !eventId || !this.client) return [];
    const myId = this.client.getUserId();
    const byKey = new Map();

    const addReaction = (key, sender, reactionEventId) => {
      const emoji = String(key || '').trim();
      if (!emoji) return;
      let entry = byKey.get(emoji);
      if (!entry) {
        entry = { key: emoji, count: 0, me: false, myEventId: null, senders: [] };
        byKey.set(emoji, entry);
      }
      entry.count += 1;
      if (sender) {
        entry.senders.push({
          userId: sender,
          displayName: this.getMemberDisplayName(room, sender),
          eventId: reactionEventId || null,
        });
      }
      if (myId && sender === myId) {
        entry.me = true;
        entry.myEventId = reactionEventId || entry.myEventId;
      }
    };

    try {
      const relations = room.getUnfilteredTimelineSet?.()?.relations;
      const bag = relations?.getChildEventsForEvent?.(eventId, 'm.annotation', 'm.reaction');
      const sorted = bag?.getSortedAnnotationsByKey?.();
      if (Array.isArray(sorted)) {
        for (const [key, eventSet] of sorted) {
          for (const reactionEvent of eventSet || []) {
            if (typeof reactionEvent.isRedacted === 'function' && reactionEvent.isRedacted()) {
              continue;
            }
            addReaction(key, reactionEvent.getSender?.(), reactionEvent.getId?.());
          }
        }
      }
    } catch {
      // fall through to timeline scan
    }

    if (byKey.size === 0) {
      for (const event of room.getLiveTimeline?.().getEvents?.() || []) {
        if (event.getType?.() !== 'm.reaction') continue;
        if (typeof event.isRedacted === 'function' && event.isRedacted()) continue;
        const relates = event.getContent?.()?.['m.relates_to'] || {};
        if (relates.rel_type !== 'm.annotation') continue;
        if (String(relates.event_id || '') !== eventId) continue;
        addReaction(relates.key, event.getSender?.(), event.getId?.());
      }
    }

    return [...byKey.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  }

  async editMessage(roomId, eventId, { body, formattedBody = null } = {}) {
    if (!this.client) throw new Error('Not logged in');
    const room = this.client.getRoom(roomId);
    if (!room || !this.isJoinedRoom(room)) throw new Error('Room not found');
    const id = String(eventId || '').trim();
    if (!id) throw new Error('Event id is required');
    const plain = String(body || '').trim();
    if (!plain) throw new Error('Message body is required');

    const event = room.findEventById?.(id);
    if (!event) throw new Error('Message not found in timeline');
    const myId = this.client.getUserId();
    if (event.getSender?.() !== myId) throw new Error('You can only edit your own messages');

    const escapeHtml = (value) =>
      String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    const providedHtml =
      typeof formattedBody === 'string' && formattedBody.trim() ? formattedBody.trim() : '';
    const html = providedHtml || escapeHtml(plain).replace(/\n/g, '<br/>');
    const newContent = {
      msgtype: 'm.text',
      body: plain,
      format: 'org.matrix.custom.html',
      formatted_body: html,
    };

    const result = await this.client.sendEvent(roomId, 'm.room.message', {
      msgtype: 'm.text',
      body: `* ${plain}`,
      format: 'org.matrix.custom.html',
      formatted_body: `* ${html}`,
      'm.new_content': newContent,
      'm.relates_to': {
        rel_type: 'm.replace',
        event_id: id,
      },
    });

    return { eventId: result?.event_id || null, replacedEventId: id };
  }

  async getEventSource(roomId, eventId) {
    if (!this.client) throw new Error('Not logged in');
    const room = this.client.getRoom(roomId);
    if (!room) throw new Error('Room not found');
    const id = String(eventId || '').trim();
    const event = room.findEventById?.(id);
    if (!event) throw new Error('Event not found in local timeline');
    return {
      event_id: event.getId(),
      room_id: roomId,
      type: event.getType(),
      sender: event.getSender(),
      origin_server_ts: event.getTs(),
      content: event.getContent?.() || {},
      unsigned: typeof event.getUnsigned === 'function' ? event.getUnsigned() : event.unsigned || {},
    };
  }

  async toggleReaction(roomId, eventId, key) {
    if (!this.client) throw new Error('Not logged in');
    const room = this.client.getRoom(roomId);
    if (!room || !this.isJoinedRoom(room)) throw new Error('Room not found');
    const targetId = String(eventId || '').trim();
    const emoji = String(key || '').trim();
    if (!targetId) throw new Error('Event id is required');
    if (!emoji) throw new Error('Reaction is required');

    const existing = this.collectReactionsForEvent(room, targetId).find(
      (entry) => entry.key === emoji && entry.me && entry.myEventId,
    );
    if (existing?.myEventId) {
      await this.client.redactEvent(roomId, existing.myEventId);
      return { ok: true, removed: true, eventId: existing.myEventId, key: emoji };
    }

    const result = await this.client.sendEvent(roomId, 'm.reaction', {
      'm.relates_to': {
        rel_type: 'm.annotation',
        event_id: targetId,
        key: emoji,
      },
    });
    return {
      ok: true,
      removed: false,
      eventId: result?.event_id || result?.eventId || null,
      key: emoji,
    };
  }

  async sendEmojiConfetti(roomId, { emojis = [], targetEventId = null } = {}) {
    if (!this.client) throw new Error('Not logged in');
    const room = this.client.getRoom(roomId);
    if (!room) throw new Error('Room not found');
    const pool = (Array.isArray(emojis) ? emojis : [])
      .map((entry) => String(entry || '').trim())
      .filter(Boolean)
      .slice(0, 12);
    if (!pool.length) throw new Error('Emoji list is required');

    const content = {
      emojis: pool,
      msgtype: 'app.relay.emoji_confetti',
    };
    const target = String(targetEventId || '').trim();
    if (target) content.target_event_id = target;

    const result = await this.client.sendEvent(roomId, 'app.relay.emoji_confetti', content);
    return {
      ok: true,
      eventId: result?.event_id || result?.eventId || null,
      emojis: pool,
    };
  }

  async sendText(
    roomId,
    body,
    { mentions = [], formattedBody = null, replyToEventId = null, threadRootId = null } = {},
  ) {
    if (!this.client) throw new Error('Not logged in');

    const cleanMentions = (Array.isArray(mentions) ? mentions : [])
      .map((entry) => ({
        userId: String(entry?.userId || '').trim(),
        displayName: String(entry?.displayName || '').trim(),
      }))
      .filter((entry) => entry.userId.startsWith('@') && entry.userId.includes(':'));

    const mentionLabels = cleanMentions.map(
      (entry) => `@${entry.displayName || entry.userId.slice(1).split(':')[0]}`,
    );
    const typed = String(body || '').trim();
    const text = [...mentionLabels, typed].filter(Boolean).join(' ').trim();
    if (!text) throw new Error('Message body is required');

    this.pluginHost?.emit('message-send', { roomId, body: text, mentions: cleanMentions });

    const escapeHtml = (value) =>
      String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    const mentionHtml = cleanMentions
      .map((entry) => {
        const label = escapeHtml(entry.displayName || entry.userId);
        return `<a href="https://matrix.to/#/${encodeURI(entry.userId)}">${label}</a>`;
      })
      .join(' ');

    const providedHtml =
      typeof formattedBody === 'string' && formattedBody.trim() ? formattedBody.trim() : '';
    const typedHtml = providedHtml || (typed ? escapeHtml(typed).replace(/\n/g, '<br/>') : '');
    const html = [mentionHtml, typedHtml].filter(Boolean).join(' ');

    const parentId = String(replyToEventId || '').trim();
    let replyFallback = '';
    let replyHtml = '';
    if (parentId) {
      const room = this.client.getRoom(roomId);
      const parent = room?.findEventById?.(parentId);
      const parentSender = parent?.getSender?.() || '';
      const parentBody = this.stripReplyFallback(
        typeof parent?.getContent?.()?.body === 'string' ? parent.getContent().body : '',
      );
      const parentName = parentSender
        ? this.getMemberDisplayName(room, parentSender) || parentSender
        : 'user';
      const snippet = parentBody.slice(0, 80) || 'message';
      replyFallback = `> <${parentSender}> ${snippet}\n\n`;
      replyHtml = `<mx-reply><blockquote><a href="https://matrix.to/#/${encodeURIComponent(roomId)}/${encodeURIComponent(parentId)}">In reply to</a> <a href="https://matrix.to/#/${encodeURI(parentSender)}">${escapeHtml(parentName)}</a><br>${escapeHtml(snippet)}</blockquote></mx-reply>`;
    }

    const content = {
      msgtype: 'm.text',
      body: replyFallback ? `${replyFallback}${text}` : text,
    };

    if (html || replyHtml) {
      content.format = 'org.matrix.custom.html';
      content.formatted_body = `${replyHtml}${html || escapeHtml(text).replace(/\n/g, '<br/>')}`;
    }
    if (cleanMentions.length) {
      content['m.mentions'] = {
        user_ids: cleanMentions.map((entry) => entry.userId),
      };
    }
    const threadId = String(threadRootId || '').trim();
    if (threadId) {
      content['m.relates_to'] = {
        rel_type: 'm.thread',
        event_id: threadId,
        is_falling_back: true,
        'm.in_reply_to': { event_id: parentId || threadId },
      };
    } else if (parentId) {
      content['m.relates_to'] = {
        'm.in_reply_to': { event_id: parentId },
      };
    }

    if (
      !html &&
      !replyHtml &&
      !parentId &&
      !threadId &&
      cleanMentions.length === 0 &&
      !/[<*_`#\[\]]/.test(typed)
    ) {
      const result = await this.client.sendTextMessage(roomId, text);
      return { eventId: result?.event_id || null };
    }

    const result = await this.client.sendEvent(roomId, 'm.room.message', content);
    return { eventId: result?.event_id || null };
  }

  async sendImageBuffer(
    roomId,
    buffer,
    {
      contentType = 'image/png',
      filename = 'image.png',
      caption = null,
      formatted_body = null,
      mentions = null,
      blurhash = null,
      width = null,
      height = null,
      carousel = null,
    } = {},
  ) {
    if (!this.client) throw new Error('Not logged in');
    if (!buffer || !buffer.length) throw new Error('Image data is required');

    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const mime = this.normalizeImageContentType(contentType, filename, bytes);
    // Matrix ecosystems treat APNG as image/png; keep animation via original media URL.
    const uploadType = mime === 'image/apng' ? 'image/png' : mime;

    const upload = await this.client.uploadContent(bytes, {
      type: uploadType,
      name: filename,
      rawResponse: false,
    });
    const mxc = typeof upload === 'string' ? upload : upload?.content_uri;
    if (!mxc) throw new Error('Upload failed');

    const dims = this.readImageDimensions(bytes);
    const info = {
      mimetype: uploadType,
      size: bytes.length,
    };
    if (dims?.width) info.w = dims.width;
    if (dims?.height) info.h = dims.height;
    if (width) info.w = Number(width) || info.w;
    if (height) info.h = Number(height) || info.h;
    if (typeof blurhash === 'string' && blurhash.trim()) {
      info['xyz.amorgan.blurhash'] = blurhash.trim();
    }

    const fileName = String(filename || 'image.png').trim() || 'image.png';
    const captionText = typeof caption === 'string' ? caption.trim() : '';
    const content = {
      msgtype: 'm.image',
      body: captionText || fileName,
      filename: fileName,
      info,
      url: mxc,
    };
    if (captionText && typeof formatted_body === 'string' && formatted_body.trim()) {
      content.format = 'org.matrix.custom.html';
      content.formatted_body = formatted_body.trim();
    }
    if (Array.isArray(mentions) && mentions.length) {
      content['m.mentions'] = {
        user_ids: mentions
          .map((entry) => entry?.userId || entry)
          .filter((id) => typeof id === 'string' && id.startsWith('@')),
      };
    }
    if (
      carousel &&
      typeof carousel.uuid === 'string' &&
      Number.isInteger(carousel.index) &&
      Number.isInteger(carousel.total) &&
      carousel.total > 1
    ) {
      content['com.paarrot.carousel_uuid'] = carousel.uuid;
      content['com.paarrot.carousel_index'] = carousel.index;
      content['com.paarrot.carousel_total'] = carousel.total;
    }
    const result = await this.client.sendMessage(roomId, content);
    return { eventId: result?.event_id || null, mxc, info };
  }

  async sendVideoBuffer(
    roomId,
    buffer,
    {
      contentType = 'video/webm',
      filename = 'video.webm',
      caption = null,
      width = null,
      height = null,
    } = {},
  ) {
    if (!this.client) throw new Error('Not logged in');
    if (!buffer || !buffer.length) throw new Error('Video data is required');

    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    let mime = String(contentType || 'video/webm')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (!mime.startsWith('video/')) {
      const name = String(filename || '').toLowerCase();
      if (name.endsWith('.mp4')) mime = 'video/mp4';
      else if (name.endsWith('.mov')) mime = 'video/quicktime';
      else mime = 'video/webm';
    }

    const upload = await this.client.uploadContent(bytes, {
      type: mime,
      name: filename,
      rawResponse: false,
    });
    const mxc = typeof upload === 'string' ? upload : upload?.content_uri;
    if (!mxc) throw new Error('Upload failed');

    const info = {
      mimetype: mime,
      size: bytes.length,
    };
    if (width) info.w = Number(width) || undefined;
    if (height) info.h = Number(height) || undefined;

    const fileName = String(filename || 'video.webm').trim() || 'video.webm';
    const captionText = typeof caption === 'string' ? caption.trim() : '';
    const content = {
      msgtype: 'm.video',
      body: captionText || fileName,
      filename: fileName,
      info,
      url: mxc,
    };
    const result = await this.client.sendMessage(roomId, content);
    return { eventId: result?.event_id || null, mxc, info };
  }

  async sendFileBuffer(
    roomId,
    buffer,
    {
      contentType = 'application/octet-stream',
      filename = 'file',
      caption = null,
      formatted_body = null,
      mentions = null,
    } = {},
  ) {
    if (!this.client) throw new Error('Not logged in');
    if (!buffer || !buffer.length) throw new Error('File data is required');

    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const fileName = String(filename || 'file').trim() || 'file';
    let mime = String(contentType || 'application/octet-stream')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (!mime || mime === 'application/octet-stream') {
      const lower = fileName.toLowerCase();
      if (lower.endsWith('.appimage')) mime = 'application/vnd.appimage';
      else if (lower.endsWith('.pdf')) mime = 'application/pdf';
      else if (lower.endsWith('.zip')) mime = 'application/zip';
      else if (lower.endsWith('.tar')) mime = 'application/x-tar';
      else if (lower.endsWith('.gz') || lower.endsWith('.tgz')) mime = 'application/gzip';
      else if (lower.endsWith('.txt')) mime = 'text/plain';
      else if (lower.endsWith('.json')) mime = 'application/json';
      else mime = 'application/octet-stream';
    }

    const upload = await this.client.uploadContent(bytes, {
      type: mime,
      name: fileName,
      rawResponse: false,
    });
    const mxc = typeof upload === 'string' ? upload : upload?.content_uri;
    if (!mxc) throw new Error('Upload failed');

    const captionText = typeof caption === 'string' ? caption.trim() : '';
    const content = {
      msgtype: 'm.file',
      body: captionText || fileName,
      filename: fileName,
      info: {
        mimetype: mime,
        size: bytes.length,
      },
      url: mxc,
    };
    if (captionText && typeof formatted_body === 'string' && formatted_body.trim()) {
      content.format = 'org.matrix.custom.html';
      content.formatted_body = formatted_body.trim();
    }
    if (Array.isArray(mentions) && mentions.length) {
      content['m.mentions'] = {
        user_ids: mentions
          .map((entry) => entry?.userId || entry)
          .filter((id) => typeof id === 'string' && id.startsWith('@')),
      };
    }
    const result = await this.client.sendMessage(roomId, content);
    return { eventId: result?.event_id || null, mxc, info: content.info };
  }

  /**
   * Best-effort width/height from common image headers (PNG/APNG/JPEG/GIF/WebP).
   */
  readImageDimensions(buffer) {
    try {
      if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;

      // PNG / APNG
      if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
        return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
      }

      // GIF
      if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
        return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
      }

      // WebP
      if (
        buffer.toString('ascii', 0, 4) === 'RIFF' &&
        buffer.toString('ascii', 8, 12) === 'WEBP'
      ) {
        const chunk = buffer.toString('ascii', 12, 16);
        if (chunk === 'VP8X' && buffer.length >= 30) {
          const width = 1 + buffer[24] + (buffer[25] << 8) + (buffer[26] << 16);
          const height = 1 + buffer[27] + (buffer[28] << 8) + (buffer[29] << 16);
          return { width, height };
        }
        if (chunk === 'VP8 ' && buffer.length >= 30) {
          return {
            width: buffer.readUInt16LE(26) & 0x3fff,
            height: buffer.readUInt16LE(28) & 0x3fff,
          };
        }
        if (chunk === 'VP8L' && buffer.length >= 25) {
          const bits = buffer.readUInt32LE(21);
          return {
            width: (bits & 0x3fff) + 1,
            height: ((bits >> 14) & 0x3fff) + 1,
          };
        }
      }

      // JPEG — scan SOF markers
      if (buffer[0] === 0xff && buffer[1] === 0xd8) {
        let offset = 2;
        while (offset + 9 < buffer.length) {
          if (buffer[offset] !== 0xff) break;
          const marker = buffer[offset + 1];
          const size = buffer.readUInt16BE(offset + 2);
          if (
            (marker >= 0xc0 && marker <= 0xc3) ||
            (marker >= 0xc5 && marker <= 0xc7) ||
            (marker >= 0xc9 && marker <= 0xcb) ||
            (marker >= 0xcd && marker <= 0xcf)
          ) {
            return {
              height: buffer.readUInt16BE(offset + 5),
              width: buffer.readUInt16BE(offset + 7),
            };
          }
          offset += 2 + size;
        }
      }

      // BMP
      if (buffer[0] === 0x42 && buffer[1] === 0x4d && buffer.length >= 26) {
        return {
          width: buffer.readInt32LE(18),
          height: Math.abs(buffer.readInt32LE(22)),
        };
      }
    } catch {
      // ignore
    }
    return null;
  }

  /**
   * Sniff image MIME from magic bytes (fallback when client sends octet-stream).
   */
  sniffImageContentType(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
      // APNG has acTL chunk; still valid as image/png for Matrix
      return this.pngHasAnimation(buffer) ? 'image/apng' : 'image/png';
    }
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif';
    if (
      buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP'
    ) {
      return 'image/webp';
    }
    if (buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp';
    // AVIF / HEIC ftyp
    if (buffer.toString('ascii', 4, 8) === 'ftyp') {
      const brand = buffer.toString('ascii', 8, 12);
      if (brand === 'avif' || brand === 'avis') return 'image/avif';
      if (brand === 'heic' || brand === 'heix' || brand === 'mif1') return 'image/heic';
    }
    return null;
  }

  pngHasAnimation(buffer) {
    try {
      let offset = 8;
      while (offset + 8 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString('ascii', offset + 4, offset + 8);
        if (type === 'acTL') return true;
        if (type === 'IEND') break;
        offset += 12 + length;
      }
    } catch {
      // ignore
    }
    return false;
  }

  webpHasAnimation(buffer) {
    try {
      if (
        buffer.toString('ascii', 0, 4) !== 'RIFF' ||
        buffer.toString('ascii', 8, 12) !== 'WEBP'
      ) {
        return false;
      }
      if (buffer.toString('ascii', 12, 16) === 'VP8X' && buffer.length >= 21) {
        return Boolean(buffer[20] & 0x02);
      }
      return buffer.includes(Buffer.from('ANIM'), 12);
    } catch {
      return false;
    }
  }

  normalizeImageContentType(contentType, filename = '', buffer = null) {
    let type = String(contentType || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (type === 'image/jpg') type = 'image/jpeg';
    if (type.startsWith('image/') && type !== 'image/apng') {
      // Keep declared type unless buffer proves APNG/animated webp nuance
      if (buffer && type === 'image/png' && this.pngHasAnimation(buffer)) return 'image/apng';
      return type;
    }
    const sniffed = buffer ? this.sniffImageContentType(buffer) : null;
    if (sniffed) return sniffed;
    const name = String(filename || '').toLowerCase();
    if (/\.jpe?g$/i.test(name)) return 'image/jpeg';
    if (/\.png$/i.test(name)) return 'image/png';
    if (/\.apng$/i.test(name)) return 'image/apng';
    if (/\.gif$/i.test(name)) return 'image/gif';
    if (/\.webp$/i.test(name)) return 'image/webp';
    if (/\.bmp$/i.test(name)) return 'image/bmp';
    if (/\.avif$/i.test(name)) return 'image/avif';
    if (/\.heic$/i.test(name)) return 'image/heic';
    if (/\.svg$/i.test(name)) return 'image/svg+xml';
    return type.startsWith('image/') ? type : 'image/png';
  }

  /**
   * m.file attachments that are still safe to show as an inline image preview
   * (SVG often arrives as application/octet-stream).
   */
  isPreviewableImageAttachment(contentType, filename = '') {
    const type = String(contentType || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    const name = String(filename || '').toLowerCase();
    if (type === 'image/svg+xml' || /\.svg$/i.test(name)) return true;
    if (type.startsWith('image/')) return true;
    if (
      (!type || type === 'application/octet-stream') &&
      /\.(png|apng|jpe?g|gif|webp|bmp|avif|heic|heif|svg)$/i.test(name)
    ) {
      return true;
    }
    return false;
  }

  /**
   * Homeserver thumbnails often flatten GIF/WebP/APNG — use original for those.
   */
  prefersOriginalImageMedia(contentType, filename = '', buffer = null) {
    const type = this.normalizeImageContentType(contentType, filename, buffer);
    // Thumbnails flatten animation; APNG is often labeled image/png.
    // SVG must stay original — thumbnail endpoints usually can't rasterize it.
    if (
      type === 'image/gif' ||
      type === 'image/webp' ||
      type === 'image/apng' ||
      type === 'image/png' ||
      type === 'image/avif' ||
      type === 'image/heic' ||
      type === 'image/svg+xml'
    ) {
      return true;
    }
    if (buffer && this.webpHasAnimation(buffer)) return true;
    return /\.(gif|webp|apng|png|avif|heic|svg)$/i.test(String(filename || ''));
  }

  async sendImageFromUrl(roomId, url, filename = 'image.gif') {
    if (!this.client) throw new Error('Not logged in');
    const response = await fetch(String(url || ''), { redirect: 'follow' });
    if (!response.ok) throw new Error(`Failed to fetch image (${response.status})`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const headerType = response.headers.get('content-type') || '';
    const contentType = this.normalizeImageContentType(headerType, filename, buffer);
    return this.sendImageBuffer(roomId, buffer, { contentType, filename });
  }

  // --- Paarrot-compatible forum board (events/kinds only; not a Cinny port) ---

  escapeForumHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  isForumRootContent(content) {
    if (!content || typeof content !== 'object') return false;
    if (typeof content['com.matrixsso.title'] === 'string') return true;
    const formatted = content.formatted_body;
    return typeof formatted === 'string' && /<h1[\s>]/i.test(formatted);
  }

  forumTitleFromFormattedBody(formattedBody) {
    const html = String(formattedBody || '');
    const match = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
    if (!match) return '';
    return match[1]
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .trim();
  }

  forumPostTitleFromContent(content) {
    const rawBody = typeof content?.body === 'string' ? content.body : '';
    const customTitle =
      typeof content?.['com.matrixsso.title'] === 'string'
        ? String(content['com.matrixsso.title']).trim()
        : '';
    const htmlTitle =
      typeof content?.formatted_body === 'string'
        ? this.forumTitleFromFormattedBody(content.formatted_body)
        : '';
    const firstLine = rawBody.split(/\r?\n/, 1)[0]?.trim() || '';
    const title = (customTitle || htmlTitle || firstLine || '(untitled post)').slice(0, 160);

    let body = rawBody;
    if (customTitle && rawBody.startsWith(customTitle)) {
      body = rawBody.slice(customTitle.length).replace(/^\s+/, '');
    } else {
      const [leadingBlock, ...restBlocks] = rawBody.split(/\r?\n\r?\n/);
      if (restBlocks.length > 0 && leadingBlock.trim() === firstLine) {
        body = restBlocks.join('\n\n').trim();
      } else if (firstLine && rawBody.startsWith(firstLine)) {
        body = rawBody.slice(firstLine.length).replace(/^\s+/, '');
      }
    }

    return { title, body: body || rawBody };
  }

  listForumTopics(spaceId) {
    if (!this.client) return [];
    const space = this.client.getRoom(spaceId);
    if (!space || !this.isForumContainer(space)) return [];

    const topics = [];
    const walk = (parent, parentRoomId) => {
      for (const entry of this.getSpaceChildEntries(parent)) {
        const child = this.client.getRoom(entry.roomId);
        if (!child || !this.isJoinedRoom(child)) continue;
        const isSpace = this.isSpaceRoom(child);
        const topicEvent = child.currentState?.getStateEvents?.('m.room.topic', '');
        topics.push({
          roomId: child.roomId,
          name: child.name || child.roomId,
          topic: topicEvent?.getContent?.()?.topic || '',
          isSpace,
          parentRoomId,
          suggested: Boolean(entry.suggested),
        });
        if (isSpace) walk(child, child.roomId);
      }
    };
    walk(space, spaceId);
    return topics;
  }

  buildForumSections(topics) {
    const list = Array.isArray(topics) ? topics : [];
    const spaces = list.filter((topic) => topic.isSpace);
    const postableTopics = list.filter((topic) => !topic.isSpace);
    const sections = [];

    for (const space of spaces) {
      const childTopics = postableTopics.filter((topic) => topic.parentRoomId === space.roomId);
      sections.push({
        spaceId: space.roomId,
        title: space.name,
        description: space.topic || null,
        topics: childTopics.sort((a, b) => a.name.localeCompare(b.name)),
      });
    }

    const coveredTopicIds = new Set(
      sections.flatMap((section) => section.topics.map((topic) => topic.roomId)),
    );
    const uncategorizedTopics = postableTopics.filter((topic) => !coveredTopicIds.has(topic.roomId));
    if (uncategorizedTopics.length > 0) {
      sections.push({
        title: 'General Topics',
        description: null,
        topics: uncategorizedTopics.sort((a, b) => a.name.localeCompare(b.name)),
      });
    }

    return sections;
  }

  listForumRootPostsInRoom(room, { limit = 40 } = {}) {
    if (!room) return [];
    const events = room.getLiveTimeline?.().getEvents?.() || [];
    const roots = [];
    const max = Math.max(1, Number(limit) || 40);

    for (let i = events.length - 1; i >= 0 && roots.length < max; i -= 1) {
      const event = events[i];
      if (!event || event.getType?.() !== 'm.room.message') continue;
      if (typeof event.isRedacted === 'function' && event.isRedacted()) continue;

      const content = event.getContent?.() || {};
      const relates = content['m.relates_to'];
      const relType = relates?.rel_type;
      if (relType === 'm.thread' || relType === 'm.replace' || relType === 'm.annotation') continue;
      if (!this.isForumRootContent(content)) continue;

      const { title, body } = this.forumPostTitleFromContent(content);
      const unsigned = typeof event.getUnsigned === 'function' ? event.getUnsigned() : event.unsigned;
      const threadMeta = unsigned?.['m.relations']?.['m.thread'];
      const bundledCount = Number(threadMeta?.count);
      const sender = event.getSender?.() || '';
      const ts = event.getTs?.() || 0;

      roots.push({
        eventId: event.getId?.(),
        title,
        body,
        sender,
        senderName: this.getMemberDisplayName(room, sender) || sender,
        timestamp: ts,
        totalReplies: Number.isFinite(bundledCount) && bundledCount >= 0 ? Math.floor(bundledCount) : 0,
        lastActivityTs: ts,
      });
    }

    return roots;
  }

  getForumBoard(spaceId, { topicRoomId = null, limit = 50 } = {}) {
    if (!this.client) throw new Error('Not logged in');
    const space = this.client.getRoom(spaceId);
    if (!space || !this.isForumContainer(space)) {
      throw new Error('Not a forum space');
    }

    const topics = this.listForumTopics(spaceId);
    const sections = this.buildForumSections(topics);
    const topicFilter = topicRoomId ? String(topicRoomId) : null;
    const postable = topics.filter((topic) => {
      if (topic.isSpace) return false;
      if (topicFilter) return topic.roomId === topicFilter;
      return true;
    });

    const sectionByTopic = new Map();
    for (const section of sections) {
      for (const topic of section.topics || []) {
        sectionByTopic.set(topic.roomId, section.title || null);
      }
    }

    const perTopic = Math.max(8, Math.ceil((Number(limit) || 50) / Math.max(1, postable.length)));
    const posts = [];
    for (const topic of postable) {
      const room = this.client.getRoom(topic.roomId);
      if (!room || !this.isJoinedRoom(room)) continue;
      for (const root of this.listForumRootPostsInRoom(room, { limit: perTopic })) {
        posts.push({
          ...root,
          topicRoomId: topic.roomId,
          topicName: topic.name,
          sectionTitle: sectionByTopic.get(topic.roomId) || null,
        });
      }
    }

    posts.sort((a, b) => (b.lastActivityTs || 0) - (a.lastActivityTs || 0));

    return {
      space: this.getSpaceSummary(spaceId),
      isForum: true,
      sections,
      topics: postable.map((topic) => ({
        roomId: topic.roomId,
        name: topic.name,
        topic: topic.topic,
        parentRoomId: topic.parentRoomId,
      })),
      posts: posts.slice(0, Math.max(1, Number(limit) || 50)),
    };
  }

  async createForumPost(topicRoomId, { title, body } = {}) {
    if (!this.client) throw new Error('Not logged in');
    const room = this.client.getRoom(topicRoomId);
    if (!room || !this.isJoinedRoom(room)) throw new Error('Topic room not found');
    if (this.isSpaceLikeRoom(room)) throw new Error('Pick a topic room, not a section');

    const trimmedTitle = String(title || '').trim();
    const plainText = String(body || '').trim();
    if (!trimmedTitle) throw new Error('Post title is required.');
    if (trimmedTitle.length > 140) throw new Error('Post title is too long.');
    if (!plainText) throw new Error('Post body is required.');

    const safeTitle = this.escapeForumHtml(trimmedTitle);
    const safeBody = this.escapeForumHtml(plainText).replace(/\r?\n/g, '<br/>');

    const result = await this.client.sendMessage(topicRoomId, {
      msgtype: 'm.text',
      body: `${trimmedTitle}\n\n${plainText}`,
      'com.matrixsso.title': trimmedTitle,
      format: 'org.matrix.custom.html',
      formatted_body: `<h1>${safeTitle}</h1><p>${safeBody}</p>`,
    });

    return {
      eventId: result?.event_id || result?.eventId || null,
      roomId: topicRoomId,
    };
  }

  collectForumThreadEvents(room, rootEventId) {
    const rootId = String(rootEventId || '').trim();
    if (!room || !rootId) return [];

    const seen = new Set();
    const events = [];

    const add = (event) => {
      if (!event) return;
      if (typeof event.isRedacted === 'function' && event.isRedacted()) return;
      if (event.getType?.() !== 'm.room.message') return;
      const id = event.getId?.();
      if (!id || seen.has(id)) return;

      const content = event.getContent?.() || {};
      const relates = content['m.relates_to'] || {};
      const relType = relates.rel_type;
      if (relType === 'm.replace' || relType === 'm.annotation') return;

      const isRoot = id === rootId;
      const isThreadReply =
        relType === 'm.thread' && String(relates.event_id || '') === rootId;
      // Also accept SDK getRelation()
      let belongs = isRoot || isThreadReply;
      try {
        const relation = typeof event.getRelation === 'function' ? event.getRelation() : null;
        if (
          relation?.rel_type === 'm.thread' &&
          String(relation.event_id || '') === rootId
        ) {
          belongs = true;
        }
      } catch {
        // ignore
      }
      if (!belongs) return;

      seen.add(id);
      events.push(event);
    };

    try {
      add(room.findEventById?.(rootId));
    } catch {
      // ignore
    }

    try {
      const thread = room.getThread?.(rootId);
      if (thread) {
        add(thread.rootEvent);
        for (const reply of thread.events || []) add(reply);
        for (const reply of thread.liveTimeline?.getEvents?.() || []) add(reply);
      }
    } catch {
      // ignore
    }

    for (const event of room.getLiveTimeline?.().getEvents?.() || []) {
      add(event);
    }

    return events;
  }

  serializeForumThreadNode(room, event, { isRoot = false } = {}) {
    const content = event.getContent?.() || {};
    const relates = content['m.relates_to'] || {};
    const sender = event.getSender?.() || '';
    const { title, body } = isRoot
      ? this.forumPostTitleFromContent(content)
      : {
          title: '',
          body: typeof content.body === 'string' ? content.body : '',
        };
    return {
      eventId: event.getId?.(),
      title: isRoot ? title : '',
      body,
      sender,
      senderName: this.getMemberDisplayName(room, sender) || sender,
      timestamp: event.getTs?.() || 0,
      replyToEventId: relates['m.in_reply_to']?.event_id || null,
      reactions: this.collectReactionsForEvent(room, event.getId?.()),
      replies: [],
    };
  }

  getForumThread(roomId, rootEventId) {
    if (!this.client) throw new Error('Not logged in');
    const room = this.client.getRoom(roomId);
    if (!room || !this.isJoinedRoom(room)) throw new Error('Topic room not found');

    const rootId = String(rootEventId || '').trim();
    if (!rootId) throw new Error('Post event id is required');

    const events = this.collectForumThreadEvents(room, rootId);
    if (!events.length) {
      throw new Error('Post not found in local timeline yet');
    }

    const byId = new Map();
    let rootNode = null;

    for (const event of events) {
      const id = event.getId?.();
      if (!id) continue;
      const isRoot = id === rootId;
      const node = this.serializeForumThreadNode(room, event, { isRoot });
      byId.set(id, node);
      if (isRoot) rootNode = node;
    }

    if (!rootNode) {
      throw new Error('Post not found in local timeline yet');
    }

    const placed = new Set([rootId]);
    const flat = [];

    for (const event of events) {
      const id = event.getId?.();
      if (!id || id === rootId) continue;
      const node = byId.get(id);
      if (!node) continue;

      const content = event.getContent?.() || {};
      const relates = content['m.relates_to'] || {};
      const parentId = relates['m.in_reply_to']?.event_id || null;

      if (parentId && parentId !== rootId && byId.has(parentId)) {
        byId.get(parentId).replies.push(node);
        placed.add(id);
      } else {
        flat.push(node);
        placed.add(id);
      }
    }

    // Attach top-level thread replies under root; keep nested under parents.
    rootNode.replies.push(...flat);
    const sortTree = (nodes) => {
      nodes.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      for (const node of nodes) {
        if (node.replies?.length) sortTree(node.replies);
      }
    };
    sortTree(rootNode.replies);

    const unsigned =
      typeof events.find((e) => e.getId?.() === rootId)?.getUnsigned === 'function'
        ? events.find((e) => e.getId?.() === rootId).getUnsigned()
        : null;
    const bundled = Number(unsigned?.['m.relations']?.['m.thread']?.count);

    const countReplies = (nodes) => {
      let total = 0;
      for (const node of nodes || []) {
        total += 1;
        total += countReplies(node.replies);
      }
      return total;
    };

    rootNode.totalReplies = Number.isFinite(bundled)
      ? Math.max(Math.floor(bundled), countReplies(rootNode.replies))
      : countReplies(rootNode.replies);

    const topicEvent = room.currentState?.getStateEvents?.('m.room.topic', '');
    return {
      roomId,
      topicName: room.name || roomId,
      topic: topicEvent?.getContent?.()?.topic || '',
      post: rootNode,
    };
  }

  async createForumThreadReply(roomId, rootEventId, { body, replyToEventId = null } = {}) {
    if (!this.client) throw new Error('Not logged in');
    const room = this.client.getRoom(roomId);
    if (!room || !this.isJoinedRoom(room)) throw new Error('Topic room not found');

    const rootId = String(rootEventId || '').trim();
    if (!rootId) throw new Error('Thread root is required');
    const plain = String(body || '').trim();
    if (!plain) throw new Error('Reply body is required.');

    const parentId = String(replyToEventId || rootId).trim() || rootId;
    const safeBody = this.escapeForumHtml(plain).replace(/\r?\n/g, '<br/>');

    const result = await this.client.sendMessage(roomId, {
      msgtype: 'm.text',
      body: plain,
      format: 'org.matrix.custom.html',
      formatted_body: `<p>${safeBody}</p>`,
      'm.relates_to': {
        rel_type: 'm.thread',
        event_id: rootId,
        is_falling_back: false,
        'm.in_reply_to': { event_id: parentId },
      },
    });

    return {
      eventId: result?.event_id || result?.eventId || null,
      roomId,
      rootEventId: rootId,
    };
  }
}

module.exports = { MatrixSession, warmSdk, loadSdk };
