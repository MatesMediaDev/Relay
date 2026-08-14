const path = require('path');
const express = require('express');
const { PluginHost } = require('./src/plugin-manager/PluginHost');
const { ThemeHost } = require('./src/theme-manager/ThemeHost');
const { MatrixSession } = require('./src/matrix/MatrixSession');
const { VoipConfig } = require('./src/voip/VoipConfig');
const { VoipHub } = require('./src/voip/VoipHub');
const { fetchLinkPreview } = require('./src/link-preview/LinkPreview');
const { StickerPackStore } = require('./src/stickers/StickerPackStore');
const { SidebarStore } = require('./src/sidebar/SidebarStore');
const { searchGifs, resolveKlipyLink, parseKlipyLink } = require('./src/gifs/KlipyClient');

const DEFAULT_PORT = Number(process.env.RELAY_PORT || 6080);
const DEFAULT_HOST = process.env.RELAY_HOST || '127.0.0.1';

let runtime = {
  host: DEFAULT_HOST,
  port: DEFAULT_PORT,
  dataDir: path.join(__dirname, '.relay-data'),
  pluginsDir: path.join(__dirname, 'plugins'),
};

/** @type {import('http').Server | null} */
let activeServer = null;
/** @type {Promise<any> | null} */
let startupPromise = null;

const app = express();
app.use(express.json({ limit: '16mb' }));

// Phone companion (Capacitor) probes /api/health cross-origin before navigating in.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

const pluginHost = new PluginHost({ pluginsDir: runtime.pluginsDir });
const themeHost = new ThemeHost();
const voipConfig = new VoipConfig({ dataDir: runtime.dataDir });
const stickerPacks = new StickerPackStore({ dataDir: runtime.dataDir });
const sidebarStore = new SidebarStore({ dataDir: runtime.dataDir });
const voipHub = new VoipHub();
const { LiveHub } = require('./src/live/LiveHub');
const liveHub = new LiveHub();
const { AppControl } = require('./src/paarrot/AppControl');
const { LocalApi } = require('./src/paarrot/LocalApi');
const { LOCAL_API_HOST, LOCAL_API_PORT } = require('./src/paarrot/constants');
const appControl = new AppControl({ liveHub });
const matrix = new MatrixSession({
  dataDir: runtime.dataDir,
  pluginHost,
  voipHub,
  liveHub,
});
const localApi = new LocalApi({ matrix, appControl });

function configureRuntime(options = {}) {
  if (options.host) runtime.host = options.host;
  if (options.port !== undefined) runtime.port = options.port;
  if (options.dataDir) {
    runtime.dataDir = options.dataDir;
    matrix.dataDir = options.dataDir;
    matrix.sessionFile = path.join(options.dataDir, 'session.json');
    matrix.cryptoSecretsFile = path.join(options.dataDir, 'crypto-secrets.json');
    voipConfig.setDataDir(options.dataDir);
    stickerPacks.setDataDir(options.dataDir);
    sidebarStore.setDataDir(options.dataDir);
  }
  if (options.pluginsDir) {
    runtime.pluginsDir = options.pluginsDir;
    pluginHost.pluginsDir = options.pluginsDir;
    pluginHost.disabledFile = path.join(options.pluginsDir, '.disabled-plugins.json');
  }
}

function getRuntimeState() {
  return {
    host: runtime.host,
    port: runtime.port,
    dataDir: runtime.dataDir,
    pluginsDir: runtime.pluginsDir,
  };
}

app.get('/api/health', (_req, res) => {
  const os = require('os');
  const lanAddresses = [];
  for (const list of Object.values(os.networkInterfaces() || {})) {
    for (const entry of list || []) {
      if (!entry || entry.internal || entry.family !== 'IPv4') continue;
      lanAddresses.push(`http://${entry.address}:${runtime.port}`);
    }
  }
  res.json({
    ok: true,
    name: 'kitsu',
    version: require('./package.json').version,
    host: runtime.host,
    port: runtime.port,
    lanAddresses,
    paarrotApi: { host: LOCAL_API_HOST, port: LOCAL_API_PORT },
  });
});

app.put('/api/control/room', (req, res) => {
  try {
    const roomId = req.body?.roomId ? String(req.body.roomId) : null;
    res.json({ ok: true, currentRoom: appControl.setCurrentRoom(roomId) });
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.put('/api/control/call', (req, res) => {
  try {
    const state = appControl.syncCallState({
      muted: req.body?.muted,
      deafened: req.body?.deafened,
      inCall: req.body?.inCall,
      roomId: req.body?.roomId,
    });
    res.json({ ok: true, ...state });
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.get('/api/control/status', (_req, res) => {
  res.json({ ok: true, ...appControl.getStatus(matrix) });
});

app.get('/api/sidebar', (_req, res) => {
  res.json(sidebarStore.read());
});

app.put('/api/sidebar', (req, res) => {
  try {
    const saved = sidebarStore.write({
      spaceOrder: req.body?.spaceOrder,
      spaceFolders: req.body?.spaceFolders,
      hiddenSpaces: req.body?.hiddenSpaces,
    });
    res.json(saved);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.get('/api/session', (_req, res) => {
  res.json(matrix.getPublicState());
});

app.get('/api/devtools/access-token', (_req, res) => {
  try {
    res.json(matrix.getAccessTokenForDevtools());
  } catch (error) {
    res.status(401).json({ error: error?.message || String(error) });
  }
});

app.get('/api/devtools/account-data', (_req, res) => {
  try {
    res.json(matrix.listAccountDataEvents());
  } catch (error) {
    res.status(401).json({ error: error?.message || String(error) });
  }
});

app.get('/api/devtools/account-data/:eventType', (req, res) => {
  try {
    res.json(matrix.getAccountDataEvent(decodeURIComponent(req.params.eventType)));
  } catch (error) {
    const status = /not logged in/i.test(error?.message || '') ? 401 : 404;
    res.status(status).json({ error: error?.message || String(error) });
  }
});

app.put('/api/devtools/account-data/:eventType', async (req, res) => {
  try {
    const result = await matrix.setAccountDataEvent(
      decodeURIComponent(req.params.eventType),
      req.body?.content ?? req.body,
    );
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.post('/api/devtools/account-data', async (req, res) => {
  try {
    const result = await matrix.setAccountDataEvent(req.body?.type, req.body?.content);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.get('/api/activity', (req, res) => {
  if (!matrix.client) {
    res.status(401).json({ error: 'Not logged in' });
    return;
  }
  const since = Number(req.query.since || 0) || 0;
  res.json(matrix.listActivitySince(since));
});

app.get('/api/live', (req, res) => {
  if (!matrix.client) {
    res.status(401).json({ error: 'Not logged in' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  liveHub.addSseClient(res);

  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(heartbeat);
      liveHub.removeSseClient(res);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    liveHub.removeSseClient(res);
  });
});

app.post('/api/login', async (req, res) => {
  try {
    const state = await matrix.login({
      homeserver: req.body?.homeserver,
      user: req.body?.user,
      password: req.body?.password,
      deviceName: req.body?.deviceName,
    });
    res.json(state);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.post('/api/logout', async (_req, res) => {
  try {
    await matrix.logout();
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error?.message || String(error) });
  }
});

app.get('/api/spaces', (_req, res) => {
  if (!matrix.client) {
    res.status(401).json({ error: 'Not logged in' });
    return;
  }
  res.json({ spaces: matrix.listSpaces(), ready: matrix.ready });
});

app.post('/api/spaces', async (req, res) => {
  try {
    const result = await matrix.createSpace({
      name: req.body?.name,
      topic: req.body?.topic,
      access: req.body?.access,
      forumLayout: Boolean(req.body?.forumLayout),
      allowFederation: req.body?.allowFederation !== false,
    });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.get('/api/spaces/:spaceId', (req, res) => {
  if (!matrix.client) {
    res.status(401).json({ error: 'Not logged in' });
    return;
  }
  const summary = matrix.getSpaceSummary(req.params.spaceId);
  if (!summary) {
    res.status(404).json({ error: 'Space not found' });
    return;
  }
  res.json(summary);
});

app.post('/api/spaces/:spaceId/children', async (req, res) => {
  try {
    const kind = String(req.body?.kind || 'room').toLowerCase();
    const result = await matrix.createSpaceChild(req.params.spaceId, {
      name: req.body?.name,
      topic: req.body?.topic,
      isSpace: kind === 'space',
      access: req.body?.access,
      encryption: Boolean(req.body?.encryption),
      forumLayout: Boolean(req.body?.forumLayout),
      knock: Boolean(req.body?.knock),
      allowFederation: req.body?.allowFederation !== false,
      aliasLocalPart: req.body?.aliasLocalPart,
      roomVersion: req.body?.roomVersion || null,
    });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.get('/api/spaces/:spaceId/forum', (req, res) => {
  if (!matrix.client) {
    res.status(401).json({ error: 'Not logged in' });
    return;
  }
  try {
    const topicRoomId = req.query?.topic ? String(req.query.topic) : null;
    const limit = req.query?.limit ? Number(req.query.limit) : 50;
    const board = matrix.getForumBoard(req.params.spaceId, { topicRoomId, limit });
    res.json(board);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.post('/api/rooms/:roomId/forum-posts', async (req, res) => {
  try {
    const result = await matrix.createForumPost(req.params.roomId, {
      title: req.body?.title,
      body: req.body?.body,
    });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.get('/api/rooms/:roomId/forum-posts/:eventId', (req, res) => {
  if (!matrix.client) {
    res.status(401).json({ error: 'Not logged in' });
    return;
  }
  try {
    const thread = matrix.getForumThread(req.params.roomId, req.params.eventId);
    res.json(thread);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.post('/api/rooms/:roomId/forum-posts/:eventId/replies', async (req, res) => {
  try {
    const result = await matrix.createForumThreadReply(req.params.roomId, req.params.eventId, {
      body: req.body?.body,
      replyToEventId: req.body?.replyToEventId || null,
    });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.post('/api/rooms/:roomId/subrooms', async (req, res) => {
  try {
    const result = await matrix.createSubRoom(req.params.roomId, {
      name: req.body?.name,
      topic: req.body?.topic,
      spaceId: req.body?.spaceId || null,
    });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.post('/api/spaces/:spaceId/invite', async (req, res) => {
  try {
    const result = await matrix.inviteToSpace(req.params.spaceId, req.body?.userId);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.post('/api/spaces/:spaceId/leave', async (req, res) => {
  try {
    const result = await matrix.leaveSpace(req.params.spaceId);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.post('/api/spaces/:spaceId/categories/:categoryId/delete', async (req, res) => {
  try {
    const result = await matrix.deleteCategory(req.params.categoryId, {
      parentSpaceId: req.params.spaceId || req.body?.parentSpaceId || null,
    });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.delete('/api/spaces/:spaceId/children/:childId', async (req, res) => {
  try {
    const result = await matrix.removeSpaceChild(req.params.spaceId, req.params.childId);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.put('/api/spaces/:spaceId/children/order', async (req, res) => {
  try {
    const result = await matrix.reorderSpaceChildren(
      req.params.spaceId,
      req.body?.childIds || req.body?.order || [],
    );
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.put('/api/spaces/:spaceId/categories/order', async (req, res) => {
  try {
    const result = await matrix.reorderSpaceCategories(
      req.params.spaceId,
      req.body?.categoryIds || req.body?.childIds || req.body?.order || [],
    );
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.post('/api/spaces/:spaceId/children/:childId/move', async (req, res) => {
  try {
    const result = await matrix.moveSpaceChild({
      fromParentId: req.body?.fromParentId || req.params.spaceId,
      toParentId: req.body?.toParentId || req.body?.parentId || req.params.spaceId,
      childId: req.params.childId,
      beforeId: req.body?.beforeId || null,
      afterId: req.body?.afterId || null,
    });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.get('/api/avatar/:roomId', async (req, res) => {
  if (!matrix.client) {
    res.status(401).json({ error: 'Not logged in' });
    return;
  }

  try {
    const size = Math.max(16, Math.min(256, Number(req.query.size) || 96));
    const original =
      req.query.original === '1' ||
      req.query.original === 'true' ||
      req.query.transparent === '1';
    const avatar = await matrix.fetchRoomAvatarBuffer(req.params.roomId, size, { original });
    if (!avatar) {
      res.status(404).json({ error: 'No avatar' });
      return;
    }
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.type(avatar.contentType).send(avatar.buffer);
  } catch (error) {
    res.status(404).json({ error: error?.message || 'Avatar unavailable' });
  }
});

app.get('/api/profile-avatar', async (req, res) => {
  if (!matrix.client) {
    res.status(401).json({ error: 'Not logged in' });
    return;
  }

  try {
    const userId = String(req.query.userId || matrix.client.getUserId() || '').trim();
    const size = Math.max(16, Math.min(256, Number(req.query.size) || 96));
    const avatar = await matrix.fetchProfileAvatarBuffer(userId, size);
    if (!avatar) {
      res.status(404).json({ error: 'No avatar' });
      return;
    }
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.type(avatar.contentType).send(avatar.buffer);
  } catch (error) {
    res.status(404).json({ error: error?.message || 'Avatar unavailable' });
  }
});

app.get('/api/paarrot-colors', async (req, res) => {
  if (!matrix.client) {
    res.status(401).json({ error: 'Not logged in' });
    return;
  }
  try {
    const userId = String(req.query.userId || matrix.client.getUserId() || '').trim();
    const colors = await matrix.fetchAvatarPaarrotColors(userId);
    res.json({ userId, colors: colors || null });
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.get('/api/nameplates/panda/meta', (_req, res) => {
  try {
    const { extractMetadataFromPNG } = require('./src/paarrot/pngMetadata');
    const fs = require('fs');
    const path = require('path');
    const file = path.join(__dirname, 'public', 'nameplates', 'panda.png');
    const meta = extractMetadataFromPNG(fs.readFileSync(file));
    res.json({ id: 'panda', colors: meta });
  } catch (error) {
    res.status(500).json({ error: error?.message || String(error) });
  }
});

app.get('/api/profile', async (req, res) => {
  try {
    const profile = await matrix.getUserProfile(req.query.userId, {
      roomId: req.query.roomId || null,
    });
    res.json(profile);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.post('/api/profile/dm', async (req, res) => {
  try {
    const result = await matrix.ensureDirectRoom(req.body?.userId || req.query.userId, {
      encrypted: req.body?.encrypted !== false,
    });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.get('/api/account', async (_req, res) => {
  try {
    if (!matrix.client) {
      res.status(401).json({ error: 'Not logged in' });
      return;
    }
    const userId = matrix.client.getUserId();
    const profile = await matrix.getUserProfile(userId);
    const emails = await matrix.getAccountEmails();
    res.json({
      ...profile,
      emails,
      email: emails[0] || null,
      ignoredUsers: matrix.getIgnoredUsers(),
      homeserver: matrix.client.getHomeserverUrl(),
    });
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.put('/api/account/displayname', async (req, res) => {
  try {
    const result = await matrix.setDisplayName(req.body?.displayName);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.get('/api/devices', async (_req, res) => {
  try {
    const result = await matrix.listDevices();
    res.json(result);
  } catch (error) {
    const message = error?.message || String(error);
    res.status(/not logged in/i.test(message) ? 401 : 400).json({ error: message });
  }
});

app.put('/api/devices/:deviceId', async (req, res) => {
  try {
    const result = await matrix.renameDevice(req.params.deviceId, req.body?.displayName);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.delete('/api/devices/:deviceId', async (req, res) => {
  try {
    const result = await matrix.logoutDevice(req.params.deviceId, {
      password: req.body?.password || null,
    });
    res.json(result);
  } catch (error) {
    if (error?.code === 'NEEDS_PASSWORD') {
      res.status(401).json({
        error: error.message || 'Password required to remove devices',
        needsPassword: true,
        session: error.session || null,
      });
      return;
    }
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.post('/api/devices/delete', async (req, res) => {
  try {
    const deviceIds = Array.isArray(req.body?.deviceIds) ? req.body.deviceIds : [];
    const result = await matrix.logoutDevices(deviceIds, {
      password: req.body?.password || null,
    });
    res.json(result);
  } catch (error) {
    if (error?.code === 'NEEDS_PASSWORD') {
      res.status(401).json({
        error: error.message || 'Password required to remove devices',
        needsPassword: true,
        session: error.session || null,
      });
      return;
    }
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.post('/api/crypto/setup', async (req, res) => {
  try {
    const result = await matrix.setupEncryption({
      recoveryKey: req.body?.recoveryKey || null,
      password: req.body?.password || null,
      setupNewCrossSigning: Boolean(req.body?.resetCrossSigning),
      setupBackup: req.body?.setupBackup !== false,
    });
    res.json(result);
  } catch (error) {
    if (error?.code === 'NEEDS_PASSWORD' || error?.needsPassword) {
      res.status(401).json({
        error: error.message || 'Account password required to finish verifying this device',
        needsPassword: true,
        session: error.session || null,
      });
      return;
    }
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.post('/api/crypto/verify', async (req, res) => {
  try {
    const result = await matrix.verifyOwnDevice({
      recoveryKey: req.body?.recoveryKey,
      password: req.body?.password || null,
    });
    res.json(result);
  } catch (error) {
    if (error?.code === 'NEEDS_PASSWORD' || error?.needsPassword) {
      res.status(401).json({
        error: error.message || 'Account password required to finish verifying this device',
        needsPassword: true,
        session: error.session || null,
      });
      return;
    }
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.post('/api/devices/:deviceId/verify', async (req, res) => {
  try {
    const result = await matrix.verifyDevice(req.params.deviceId);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.post('/api/crypto/backup', async (req, res) => {
  try {
    const result = await matrix.enableKeyBackup({
      recoveryKey: req.body?.recoveryKey,
      password: req.body?.password || null,
    });
    res.json(result);
  } catch (error) {
    if (error?.code === 'NEEDS_PASSWORD' || error?.needsPassword) {
      res.status(401).json({
        error: error.message || 'Account password required to finish verifying this device',
        needsPassword: true,
        session: error.session || null,
      });
      return;
    }
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.get('/api/crypto/recovery-key', (_req, res) => {
  if (!matrix.client) {
    res.status(401).json({ error: 'Not logged in' });
    return;
  }
  const recoveryKey = matrix.getCachedRecoveryKey();
  res.json({
    hasRecoveryKey: Boolean(recoveryKey),
    recoveryKey: recoveryKey || null,
  });
});

app.get('/api/notifications/rules', async (_req, res) => {
  try {
    const result = await matrix.getNotificationSettings();
    res.json(result);
  } catch (error) {
    const message = error?.message || String(error);
    res.status(/not logged in/i.test(message) ? 401 : 400).json({ error: message });
  }
});

app.put('/api/notifications/rules', async (req, res) => {
  try {
    const result = await matrix.setNotificationRuleMode(
      req.body?.kind,
      req.body?.ruleId,
      req.body?.mode,
    );
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.post('/api/notifications/keywords', async (req, res) => {
  try {
    const result = await matrix.addNotificationKeyword(req.body?.keyword, req.body?.mode || 'loud');
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.delete('/api/notifications/keywords/:ruleId', async (req, res) => {
  try {
    const result = await matrix.removeNotificationKeyword(
      decodeURIComponent(req.params.ruleId || ''),
    );
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.put('/api/account/style', async (req, res) => {
  try {
    const result = await matrix.setProfileStyle(req.body?.style ?? null);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.put('/api/account/presence', async (req, res) => {
  try {
    const result = await matrix.setPresenceState(req.body?.presence, {
      statusMsg: req.body?.statusMsg,
    });
    res.json(result);
  } catch (error) {
    const message = error?.message || String(error);
    const rateLimited = /rate-limited|too many requests|\b429\b/i.test(message);
    res.status(rateLimited ? 429 : 400).json({ error: message });
  }
});

app.post('/api/account/status', async (req, res) => {
  try {
    const result = await matrix.setCustomStatus(req.body?.statusMsg);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.post('/api/account/image', async (req, res) => {
  try {
    const result = await matrix.uploadProfileImage(req.body?.dataUrl, {
      asBanner: Boolean(req.body?.asBanner),
    });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.get('/api/account/ignored', (_req, res) => {
  if (!matrix.client) {
    res.status(401).json({ error: 'Not logged in' });
    return;
  }
  res.json({ ignoredUsers: matrix.getIgnoredUsers() });
});

app.post('/api/account/block', async (req, res) => {
  try {
    const result = await matrix.blockUser(req.body?.userId);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.post('/api/account/unblock', async (req, res) => {
  try {
    const result = await matrix.unblockUser(req.body?.userId);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.get('/api/rooms', (_req, res) => {
  if (!matrix.client) {
    res.status(401).json({ error: 'Not logged in' });
    return;
  }
  const filter = String(_req.query.space || _req.query.filter || 'home').trim() || 'home';
  const payload = {
    rooms: matrix.listRooms({ filter }),
    filter,
    ready: matrix.ready,
    groups: [],
  };
  if (filter.startsWith('!')) {
    const sidebar = matrix.listSpaceSidebar(filter);
    payload.groups = sidebar.groups || [];
    payload.parents = sidebar.parents || [];
    payload.space = sidebar.space || null;
    // Prefer hierarchy-ordered flat list when available.
    if (Array.isArray(sidebar.rooms) && sidebar.rooms.length) {
      payload.rooms = sidebar.rooms;
    }
  }
  res.json(payload);
});

app.get('/api/rooms/:roomId', (req, res) => {
  if (!matrix.client) {
    res.status(401).json({ error: 'Not logged in' });
    return;
  }
  const summary = matrix.getRoomSummary(req.params.roomId);
  if (!summary) {
    res.status(404).json({ error: 'Room not found' });
    return;
  }
  res.json(summary);
});

app.get('/api/rooms/:roomId/members', async (req, res) => {
  try {
    const result = await matrix.listRoomMembers(req.params.roomId);
    res.json(result);
  } catch (error) {
    const message = error?.message || String(error);
    const status = /not logged in/i.test(message)
      ? 401
      : /not found/i.test(message)
        ? 404
        : 400;
    res.status(status).json({ error: message });
  }
});

app.post('/api/rooms/:roomId/read', async (req, res) => {
  try {
    const result = await matrix.markRoomRead(req.params.roomId);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.post('/api/rooms/:roomId/typing', async (req, res) => {
  try {
    const result = await matrix.setTyping(
      req.params.roomId,
      req.body?.typing !== false && req.body?.typing !== 0,
      req.body?.timeoutMs || req.body?.timeout || 20000,
    );
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.get('/api/rooms/:roomId/typing', (req, res) => {
  if (!matrix.client) {
    res.status(401).json({ error: 'Not logged in' });
    return;
  }
  try {
    res.json({
      ok: true,
      roomId: req.params.roomId,
      users: matrix.getTypingUsers(req.params.roomId),
    });
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.post('/api/rooms/:roomId/invite', async (req, res) => {
  try {
    const result = await matrix.inviteToRoom(req.params.roomId, req.body?.userId);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.get('/api/invites', (_req, res) => {
  if (!matrix.client) {
    res.status(401).json({ error: 'Not logged in' });
    return;
  }
  const invites = matrix.listInvites();
  res.json({ invites, count: invites.length, ready: matrix.ready });
});

app.post('/api/invites/:roomId/accept', async (req, res) => {
  try {
    const result = await matrix.acceptInvite(req.params.roomId);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.post('/api/invites/:roomId/reject', async (req, res) => {
  try {
    const result = await matrix.rejectInvite(req.params.roomId);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.get('/api/explore/rooms', async (req, res) => {
  try {
    const roomTypesRaw = String(req.query.roomTypes || req.query.type || '').trim();
    let roomTypes;
    if (roomTypesRaw === 'spaces' || roomTypesRaw === 'm.space') roomTypes = ['m.space'];
    else if (roomTypesRaw === 'rooms' || roomTypesRaw === 'null') roomTypes = [null];
    const result = await matrix.explorePublicRooms({
      server: req.query.server,
      term: req.query.q || req.query.term || '',
      limit: req.query.limit,
      since: req.query.since || null,
      roomTypes,
    });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.post('/api/join', async (req, res) => {
  try {
    const result = await matrix.joinByIdOrAlias(req.body?.id || req.body?.alias || req.body?.link, {
      autoJoinSpaceRooms: Boolean(req.body?.autoJoinSpaceRooms),
    });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.post('/api/rooms/:roomId/leave', async (req, res) => {
  try {
    const result = await matrix.leaveRoom(req.params.roomId);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.post('/api/rooms/:roomId/mute', async (req, res) => {
  try {
    const result = await matrix.setRoomMuted(req.params.roomId, req.body?.muted !== false);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.post('/api/rooms/:roomId/notifications', async (req, res) => {
  try {
    const result = await matrix.setRoomNotificationLevel(
      req.params.roomId,
      req.body?.level || 'all',
    );
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.patch('/api/rooms/:roomId', async (req, res) => {
  try {
    const result = await matrix.updateRoomProfile(req.params.roomId, {
      name: req.body?.name,
      topic: req.body?.topic,
      joinRule: req.body?.joinRule || req.body?.join_rule,
    });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.post('/api/rooms/:roomId/avatar', async (req, res) => {
  try {
    const dataUrl = req.body?.dataUrl || req.body?.image || null;
    const result = await matrix.uploadRoomAvatar(req.params.roomId, dataUrl);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.delete('/api/rooms/:roomId/avatar', async (req, res) => {
  try {
    const result = await matrix.removeRoomAvatar(req.params.roomId);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.post('/api/rooms/:roomId/members/:userId/moderate', async (req, res) => {
  try {
    const result = await matrix.moderateMember(
      req.params.roomId,
      decodeURIComponent(req.params.userId),
      req.body?.action,
      { reason: req.body?.reason },
    );
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.get('/api/rooms/:roomId/threads', (req, res) => {
  try {
    res.json(matrix.listRoomThreads(req.params.roomId));
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.post('/api/rooms/:roomId/messages/:eventId/forward', async (req, res) => {
  try {
    const result = await matrix.forwardMessage(
      req.params.roomId,
      req.params.eventId,
      req.body?.targetRoomId,
    );
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.post('/api/devices/:deviceId/verify-sas', async (req, res) => {
  try {
    const result = await matrix.startDeviceVerification(req.params.deviceId);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.post('/api/devices/verify-sas/confirm', async (req, res) => {
  try {
    const result = await matrix.confirmDeviceVerification(req.body?.match !== false);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.get('/api/rooms/:roomId/messages', async (req, res) => {
  if (!matrix.client) {
    res.status(401).json({ error: 'Not logged in' });
    return;
  }
  const limit = Number(req.query.limit || 50);
  const history = String(req.query.history || '') === '1' || String(req.query.history || '') === 'true';
  const minEvents = Number(req.query.minEvents || Math.max(limit, 120));
  const minMessages = Number(req.query.minMessages || Math.max(limit, 80));
  try {
    let historyMeta = null;
    // Always hydrate thin timelines on open — initial /sync only keeps a small window,
    // so messages from other clients while offline would otherwise be missing.
    if (history) {
      historyMeta = await matrix.ensureRoomHistory(req.params.roomId, {
        minEvents: Math.max(minEvents, minMessages),
        minMessages,
        batchSize: 100,
        maxBatches: 80,
      });
    } else {
      historyMeta = await matrix.hydrateRoomTimeline(req.params.roomId, {
        minMessages: Math.min(400, Math.max(80, Number(limit) || 50)),
        maxBatches: 40,
      });
    }
    const atStart = await matrix.isRoomTimelineAtStart(req.params.roomId);
    res.json({
      roomId: req.params.roomId,
      messages: await matrix.getRoomTimeline(req.params.roomId, limit),
      atStart,
      history: historyMeta,
    });
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.post('/api/rooms/:roomId/messages/older', async (req, res) => {
  if (!matrix.client) {
    res.status(401).json({ error: 'Not logged in' });
    return;
  }
  const limit = Number(req.body?.limit || req.query.limit || 100);
  const displayLimit = Number(req.body?.displayLimit || req.query.displayLimit || 500);
  try {
    // One API call can backfill several HS pages so scroll-up reaches older history faster.
    const history = await matrix.ensureRoomHistory(req.params.roomId, {
      minEvents: Math.max(displayLimit * 2, 200),
      minMessages: Math.max(displayLimit, 200),
      batchSize: Math.max(80, Math.min(200, limit)),
      maxBatches: 6,
    });
    res.json({
      roomId: req.params.roomId,
      messages: await matrix.getRoomTimeline(req.params.roomId, displayLimit),
      added: history.added,
      eventCount: history.eventCount,
      atStart: history.atStart,
    });
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.get('/api/rooms/:roomId/media', async (req, res) => {
  try {
    const result = await matrix.listRoomMedia(req.params.roomId, Number(req.query.limit || 200));
    res.json(result);
  } catch (error) {
    const message = error?.message || String(error);
    const status = /not logged in/i.test(message)
      ? 401
      : /not found/i.test(message)
        ? 404
        : 400;
    res.status(status).json({ error: message });
  }
});

app.get('/api/rooms/:roomId/pins', async (req, res) => {
  try {
    const result = await matrix.listPinnedMessages(req.params.roomId);
    res.json(result);
  } catch (error) {
    const message = error?.message || String(error);
    const status = /not logged in/i.test(message)
      ? 401
      : /not found/i.test(message)
        ? 404
        : 400;
    res.status(status).json({ error: message });
  }
});

app.post('/api/search/messages', async (req, res) => {
  try {
    const result = await matrix.searchMessages({
      term: req.body?.term || req.body?.query || '',
      roomIds: Array.isArray(req.body?.roomIds) ? req.body.roomIds : null,
      limit: Number(req.body?.limit || 40),
    });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.post('/api/rooms/:roomId/pins/:eventId/unpin', async (req, res) => {
  try {
    const result = await matrix.setEventPinned(req.params.roomId, req.params.eventId, false);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.post('/api/rooms/:roomId/pins/:eventId/pin', async (req, res) => {
  try {
    const result = await matrix.setEventPinned(req.params.roomId, req.params.eventId, true);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.post('/api/rooms/:roomId/messages/:eventId/redact', async (req, res) => {
  try {
    const result = await matrix.redactMessage(
      req.params.roomId,
      req.params.eventId,
      req.body?.reason,
    );
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.post('/api/rooms/:roomId/send', async (req, res) => {
  try {
    const result = await matrix.sendText(req.params.roomId, req.body?.body, {
      mentions: req.body?.mentions,
      formattedBody: req.body?.formatted_body || req.body?.formattedBody || null,
      replyToEventId: req.body?.replyToEventId || req.body?.reply_to || null,
      threadRootId: req.body?.threadRootId || req.body?.thread_root || null,
    });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.post('/api/rooms/:roomId/messages/:eventId/edit', async (req, res) => {
  try {
    const result = await matrix.editMessage(req.params.roomId, req.params.eventId, {
      body: req.body?.body,
      formattedBody: req.body?.formatted_body || req.body?.formattedBody || null,
    });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.get('/api/rooms/:roomId/messages/:eventId/source', (req, res) => {
  if (!matrix.client) {
    res.status(401).json({ error: 'Not logged in' });
    return;
  }
  try {
    const source = matrix.getEventSource(req.params.roomId, req.params.eventId);
    res.json(source);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.post('/api/rooms/:roomId/messages/:eventId/react', async (req, res) => {
  try {
    const result = await matrix.toggleReaction(
      req.params.roomId,
      req.params.eventId,
      req.body?.key || req.body?.reaction,
    );
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.post('/api/rooms/:roomId/emoji-confetti', async (req, res) => {
  try {
    const result = await matrix.sendEmojiConfetti(req.params.roomId, {
      emojis: req.body?.emojis,
      targetEventId: req.body?.targetEventId || req.body?.eventId || null,
    });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.post('/api/rooms/:roomId/send-image', async (req, res) => {
  try {
    if (req.body?.url) {
      const result = await matrix.sendImageFromUrl(
        req.params.roomId,
        req.body.url,
        req.body?.filename || 'image.gif',
      );
      res.json(result);
      return;
    }

    const dataUrl = String(req.body?.dataUrl || '');
    const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
    if (!match) {
      res.status(400).json({ error: 'Provide url or dataUrl' });
      return;
    }
    const buffer = Buffer.from(match[2], 'base64');
    const filename = req.body?.filename || 'upload.png';
    const contentType = matrix.normalizeImageContentType(
      req.body?.contentType || match[1] || 'image/png',
      filename,
      buffer,
    );
    const result = await matrix.sendImageBuffer(req.params.roomId, buffer, {
      contentType,
      filename,
      caption: req.body?.caption || null,
      formatted_body: req.body?.formatted_body || null,
      mentions: Array.isArray(req.body?.mentions) ? req.body.mentions : null,
      blurhash: req.body?.blurhash || null,
      width: req.body?.width || null,
      height: req.body?.height || null,
      carousel: req.body?.carousel || null,
    });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.post('/api/rooms/:roomId/send-video', async (req, res) => {
  try {
    const dataUrl = String(req.body?.dataUrl || '');
    const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
    if (!match) {
      res.status(400).json({ error: 'Provide dataUrl' });
      return;
    }
    const buffer = Buffer.from(match[2], 'base64');
    const filename = req.body?.filename || 'video.webm';
    const contentType = req.body?.contentType || match[1] || 'video/webm';
    const result = await matrix.sendVideoBuffer(req.params.roomId, buffer, {
      contentType,
      filename,
      caption: req.body?.caption || null,
      width: req.body?.width || null,
      height: req.body?.height || null,
    });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

/** Binary file upload (avoids base64 JSON size limits for large attachments). */
app.post(
  '/api/rooms/:roomId/send-file',
  express.raw({ type: () => true, limit: '256mb' }),
  async (req, res) => {
    try {
      const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);
      if (!buffer.length) {
        res.status(400).json({ error: 'Empty file' });
        return;
      }
      const filename =
        String(req.query?.filename || req.get('x-filename') || 'file').trim() || 'file';
      const contentType =
        String(req.query?.contentType || req.get('content-type') || 'application/octet-stream')
          .split(';')[0]
          .trim() || 'application/octet-stream';
      const captionHeader = req.get('x-caption');
      const caption =
        captionHeader != null && captionHeader !== ''
          ? (() => {
              try {
                return decodeURIComponent(captionHeader);
              } catch {
                return captionHeader;
              }
            })()
          : null;
      const result = await matrix.sendFileBuffer(req.params.roomId, buffer, {
        contentType,
        filename,
        caption,
      });
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: error?.message || String(error) });
    }
  },
);

app.get('/api/stickers', (_req, res) => {
  try {
    res.json(stickerPacks.listPacks());
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.put('/api/stickers/telegram-token', (req, res) => {
  try {
    res.json(stickerPacks.setTelegramToken(req.body?.token));
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.put('/api/stickers/default', (req, res) => {
  try {
    res.json(stickerPacks.setDefaultPack(req.body?.packId));
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.put('/api/stickers/favorites', (req, res) => {
  try {
    res.json(stickerPacks.setFavoritePacks(req.body?.packIds));
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.post('/api/stickers/telegram/import', async (req, res) => {
  try {
    const result = await stickerPacks.importTelegramPack(req.body?.url || req.body?.packUrl);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.get('/api/stickers/file/:packName/:fileName', (req, res) => {
  try {
    const packName = decodeURIComponent(String(req.params.packName || ''));
    const fileName = decodeURIComponent(String(req.params.fileName || ''));
    const filePath =
      stickerPacks.resolveStickerFile(packName, fileName) ||
      stickerPacks.resolveStickerFile(`tg-${packName}`, fileName) ||
      stickerPacks.resolveStickerFile(`bundled-${packName}`, fileName);
    if (!filePath) {
      res.status(404).json({ error: 'Sticker not found' });
      return;
    }
    res.sendFile(filePath);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.get('/api/gifs', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const limit = Number(req.query.limit || 24) || 24;
  try {
    const gifs = await searchGifs(q, { limit });
    res.json({
      gifs,
      source: 'klipy',
      mode: q ? 'search' : 'featured',
    });
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error), source: 'klipy' });
  }
});

app.get('/api/gifs/resolve', async (req, res) => {
  try {
    const url = String(req.query.url || '').trim();
    if (!parseKlipyLink(url)) {
      res.status(400).json({ error: 'Not a Klipy GIF link' });
      return;
    }
    const resolved = await resolveKlipyLink(url);
    res.json(resolved);
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.get('/api/media', async (req, res) => {
  if (!matrix.client) {
    res.status(401).json({ error: 'Not logged in' });
    return;
  }

  try {
    const remoteUrl = String(req.query.url || '');
    if (!/^https?:\/\//i.test(remoteUrl)) {
      res.status(400).json({ error: 'Invalid media url' });
      return;
    }

    const homeserver = new URL(matrix.client.getHomeserverUrl());
    const target = new URL(remoteUrl);
    const allowedHosts = new Set([
      homeserver.host,
      `matrix-media.${homeserver.hostname}`,
      homeserver.hostname,
    ]);
    // Allow common Matrix media hosts for this session's HS + matrix.org CDN style paths
    if (![...allowedHosts].some((host) => target.host === host || target.host.endsWith(homeserver.hostname))) {
      // Still allow if path looks like Matrix client media
      if (!/\/_matrix\/(client|media)\//.test(target.pathname)) {
        res.status(403).json({ error: 'Blocked media host' });
        return;
      }
    }

    const token = matrix.client.getAccessToken();
    const response = await fetch(remoteUrl, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      redirect: 'follow',
    });
    if (!response.ok) {
      res.status(response.status).json({ error: 'Media fetch failed' });
      return;
    }
    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const buffer = Buffer.from(await response.arrayBuffer());
    const asDownload = String(req.query.download || '') === '1';
    const filenameHint = String(req.query.filename || '').trim();
    let resolvedType = contentType;
    const looksSvg =
      /\.svg$/i.test(filenameHint) ||
      /^image\/svg\+xml/i.test(contentType) ||
      /^\s*<\?xml[\s\S]*<svg[\s>]/i.test(buffer.toString('utf8', 0, Math.min(buffer.length, 512))) ||
      /^\s*<svg[\s>]/i.test(buffer.toString('utf8', 0, Math.min(buffer.length, 256)));
    if (looksSvg && (!contentType || /octet-stream|text\/plain/i.test(contentType))) {
      resolvedType = 'image/svg+xml';
    }
    if (asDownload) {
      const filename = String(req.query.filename || 'image').replace(/[^\w.\-()+ ]+/g, '_') || 'image';
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    }
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.type(resolvedType);
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ error: error?.message || String(error) });
  }
});

app.get('/api/link-preview', async (req, res) => {
  if (!matrix.client) {
    res.status(401).json({ error: 'Not logged in' });
    return;
  }

  try {
    const url = String(req.query.url || '').trim();
    if (!url) {
      res.status(400).json({ error: 'url is required' });
      return;
    }
    const roomId = String(req.query.roomId || '').trim() || null;
    if (roomId && matrix.shouldDisableEmbed(roomId, url)) {
      res.json({ ok: true, preview: null, disabled: true });
      return;
    }
    const preview = await fetchLinkPreview(url);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.json({ ok: true, preview });
  } catch (error) {
    const message = error?.name === 'AbortError' ? 'Preview timed out' : error?.message || String(error);
    res.status(400).json({ error: message });
  }
});

app.get('/api/rooms/:roomId/embed-filters', (req, res) => {
  try {
    res.json({ ok: true, ...matrix.getEmbedFilters(req.params.roomId) });
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.put('/api/rooms/:roomId/embed-filters/personal', async (req, res) => {
  try {
    const content = await matrix.setPersonalEmbedFilters(
      req.params.roomId,
      req.body?.disabledPatterns,
    );
    res.json({ ok: true, personal: content });
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.put('/api/rooms/:roomId/embed-filters/room', async (req, res) => {
  try {
    const content = await matrix.setRoomWideEmbedFilters(
      req.params.roomId,
      req.body?.disabledPatterns,
    );
    res.json({ ok: true, roomWide: content });
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.get('/api/account/fav-emojis', (_req, res) => {
  try {
    res.json({ ok: true, usage: matrix.getFavEmojis() });
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.put('/api/account/fav-emojis', async (req, res) => {
  try {
    const usage = await matrix.setFavEmojis(req.body?.usage || req.body);
    res.json({ ok: true, usage });
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.get('/api/rooms/:roomId/emotes', (req, res) => {
  try {
    res.json({ ok: true, ...matrix.getRoomEmotes(req.params.roomId) });
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.get('/api/themes', async (_req, res) => {
  try {
    const themes = themeHost.isConfigured()
      ? await themeHost.getCatalog()
      : themeHost.getCachedCatalog();
    res.json({
      ok: true,
      themes,
      fetchedAt: themeHost.fetchedAt,
      configured: themeHost.isConfigured(),
    });
  } catch (error) {
    res.status(500).json({ error: error?.message || 'Failed to load themes' });
  }
});

app.get('/api/themes/:id/css', async (req, res) => {
  try {
    const themeId = String(req.params.id || '').trim();
    const css = await themeHost.getThemeCss(themeId);
    if (!css) {
      res.status(404).type('text/plain').send('Theme CSS not found.');
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.type('text/css').send(css);
  } catch (error) {
    res.status(500).type('text/plain').send(error?.message || 'Failed to load theme CSS');
  }
});

app.get('/api/plugins', (_req, res) => {
  res.json({ plugins: pluginHost.listPlugins() });
});

app.post('/api/plugins/:id/enable', async (req, res) => {
  try {
    await pluginHost.setEnabled(req.params.id, true);
    res.json({ ok: true, plugins: pluginHost.listPlugins() });
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.post('/api/plugins/:id/disable', async (req, res) => {
  try {
    await pluginHost.setEnabled(req.params.id, false);
    res.json({ ok: true, plugins: pluginHost.listPlugins() });
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.get('/api/voip/config', (_req, res) => {
  res.json({ ok: true, config: voipConfig.getPublic() });
});

app.put('/api/voip/config', (req, res) => {
  try {
    const body = req.body || {};
    const uris = Array.isArray(body.uris)
      ? body.uris
      : String(body.urisText || '')
          .split(/[\n,]+/)
          .map((u) => u.trim())
          .filter(Boolean);

    const config = voipConfig.write({
      uris,
      username: body.username,
      credential: body.credential,
      sharedSecret: body.sharedSecret,
      ttl: body.ttl,
      forceTurn: body.forceTurn,
      clearCredential: Boolean(body.clearCredential),
      clearSharedSecret: Boolean(body.clearSharedSecret),
    });
    res.json({ ok: true, config });
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.get('/api/voip/ice', async (_req, res) => {
  if (!matrix.client) {
    res.status(401).json({ error: 'Not logged in' });
    return;
  }

  try {
    const userId = matrix.client.getUserId();
    const custom = voipConfig.buildCustomIceServers(userId);
    const hs = await matrix.fetchHomeserverTurn();
    const iceServers = [];

    // Relay-owned TURN first so forceTURN uses your coturn when configured.
    for (const entry of custom) iceServers.push(entry);
    if (hs) {
      iceServers.push({
        urls: hs.urls,
        username: hs.username,
        credential: hs.credential,
      });
    }

    const publicConfig = voipConfig.getPublic();
    res.json({
      ok: true,
      iceServers,
      forceTurn: publicConfig.forceTurn,
      sources: {
        relay: custom.length > 0,
        homeserver: Boolean(hs),
      },
      config: publicConfig,
    });
  } catch (error) {
    res.status(500).json({ error: error?.message || String(error) });
  }
});

app.get('/api/voip/events', (req, res) => {
  if (!matrix.client) {
    res.status(401).json({ error: 'Not logged in' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  voipHub.addSseClient(res);

  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(heartbeat);
      voipHub.removeSseClient(res);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    voipHub.removeSseClient(res);
  });
});

app.post('/api/voip/signal', async (req, res) => {
  try {
    const roomId = String(req.body?.roomId || '').trim();
    const type = String(req.body?.type || '').trim();
    const content = req.body?.content;
    if (!roomId || !type) {
      res.status(400).json({ error: 'roomId and type are required' });
      return;
    }
    if (!content || typeof content !== 'object') {
      res.status(400).json({ error: 'content is required' });
      return;
    }
    const result = await matrix.sendCallEvent(roomId, type, content);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.get('/api/voip/livekit/status', async (req, res) => {
  try {
    const roomId = String(req.query.roomId || '').trim();
    if (!roomId) {
      res.status(400).json({ error: 'roomId is required' });
      return;
    }
    const status = await matrix.getLiveKitStatus(roomId);
    res.json({ ok: true, ...status });
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.post('/api/voip/livekit/join', async (req, res) => {
  try {
    const roomId = String(req.body?.roomId || '').trim();
    if (!roomId) {
      res.status(400).json({ error: 'roomId is required' });
      return;
    }
    const result = await matrix.joinLiveKit(roomId);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.post('/api/voip/livekit/membership', async (req, res) => {
  try {
    const roomId = String(req.body?.roomId || '').trim();
    if (!roomId) {
      res.status(400).json({ error: 'roomId is required' });
      return;
    }
    const result = await matrix.setCallMembership(roomId, {
      active: req.body?.active !== false,
      callId: req.body?.callId || null,
      livekitServiceUrl: req.body?.livekitServiceUrl || null,
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.get('/api/voip/livekit/members', (req, res) => {
  try {
    const roomId = String(req.query.roomId || '').trim();
    if (!roomId) {
      res.status(400).json({ error: 'roomId is required' });
      return;
    }
    res.json({ ok: true, members: matrix.getActiveCallMembers(roomId) });
  } catch (error) {
    res.status(400).json({ error: error?.message || String(error) });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

async function startServer(options = {}) {
  if (activeServer?.listening) {
    return { app, server: activeServer, ...getRuntimeState() };
  }
  if (startupPromise) return startupPromise;

  configureRuntime(options);

  startupPromise = (async () => {
    const bootStarted = Date.now();
    // Overlap heavy matrix-js-sdk import with plugin init + listen.
    const { warmSdk } = require('./src/matrix/MatrixSession');
    void warmSdk();

    await pluginHost.init();
    matrix.primeBootSession();

    const result = await new Promise((resolve, reject) => {
      const tryListen = (port, allowFallback) => {
        const server = app.listen(port, runtime.host, () => {
          activeServer = server;
          const address = server.address();
          if (address && typeof address === 'object') {
            runtime.port = address.port;
          }
          startupPromise = null;
          console.log(
            `Kitsu listening on http://${runtime.host}:${runtime.port} (listen ${Date.now() - bootStarted}ms)`,
          );

          // Session restore (crypto + sync) continues in background so Electron can open immediately.
          void matrix
            .restore()
            .then(() => {
              console.log(
                `[relay] session restore finished (+${Date.now() - bootStarted}ms from boot)`,
              );
            })
            .catch((error) => {
              console.error('[relay] background session restore failed:', error);
            });

          void (async () => {
            if (!themeHost.isConfigured()) return;
            try {
              await themeHost.getCatalog();
            } catch (error) {
              console.error('Background theme catalog fetch failed:', error);
            }
          })();

          resolve({ app, server, ...getRuntimeState() });
        });

        server.on('error', (error) => {
          if (
            allowFallback &&
            error &&
            (error.code === 'EADDRINUSE' || /EADDRINUSE/i.test(String(error.message || '')))
          ) {
            console.warn(
              `[relay] port ${port} busy — falling back to an ephemeral port`,
            );
            tryListen(0, false);
            return;
          }
          startupPromise = null;
          activeServer = null;
          reject(error);
        });
      };

      tryListen(runtime.port, runtime.port !== 0);
    });

    try {
      await localApi.start({ host: LOCAL_API_HOST, port: LOCAL_API_PORT });
    } catch (error) {
      if (error?.code === 'EADDRINUSE') {
        console.warn(
          `[relay] Paarrot local API port ${LOCAL_API_PORT} busy — Stream Deck API disabled`,
        );
      } else {
        console.warn('[relay] Paarrot local API failed to start:', error?.message || error);
      }
    }
    return result;
  })().catch((error) => {
    startupPromise = null;
    throw error;
  });

  return startupPromise;
}

async function stopServer() {
  await localApi.stop().catch(() => {});

  if (matrix.client) {
    try {
      matrix.client.stopClient();
    } catch {
      // ignore
    }
    matrix.client = null;
    matrix.ready = false;
  }

  if (!activeServer) return;

  const serverToClose = activeServer;
  activeServer = null;

  await new Promise((resolve, reject) => {
    serverToClose.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

module.exports = {
  app,
  configureRuntime,
  getRuntimeState,
  startServer,
  stopServer,
};

if (require.main === module) {
  startServer().catch((error) => {
    console.error('Failed to start Kitsu:', error);
    process.exit(1);
  });
}
