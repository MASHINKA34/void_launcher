const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const config = require('./config');
const auth = require('./src/auth');
const { fetchWithTimeout } = require('./src/net');
const modSync = require('./src/modSync');

app.commandLine.appendSwitch('disable-gpu-disk-cache');
app.commandLine.appendSwitch('no-sandbox');

let mainWindow = null;
let tray = null;
let activeAuthProfile = null;

// ─── Window ───────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 600,
    minWidth: 900,
    minHeight: 600,
    maxWidth: 900,
    maxHeight: 600,
    resizable: false,
    frame: false,
    center: true,
    backgroundColor: '#0d0618',
    show: false,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ─── Window controls ──────────────────────────────────────────────────────────

ipcMain.handle('minimize-window', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.handle('close-window', () => {
  app.quit();
});

// ─── Settings ─────────────────────────────────────────────────────────────────

function getDefaultSettings() {
  return {
    ram: 4,
    width: 1280,
    height: 720,
    gameDir: path.join(app.getPath('userData'), config.GAME_DIR_NAME),
    javaPath: 'auto',
    autoJoinServer: false,
    fullscreen: false,
    distantHorizons: false,
    gpu: 'auto'
  };
}

ipcMain.handle('get-settings', () => {
  const settingsPath = path.join(app.getPath('userData'), 'settings.json');
  const defaults = getDefaultSettings();
  try {
    if (fs.existsSync(settingsPath)) {
      const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      return { ...defaults, ...saved };
    }
  } catch (_) {}
  return defaults;
});

ipcMain.handle('save-settings', (_, settings) => {
  const settingsPath = path.join(app.getPath('userData'), 'settings.json');
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── Profile ──────────────────────────────────────────────────────────────────

function getUserDataPath(...parts) {
  return path.join(app.getPath('userData'), ...parts);
}

function saveProfileSnapshot(profile) {
  const profilePath = getUserDataPath('profile.json');
  const historyPath = getUserDataPath('profiles-history.json');

  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), 'utf8');

  let history = [];
  try { history = JSON.parse(fs.readFileSync(historyPath, 'utf8')); } catch (_) {}
  history = [profile.username, ...history.filter(n => n !== profile.username)].slice(0, 20);
  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2), 'utf8');
}

function writeSession(username) {
  try {
    fs.writeFileSync(getUserDataPath('session.json'), JSON.stringify({ username }, null, 2), 'utf8');
  } catch (_) {}
}

function clearSession() {
  try {
    const sessionPath = getUserDataPath('session.json');
    if (fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath);
  } catch (_) {}
}

ipcMain.handle('get-profile', () => {
  const profilePath = getUserDataPath('profile.json');
  try {
    if (fs.existsSync(profilePath)) {
      return JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    }
  } catch (_) {}
  return null;
});

ipcMain.handle('save-profile', (_, profile) => {
  try {
    if (!activeAuthProfile?.username || profile?.username !== activeAuthProfile.username) {
      return { success: false, error: 'Сначала войдите в аккаунт с паролем.' };
    }

    saveProfileSnapshot(activeAuthProfile);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-profiles', () => {
  const historyPath = getUserDataPath('profiles-history.json');
  try {
    if (fs.existsSync(historyPath)) return JSON.parse(fs.readFileSync(historyPath, 'utf8'));
  } catch (_) {}
  return [];
});

ipcMain.handle('delete-profile-from-history', (_, username) => {
  const historyPath = getUserDataPath('profiles-history.json');
  try {
    let history = [];
    try { history = JSON.parse(fs.readFileSync(historyPath, 'utf8')); } catch (_) {}
    history = history.filter(n => n !== username);
    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2), 'utf8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('delete-profile', () => {
  const profilePath = getUserDataPath('profile.json');
  try {
    activeAuthProfile = null;
    clearSession();
    if (fs.existsSync(profilePath)) fs.unlinkSync(profilePath);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('auth-register', (_, credentials) => {
  try {
    const result = auth.register(
      app.getPath('userData'),
      credentials?.username,
      credentials?.password
    );
    if (!result.success) return result;

    activeAuthProfile = result.profile;
    saveProfileSnapshot(result.profile);
    if (credentials?.remember) writeSession(result.profile.username);
    else clearSession();
    return result;
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('auth-login', (_, credentials) => {
  try {
    const result = auth.login(
      app.getPath('userData'),
      credentials?.username,
      credentials?.password
    );
    if (!result.success) return result;

    activeAuthProfile = result.profile;
    saveProfileSnapshot(result.profile);
    if (credentials?.remember) writeSession(result.profile.username);
    else clearSession();
    return result;
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('auth-logout', () => {
  activeAuthProfile = null;
  clearSession();
  return { success: true };
});

ipcMain.handle('auth-restore-session', () => {
  const sessionPath = getUserDataPath('session.json');
  try {
    if (!fs.existsSync(sessionPath)) return { success: false };
    const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    if (!session?.username) return { success: false };
    if (!auth.hasAccount(app.getPath('userData'), session.username)) return { success: false };

    activeAuthProfile = { username: session.username };
    return { success: true, profile: { username: session.username } };
  } catch (_) {
    return { success: false };
  }
});

// ─── System info ──────────────────────────────────────────────────────────────

ipcMain.handle('get-system-ram', () => {
  return Math.floor(os.totalmem() / 1024 / 1024 / 1024);
});

ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.handle('get-versions', () => ({
  mc:       config.MC_VERSION,
  neoforge: config.NEOFORGE_VERSION,
  launcher: app.getVersion()
}));

ipcMain.handle('browse-folder', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  if (!result.canceled && result.filePaths.length > 0) return result.filePaths[0];
  return null;
});

ipcMain.handle('set-local-skin', async (_, { gameDir, username } = {}) => {
  if (!mainWindow) return { success: false, error: 'нет окна' };
  if (!username) return { success: false, error: 'Сначала войди под своим ником.' };
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Скин PNG', extensions: ['png'] }]
  });
  if (result.canceled || !result.filePaths.length) return { success: false, canceled: true };
  try {
    const data = fs.readFileSync(result.filePaths[0]);
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (data.length < 8 || !data.subarray(0, 8).equals(pngSignature)) {
      return { success: false, error: 'Файл не является настоящим PNG (возможно, переименованный JPG/WebP). Пересохрани скин в формате PNG.' };
    }
    const dir = path.join(gameDir, 'CustomSkinLoader', 'LocalSkin', 'skins');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${username}.png`), data);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── Content ──────────────────────────────────────────────────────────────────

const NEWS_URL     = 'https://raw.githubusercontent.com/MASHINKA34/void_launcher/main/news.json';
const MODS_LIST_URL = 'https://raw.githubusercontent.com/MASHINKA34/void_launcher/main/mods-list.json';
const NEWS_SOURCES = [
  NEWS_URL,
  'https://cdn.jsdelivr.net/gh/MASHINKA34/void_launcher@main/news.json'
];
const MODS_LIST_SOURCES = [
  MODS_LIST_URL,
  'https://api.github.com/repos/MASHINKA34/void_launcher/contents/mods-list.json?ref=main',
  'https://cdn.jsdelivr.net/gh/MASHINKA34/void_launcher@main/mods-list.json'
];

async function readResponseText(res, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`TIMEOUT ${Math.round(timeoutMs / 1000)}s`);
      if (typeof res.body?.destroy === 'function') res.body.destroy(error);
      else if (typeof res.body?.cancel === 'function') res.body.cancel(error).catch(() => {});
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([res.text(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFirstJson(urls, timeoutMs) {
  return await Promise.any(urls.map(async (url) => {
    const res = await fetchWithTimeout(`${url}?t=${Date.now()}`, {
      headers: { 'User-Agent': config.LAUNCHER_NAME },
      redirect: 'follow'
    }, timeoutMs);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = JSON.parse(await readResponseText(res, timeoutMs));
    if (!Array.isArray(data)) throw new Error('unexpected payload');
    return data;
  }));
}

async function fetchCurrentModsList(timeoutMs, minimumVersion) {
  const settled = await Promise.allSettled(MODS_LIST_SOURCES.map(async (url, index) => {
    const separator = url.includes('?') ? '&' : '?';
    const headers = { 'User-Agent': config.LAUNCHER_NAME };
    if (url.startsWith('https://api.github.com/')) {
      headers.Accept = 'application/vnd.github.raw+json';
    }
    const res = await fetchWithTimeout(`${url}${separator}t=${Date.now()}`, {
      headers,
      redirect: 'follow'
    }, timeoutMs);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = modSync.validateManifest(JSON.parse(await readResponseText(res, timeoutMs)));
    return { index, list, version: list[0].manifestVersion };
  }));

  const candidates = settled
    .filter(result => result.status === 'fulfilled')
    .map(result => result.value)
    .filter(result => result.version >= minimumVersion)
    .sort((a, b) => b.version - a.version || a.index - b.index);

  if (candidates.length === 0) {
    throw new Error('CURRENT_MODS_LIST_UNAVAILABLE');
  }
  return candidates[0].list;
}

function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(tempPath, filePath);
  } finally {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {}
  }
}

ipcMain.handle('get-news', async () => {
  try {
    return await fetchFirstJson(NEWS_SOURCES, 5_000);
  } catch (_) {
    try {
      return JSON.parse(fs.readFileSync(path.join(__dirname, 'news.json'), 'utf8'));
    } catch (__) {
      return [];
    }
  }
});

function mergeModMetadata(list) {
  if (!Array.isArray(list)) throw new Error('mods list is not an array');

  let bundled = [];
  try { bundled = JSON.parse(fs.readFileSync(path.join(__dirname, 'mods-list.json'), 'utf8')); } catch (_) {}

  const byFile = new Map();
  const byName = new Map();
  for (const m of bundled) {
    if (m?.filename) byFile.set(String(m.filename).toLowerCase(), m);
    if (m?.name)     byName.set(String(m.name).toLowerCase(), m);
  }

  return list.map(m => {
    const ref = byFile.get(String(m?.filename || '').toLowerCase())
             || byName.get(String(m?.name || '').toLowerCase());
    if (!ref) return m;
    const merged = { ...m };
    if (!merged.description && ref.description) merged.description = ref.description;
    return merged;
  });
}

ipcMain.handle('get-mods-list', () => {
  const candidates = [
    path.join(app.getPath('userData'), 'mods-list-cache.json'),
    path.join(__dirname, 'mods-list.json')
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return mergeModMetadata(modSync.validateManifest(JSON.parse(fs.readFileSync(p, 'utf8'))));
    } catch (_) {}
  }
  return [];
});

// ─── Installation ─────────────────────────────────────────────────────────────

ipcMain.handle('check-installation', async (_, gameDir, javaPath) => {
  const installer = require('./src/installer');
  return await installer.checkInstallation(gameDir, javaPath);
});

let installInFlight = false;

ipcMain.handle('install-game', async (_, { gameDir, javaPath }) => {
  if (installInFlight) {
    return { success: false, error: 'Установка уже выполняется.' };
  }
  installInFlight = true;
  try {
    const installer = require('./src/installer');
    installer.setProgressCallback((progress) => {
      if (mainWindow) mainWindow.webContents.send('install-progress', progress);
    });
    return await installer.install(gameDir, javaPath);
  } finally {
    installInFlight = false;
  }
});

ipcMain.handle('repair-installation', async (_, { gameDir, javaPath }) => {
  if (installInFlight) {
    return { success: false, error: 'Установка уже выполняется.' };
  }
  installInFlight = true;
  try {
    const installer = require('./src/installer');
    installer.setProgressCallback((progress) => {
      if (mainWindow) mainWindow.webContents.send('install-progress', progress);
    });
    return await installer.repair(gameDir, javaPath);
  } finally {
    installInFlight = false;
  }
});

ipcMain.handle('detect-java', async (_, gameDir) => {
  const installer = require('./src/installer');
  return await installer.findJava(gameDir);
});

ipcMain.handle('open-logs-folder', async (_, gameDir) => {
  try {
    const base = gameDir && fs.existsSync(gameDir) ? gameDir : app.getPath('userData');
    const logsDir = path.join(base, 'logs');
    const target = fs.existsSync(logsDir) ? logsDir : base;
    const err = await shell.openPath(target);
    if (err) return { success: false, error: err };
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── Mod sync ─────────────────────────────────────────────────────────────────

let modSyncInFlight = false;

ipcMain.handle('sync-mods', async (_, { gameDir }) => {
  if (modSyncInFlight) {
    return { success: false, error: 'Синхронизация модов уже выполняется.' };
  }

  modSyncInFlight = true;
  try {
    modSync.setProgressCallback((progress) => {
      if (mainWindow) mainWindow.webContents.send('mod-sync-progress', progress);
    });

    const localModsListPath = path.join(__dirname, 'mods-list.json');
    const cachePath = path.join(app.getPath('userData'), 'mods-list-cache.json');
    const bundledList = modSync.validateManifest(JSON.parse(fs.readFileSync(localModsListPath, 'utf8')));
    let remoteList;

    try {
      remoteList = await fetchCurrentModsList(15_000, bundledList[0].manifestVersion);
    } catch (_) {
      return {
        success: false,
        error: 'Не удалось получить актуальный список модов. Проверьте интернет, VPN или прокси и повторите запуск.'
      };
    }

    const normalizedList = mergeModMetadata(remoteList);
    writeJsonAtomic(cachePath, normalizedList);
    return await modSync.sync(gameDir, cachePath);
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    modSyncInFlight = false;
  }
});

// ─── Game launch ─────────────────────────────────────────────────────────────

function openGameLogStream(gameDir) {
  try {
    const base = gameDir && fs.existsSync(gameDir) ? gameDir : app.getPath('userData');
    const logsDir = path.join(base, 'logs');
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    const old = fs.readdirSync(logsDir).filter(f => f.startsWith('launcher-console-')).sort();
    for (const f of old.slice(0, Math.max(0, old.length - 10))) {
      try { fs.unlinkSync(path.join(logsDir, f)); } catch (_) {}
    }
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    return fs.createWriteStream(path.join(logsDir, `launcher-console-${ts}.log`), { flags: 'a' });
  } catch (_) {
    return null;
  }
}

ipcMain.handle('launch-game', async (_, launchOptions) => {
  if (!activeAuthProfile?.username) {
    return { success: false, error: 'Сначала войдите в аккаунт с паролем.' };
  }

  if (launchOptions?.username !== activeAuthProfile.username) {
    return { success: false, error: 'Ник запуска не совпадает с авторизованным аккаунтом.' };
  }

  const launcher = require('./src/launcher');
  const safeLaunchOptions = {
    ...launchOptions,
    username: activeAuthProfile.username
  };

  const logStream = openGameLogStream(launchOptions.gameDir);
  let launcherHidden = false;

  launcher.setOutputCallback((type, data) => {
    if (mainWindow) {
      mainWindow.webContents.send(`game-${type}`, data);
      if (!launcherHidden) { launcherHidden = true; mainWindow.hide(); }
    }
    if (logStream) logStream.write(data);
  });

  launcher.setExitCallback((code, crash) => {
    if (logStream) { logStream.write(`\n[Launcher] Game exited with code ${code}\n`); logStream.end(); }
    if (mainWindow) {
      const crashMsg   = crash && typeof crash === 'object' ? crash.message : (crash || null);
      const repairable = !!(crash && typeof crash === 'object' && crash.repairable);
      mainWindow.webContents.send('game-exit', { code, crash: crashMsg, repairable });
      mainWindow.show();
      mainWindow.focus();
    }
  });

  try {
    await launcher.launch(safeLaunchOptions);
    return { success: true };
  } catch (err) {
    if (logStream) logStream.end();
    if (mainWindow) mainWindow.show();
    return { success: false, error: err.message };
  }
});

// ─── Server ping ─────────────────────────────────────────────────────────────

ipcMain.handle('ping-server', async () => {
  const serverPing = require('./src/serverPing');
  return await serverPing.ping(config.SERVER_IP, config.SERVER_PORT, 1500);
});

// ─── Auto-update ──────────────────────────────────────────────────────────────

ipcMain.handle('check-update', async () => {
  const updater = require('./src/updater');
  return await updater.checkForUpdates(app.getVersion());
});

ipcMain.handle('download-update', async (_, opts) => {
  const updater = require('./src/updater');
  updater.setProgressCallback((data) => {
    if (mainWindow) mainWindow.webContents.send('update-progress', data);
  });
  return await updater.downloadUpdate(opts);
});

ipcMain.handle('install-update', (_, filePath) => {
  const updater = require('./src/updater');
  updater.installUpdate(filePath);
  setTimeout(() => app.quit(), 800);
});
