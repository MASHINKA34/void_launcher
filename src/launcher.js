/**
 * launcher.js
 * Launches Minecraft with NeoForge via minecraft-launcher-core (offline mode).
 */

const path = require('path');
const fs   = require('fs');
const { Client } = require('minecraft-launcher-core');
const crypto = require('crypto');
const config = require('../config');

let outputCallback = null;
let exitCallback   = null;

function setOutputCallback(cb) { outputCallback = cb; }
function setExitCallback(cb)   { exitCallback   = cb; }

function emit(type, data) {
  if (outputCallback) outputCallback(type, data);
}

// Find the installed NeoForge version ID in the versions directory
function findNeoForgeVersionId(gameDir) {
  const versionsDir = path.join(gameDir, 'versions');
  if (!fs.existsSync(versionsDir)) return null;
  const dirs = fs.readdirSync(versionsDir);
  const nf = dirs.find(d => d.toLowerCase().includes('neoforge'));
  return nf || null;
}

async function launch(opts) {
  const {
    username,
    gameDir,
    ram    = 4,
    width  = 1280,
    height = 720,
    javaPath = 'auto'
  } = opts;

  const neoforgeId = findNeoForgeVersionId(gameDir);
  if (!neoforgeId) throw new Error('NeoForge is not installed. Please run installation first.');

  const launcher = new Client();

  const launchOptions = {
    authorization: (() => {
      const hash = crypto.createHash('md5').update(`OfflinePlayer:${username}`).digest('hex');
      const uuid = `${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20)}`;
      return { access_token: 'null', client_token: 'null', uuid, username, user_properties: '{}' };
    })(),
    root:    gameDir,
    version: {
      number: config.MC_VERSION,
      type:   'release',
      custom: neoforgeId
    },
    memory: {
      max: `${ram}G`,
      min: '2G'
    },
    overrides: {
      gameDirectory: gameDir,
      ...(width && height ? { window: { width, height } } : {})
    },
    javaPath: javaPath !== 'auto' ? javaPath : undefined,
    customArgs: [
      '--add-opens', 'java.base/java.lang.invoke=ALL-UNNAMED',
      '--add-opens', 'java.base/java.util.jar=ALL-UNNAMED',
      '--add-opens', 'java.base/sun.security.util=ALL-UNNAMED',
      '--add-opens', 'java.base/java.net=ALL-UNNAMED',
      '-XX:+UseG1GC',
      '-XX:+ParallelRefProcEnabled',
      '-XX:MaxGCPauseMillis=200',
      '-XX:+UnlockExperimentalVMOptions',
      '-XX:+DisableExplicitGC',
      '-XX:G1NewSizePercent=30',
      '-XX:G1MaxNewSizePercent=40',
      '-XX:G1HeapRegionSize=8M',
      '-XX:G1ReservePercent=20',
      '-XX:G1HeapWastePercent=5',
      '-XX:G1MixedGCCountTarget=4',
      '-XX:InitiatingHeapOccupancyPercent=15',
      '-XX:G1MixedGCLiveThresholdPercent=90',
      '-XX:G1RSetUpdatingPauseTimePercent=5',
      '-XX:SurvivorRatio=32',
      '-Dfile.encoding=UTF-8'
    ]
  };

  // If using bundled Java, resolve the path
  const bundledJava = path.join(gameDir, 'runtime', 'java21', 'bin', 'java.exe');
  if ((!launchOptions.javaPath) && fs.existsSync(bundledJava)) {
    launchOptions.javaPath = bundledJava;
  }

  return new Promise((resolve, reject) => {
    launcher.launch(launchOptions);

    launcher.on('debug', (msg) => {
      emit('stdout', `[DEBUG] ${msg}\n`);
    });

    launcher.on('data', (msg) => {
      emit('stdout', msg + '\n');
    });

    launcher.on('close', (code) => {
      emit('stdout', `\n[Launcher] Game exited with code ${code}\n`);
      if (exitCallback) exitCallback(code);
      resolve(code);
    });

    launcher.on('error', (err) => {
      const msg = typeof err === 'string' ? err : JSON.stringify(err);
      emit('stderr', `[ERROR] ${msg}\n`);
      // Don't reject — the game may still be launching
    });

    // Resolve promise once the process starts (data first arrives)
    let started = false;
    launcher.on('data', () => {
      if (!started) { started = true; resolve(0); }
    });

    // Fallback: resolve after 5s so the launcher window can hide
    setTimeout(() => { if (!started) { started = true; resolve(0); } }, 5000);
  });
}

module.exports = { launch, setOutputCallback, setExitCallback };
