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

function findNeoForgeVersionId(gameDir) {
  const versionsDir = path.join(gameDir, 'versions');
  if (!fs.existsSync(versionsDir)) return null;
  const dirs = fs.readdirSync(versionsDir);
  return dirs.find(d => d.toLowerCase().includes('neoforge')) || null;
}

// Read the NeoForge version JSON and extract the JVM args it requires,
// substituting the ${variable} placeholders MCLC doesn't handle.
function buildNeoForgeJvmArgs(gameDir, versionId) {
  const jsonPath = path.join(gameDir, 'versions', versionId, `${versionId}.json`);
  if (!fs.existsSync(jsonPath)) return [];

  let versionData;
  try { versionData = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); }
  catch (_) { return []; }

  const jvmArgs = versionData.arguments?.jvm || [];
  const libDir  = path.join(gameDir, 'libraries');
  const sep     = process.platform === 'win32' ? ';' : ':';

  const vars = {
    '${library_directory}': libDir,
    '${version_name}':      versionId,
    '${classpath_separator}': sep,
  };

  const result = [];
  for (const arg of jvmArgs) {
    if (typeof arg !== 'string') continue; // skip conditional rule-objects
    let s = arg;
    for (const [k, v] of Object.entries(vars)) {
      s = s.split(k).join(v);
    }
    result.push(s);
  }
  return result;
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

  // NeoForge version JSON JVM args (module path, add-modules, add-opens, etc.)
  const neoforgeJvmArgs = buildNeoForgeJvmArgs(gameDir, neoforgeId);

  const launcher = new Client();

  const launchOptions = {
    authorization: (() => {
      const hash = crypto.createHash('md5').update(`OfflinePlayer:${username}`).digest('hex');
      const uuid = `${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20)}`;
      return { access_token: 'null', client_token: 'null', uuid, name: username, user_properties: '{}' };
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
      // NeoForge-required JVM args (module path, add-modules, add-opens, add-exports)
      ...neoforgeJvmArgs,
      // G1GC performance flags
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

  // Use bundled Java if available and no explicit path given
  const bundledJava = path.join(gameDir, 'runtime', 'java21', 'bin', 'java.exe');
  if (!launchOptions.javaPath && fs.existsSync(bundledJava)) {
    launchOptions.javaPath = bundledJava;
  }

  // Ensure Russian language is set in options.txt
  const optionsPath = path.join(gameDir, 'options.txt');
  try {
    let options = fs.existsSync(optionsPath) ? fs.readFileSync(optionsPath, 'utf8') : '';
    if (!options.includes('lang:')) {
      options = options.trimEnd();
      options += (options ? '\n' : '') + 'lang:ru_ru\n';
      fs.writeFileSync(optionsPath, options, 'utf8');
    } else if (!options.includes('lang:ru_ru')) {
      options = options.replace(/^lang:.+$/m, 'lang:ru_ru');
      fs.writeFileSync(optionsPath, options, 'utf8');
    }
  } catch (_) {}

  return new Promise((resolve) => {
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
    });

    let started = false;
    launcher.on('data', () => {
      if (!started) { started = true; resolve(0); }
    });

    // Fallback resolve after 5s if no data event fires
    setTimeout(() => { if (!started) { started = true; resolve(0); } }, 5000);
  });
}

module.exports = { launch, setOutputCallback, setExitCallback };
