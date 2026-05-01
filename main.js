const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const config = require('./config');

let mainWindow = null;
let tray = null;

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
    javaPath: 'auto'
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

ipcMain.handle('get-profile', () => {
  const profilePath = path.join(app.getPath('userData'), 'profile.json');
  try {
    if (fs.existsSync(profilePath)) {
      return JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    }
  } catch (_) {}
  return null;
});

ipcMain.handle('save-profile', (_, profile) => {
  const profilePath = path.join(app.getPath('userData'), 'profile.json');
  try {
    fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), 'utf8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('delete-profile', () => {
  const profilePath = path.join(app.getPath('userData'), 'profile.json');
  try {
    if (fs.existsSync(profilePath)) fs.unlinkSync(profilePath);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── System info ──────────────────────────────────────────────────────────────

ipcMain.handle('get-system-ram', () => {
  return Math.floor(os.totalmem() / 1024 / 1024 / 1024);
});

ipcMain.handle('browse-folder', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  if (!result.canceled && result.filePaths.length > 0) return result.filePaths[0];
  return null;
});

// ─── Content ──────────────────────────────────────────────────────────────────

ipcMain.handle('get-news', () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'news.json'), 'utf8'));
  } catch (_) {
    return [];
  }
});

ipcMain.handle('get-mods-list', () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'mods-list.json'), 'utf8'));
  } catch (_) {
    return [];
  }
});

// ─── Installation ─────────────────────────────────────────────────────────────

ipcMain.handle('check-installation', async (_, gameDir) => {
  const installer = require('./src/installer');
  return await installer.checkInstallation(gameDir);
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
  modSync.setProgressCallback((progress) => {
    if (mainWindow) mainWindow.webContents.send('mod-sync-progress', progress);
  });
  return await modSync.sync(gameDir, path.join(__dirname, 'mods-list.json'));
});

// ─── Game launch ─────────────────────────────────────────────────────────────

ipcMain.handle('launch-game', async (_, launchOptions) => {
  const launcher = require('./src/launcher');

  launcher.setOutputCallback((type, data) => {
    if (mainWindow) mainWindow.webContents.send(`game-${type}`, data);
  });

  launcher.setExitCallback((code) => {
    if (mainWindow) mainWindow.webContents.send('game-exit', code);
  });

  try {
    await launcher.launch(launchOptions);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── Server ping ─────────────────────────────────────────────────────────────

ipcMain.handle('ping-server', async () => {
  const serverPing = require('./src/serverPing');
  return await serverPing.ping(config.SERVER_IP, config.SERVER_PORT);
});
