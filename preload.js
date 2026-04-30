const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {

  // ── Window ──────────────────────────────────────────────────────────────────
  minimize: () => ipcRenderer.invoke('minimize-window'),
  close:    () => ipcRenderer.invoke('close-window'),

  // ── Settings ────────────────────────────────────────────────────────────────
  getSettings:  ()         => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  // ── Profile ─────────────────────────────────────────────────────────────────
  getProfile:    ()        => ipcRenderer.invoke('get-profile'),
  saveProfile:   (profile) => ipcRenderer.invoke('save-profile', profile),
  deleteProfile: ()        => ipcRenderer.invoke('delete-profile'),

  // ── System ──────────────────────────────────────────────────────────────────
  getSystemRam: () => ipcRenderer.invoke('get-system-ram'),
  browseFolder: () => ipcRenderer.invoke('browse-folder'),
  detectJava:   (gameDir) => ipcRenderer.invoke('detect-java', gameDir),

  // ── Content ─────────────────────────────────────────────────────────────────
  getNews:     () => ipcRenderer.invoke('get-news'),
  getModsList: () => ipcRenderer.invoke('get-mods-list'),

  // ── Installation ────────────────────────────────────────────────────────────
  checkInstallation: (gameDir) => ipcRenderer.invoke('check-installation', gameDir),
  installGame:       (opts)    => ipcRenderer.invoke('install-game', opts),

  // ── Mod sync ────────────────────────────────────────────────────────────────
  syncMods: (opts) => ipcRenderer.invoke('sync-mods', opts),

  // ── Game ────────────────────────────────────────────────────────────────────
  launchGame: (opts) => ipcRenderer.invoke('launch-game', opts),

  // ── Server ──────────────────────────────────────────────────────────────────
  pingServer: () => ipcRenderer.invoke('ping-server'),

  // ── Events: main → renderer ─────────────────────────────────────────────────
  onInstallProgress: (cb) => ipcRenderer.on('install-progress',  (_, d) => cb(d)),
  onModSyncProgress: (cb) => ipcRenderer.on('mod-sync-progress', (_, d) => cb(d)),
  onGameStdout:      (cb) => ipcRenderer.on('game-stdout',       (_, d) => cb(d)),
  onGameStderr:      (cb) => ipcRenderer.on('game-stderr',       (_, d) => cb(d)),
  onGameExit:        (cb) => ipcRenderer.on('game-exit',         (_, code) => cb(code)),

  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel)
});
