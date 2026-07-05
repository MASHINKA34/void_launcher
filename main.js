const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const config = require('./config');
const auth = require('./src/auth');

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
    const dir = path.join(gameDir, 'CustomSkinLoader', 'LocalSkin', 'skins');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(result.filePaths[0], path.join(dir, `${username}.png`));
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── Content ──────────────────────────────────────────────────────────────────

const NEWS_URL     = 'https://raw.githubusercontent.com/MASHINKA34/void_launcher/main/news.json';
const MODS_LIST_URL = 'https://raw.githubusercontent.com/MASHINKA34/void_launcher/main/mods-list.json';

ipcMain.handle('get-news', async () => {
  try {
    const fetch = require('node-fetch');
    const res = await fetch(`${NEWS_URL}?t=${Date.now()}`, { timeout: 5000 });
    if (!res.ok) throw new Error('fetch failed');
    return await res.json();
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
      if (fs.existsSync(p)) return mergeModMetadata(JSON.parse(fs.readFileSync(p, 'utf8')));
    } catch (_) {}
  }
  return [];
});

// ─── Installation ─────────────────────────────────────────────────────────────

ipcMain.handle('check-installation', async (_, gameDir, javaPath) => {
  const installer = require('./src/installer');
  return await installer.checkInstallation(gameDir, javaPath);
});

ipcMain.handle('install-game', async (_, { gameDir, javaPath }) => {
  const installer = require('./src/installer');
  installer.setProgressCallback((progress) => {
    if (mainWindow) mainWindow.webContents.send('install-progress', progress);
  });
  return await installer.install(gameDir, javaPath);
});

ipcMain.handle('detect-java', async (_, gameDir) => {
  const installer = require('./src/installer');
  return await installer.findJava(gameDir);
});

// ─── Mod sync ─────────────────────────────────────────────────────────────────

ipcMain.handle('sync-mods', async (_, { gameDir }) => {
  const modSync = require('./src/modSync');
  const fetch   = require('node-fetch');

  modSync.setProgressCallback((progress) => {
    if (mainWindow) mainWindow.webContents.send('mod-sync-progress', progress);
  });

  // Пытаемся получить свежий список модов с GitHub
  const localModsListPath = path.join(__dirname, 'mods-list.json');
  const cachePath = path.join(app.getPath('userData'), 'mods-list-cache.json');
  try {
    const res = await fetch(`${MODS_LIST_URL}?t=${Date.now()}`, { timeout: 10_000 });
    if (res.ok) {
      const remoteList = mergeModMetadata(JSON.parse(await res.text()));
      fs.writeFileSync(cachePath, JSON.stringify(remoteList, null, 2), 'utf8');
      return await modSync.sync(gameDir, cachePath);
    }
  } catch (_) {}

  // Fallback: кэш с прошлого запуска → локальный файл
  if (fs.existsSync(cachePath)) {
    try {
      const cached = mergeModMetadata(JSON.parse(fs.readFileSync(cachePath, 'utf8')));
      fs.writeFileSync(cachePath, JSON.stringify(cached, null, 2), 'utf8');
      return await modSync.sync(gameDir, cachePath);
    } catch (_) {}
  }
  return await modSync.sync(gameDir, localModsListPath);
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
      mainWindow.webContents.send('game-exit', { code, crash: crash || null });
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

ipcMain.handle('download-update', async (_, { downloadUrl, assetName }) => {
  const updater = require('./src/updater');
  updater.setProgressCallback((data) => {
    if (mainWindow) mainWindow.webContents.send('update-progress', data);
  });
  return await updater.downloadUpdate(downloadUrl, assetName);
});

ipcMain.handle('install-update', (_, filePath) => {
  const updater = require('./src/updater');
  updater.installUpdate(filePath);
  setTimeout(() => app.quit(), 800);
});
