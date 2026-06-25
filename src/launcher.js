/**
 * launcher.js
 * Launches Minecraft with NeoForge via minecraft-launcher-core (offline mode).
 */

const path = require('path');
const fs   = require('fs');
const { Client } = require('minecraft-launcher-core');
const crypto = require('crypto');
const config = require('../config');
const installer = require('./installer');

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
  const preferred = dirs.find(d => d.toLowerCase().includes('neoforge') && d.includes(config.NEOFORGE_VERSION));
  if (preferred) return preferred;
  return dirs.find(d => d.toLowerCase().includes('neoforge')) || null;
}

function ensureFmlConfig(gameDir) {
  const configDir = path.join(gameDir, 'config');
  const fmlPath   = path.join(configDir, 'fml.toml');
  const keyRe     = /^\s*earlyWindowControl\s*=/;
  try {
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

    let lines = [];
    if (fs.existsSync(fmlPath)) {
      lines = fs.readFileSync(fmlPath, 'utf8').replace(/\r\n?/g, '\n').split('\n');
    }

    let replaced = false;
    const out = [];
    for (const line of lines) {
      if (keyRe.test(line)) {
        if (!replaced) {
          out.push('earlyWindowControl = true');
          replaced = true;
        }
        continue;
      }
      out.push(line);
    }
    if (!replaced) out.push('earlyWindowControl = true');

    fs.writeFileSync(fmlPath, out.join('\n') + '\n', 'utf8');
  } catch (_) {}
}

function ensureDistantHorizonsDefault(gameDir) {
  try {
    const dest = path.join(gameDir, 'config', 'DistantHorizons.toml');
    if (fs.existsSync(dest)) return;
    const src = path.join(__dirname, '..', 'default-config', 'DistantHorizons.toml');
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  } catch (_) {}
}

const GPU_DRIVER_DLLS = [
  { re: /\bati[og]\w*\.dll/i,  vendor: 'AMD' },
  { re: /\bamdxc\w*\.dll/i,    vendor: 'AMD' },
  { re: /\bnvoglv\w*\.dll/i,   vendor: 'NVIDIA' },
  { re: /\big\d+icd\d+\.dll/i, vendor: 'Intel' }
];

function createCrashDetector() {
  const state = { nativeCrash: false, gpuVendor: null, hsErrPath: null };

  function inspect(text) {
    if (typeof text !== 'string') return;
    if (text.includes('EXCEPTION_ACCESS_VIOLATION') ||
        text.includes('A fatal error has been detected by the Java Runtime Environment')) {
      state.nativeCrash = true;
    }
    if (!state.gpuVendor) {
      for (const { re, vendor } of GPU_DRIVER_DLLS) {
        if (re.test(text)) { state.gpuVendor = vendor; break; }
      }
    }
    if (!state.hsErrPath) {
      const m = text.match(/[A-Za-z]:\\\S*hs_err_pid\d+\.log/);
      if (m) state.hsErrPath = m[0];
    }
  }

  function buildMessage(exitCode) {
    if (exitCode === 0 || !state.nativeCrash) return null;
    let msg;
    if (state.gpuVendor) {
      msg = `Minecraft аварийно завершился из-за сбоя видеодрайвера ${state.gpuVendor}. ` +
            `Обновите драйвер видеокарты до последней версии и попробуйте снова.`;
    } else {
      msg = 'Minecraft аварийно завершился из-за ошибки в нативном коде. ' +
            'Чаще всего это вызвано устаревшим драйвером видеокарты — обновите его и попробуйте снова.';
    }
    if (state.hsErrPath) msg += `\n\nОтчёт о краше: ${state.hsErrPath}`;
    return msg;
  }

  return { inspect, buildMessage };
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

  // Resolve a Java 21+ runtime. NeoForge 1.21.1 requires Java 21 — launching with an
  // older system Java (e.g. Java 8) fails with "Unrecognized option: -p".
  let resolvedJava = null;
  if (javaPath && javaPath !== 'auto') {
    const major = await installer.getJavaMajor(javaPath);
    if (major !== null && major >= 21) resolvedJava = javaPath;
  }
  if (!resolvedJava) resolvedJava = await installer.findJava(gameDir);
  if (!resolvedJava) {
    throw new Error('Java 21 не найдена. Перезапустите лаунчер — он установит её автоматически.');
  }
  launchOptions.javaPath = resolvedJava;

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

  ensureFmlConfig(gameDir);
  ensureDistantHorizonsDefault(gameDir);

  return new Promise((resolve) => {
    const crashDetector = createCrashDetector();

    launcher.launch(launchOptions);

    launcher.on('debug', (msg) => {
      emit('stdout', `[DEBUG] ${msg}\n`);
    });

    launcher.on('data', (msg) => {
      crashDetector.inspect(msg);
      emit('stdout', msg + '\n');
    });

    launcher.on('close', (code) => {
      emit('stdout', `\n[Launcher] Game exited with code ${code}\n`);
      if (exitCallback) exitCallback(code, crashDetector.buildMessage(code));
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
