const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {

  // ── Window ──────────────────────────────────────────────────────────────────
  minimize: () => ipcRenderer.invoke('minimize-window'),
  close:    () => ipcRenderer.invoke('close-window'),

  // ── Settings ────────────────────────────────────────────────────────────────
  getSettings:  ()         => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  // ── Profile ─────────────────────────────────────────────────────────────────
  getProfile:               ()         => ipcRenderer.invoke('get-profile'),
  saveProfile:              (profile)  => ipcRenderer.invoke('save-profile', profile),
  deleteProfile:            ()         => ipcRenderer.invoke('delete-profile'),
  getProfiles:              ()         => ipcRenderer.invoke('get-profiles'),
  deleteProfileFromHistory: (username) => ipcRenderer.invoke('delete-profile-from-history', username),
  loginAccount:             (creds)    => ipcRenderer.invoke('auth-login', creds),
  registerAccount:          (creds)    => ipcRenderer.invoke('auth-register', creds),
  logoutAccount:            ()         => ipcRenderer.invoke('auth-logout'),
  restoreSession:           ()         => ipcRenderer.invoke('auth-restore-session'),

  // ── System ──────────────────────────────────────────────────────────────────
  getSystemRam: () => ipcRenderer.invoke('get-system-ram'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getVersions:   () => ipcRenderer.invoke('get-versions'),
  browseFolder: () => ipcRenderer.invoke('browse-folder'),
  detectJava:   (gameDir) => ipcRenderer.invoke('detect-java', gameDir),

  // ── Content ─────────────────────────────────────────────────────────────────
  getNews:     () => ipcRenderer.invoke('get-news'),
  getModsList: () => ipcRenderer.invoke('get-mods-list'),

  // ── Installation ────────────────────────────────────────────────────────────
  checkInstallation: (gameDir, javaPath) => ipcRenderer.invoke('check-installation', gameDir, javaPath),
  installGame:       (opts)    => ipcRenderer.invoke('install-game', opts),

  // ── Mod sync ────────────────────────────────────────────────────────────────
  syncMods: (opts) => ipcRenderer.invoke('sync-mods', opts),

  // ── Game ────────────────────────────────────────────────────────────────────
  launchGame: (opts) => ipcRenderer.invoke('launch-game', opts),

  // ── Server ──────────────────────────────────────────────────────────────────
  pingServer: () => ipcRenderer.invoke('ping-server'),

  // ── Updates ─────────────────────────────────────────────────────────────────
  checkUpdate:    ()     => ipcRenderer.invoke('check-update'),
  downloadUpdate: (opts) => ipcRenderer.invoke('download-update', opts),
  installUpdate:  (path) => ipcRenderer.invoke('install-update', path),

  // ── Events: main → renderer ─────────────────────────────────────────────────
  onInstallProgress: (cb) => ipcRenderer.on('install-progress',  (_, d) => cb(d)),
  onModSyncProgress: (cb) => ipcRenderer.on('mod-sync-progress', (_, d) => cb(d)),
  onGameStdout:      (cb) => ipcRenderer.on('game-stdout',       (_, d) => cb(d)),
  onGameStderr:      (cb) => ipcRenderer.on('game-stderr',       (_, d) => cb(d)),
  onGameExit:        (cb) => ipcRenderer.on('game-exit',         (_, code) => cb(code)),
  onUpdateProgress:  (cb) => ipcRenderer.on('update-progress',   (_, d) => cb(d)),

  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel)
});
