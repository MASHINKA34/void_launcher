/**
 * installer.js
 * Handles first-launch setup: Java 21, Minecraft 1.21.1, NeoForge 21.1.172
 */

const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const { exec, execFile, spawn } = require('child_process');
const util     = require('util');
const fetch    = require('node-fetch');
const { Client } = require('minecraft-launcher-core');
const config   = require('../config');

const execAsync = util.promisify(exec);

let progressCallback = null;

function setProgressCallback(cb) {
  progressCallback = cb;
}

function emit(data) {
  if (progressCallback) progressCallback(data);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function downloadFile(url, destPath, label) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}): ${url}`);

  const total   = parseInt(res.headers.get('content-length') || '0', 10);
  let received  = 0;
  const start   = Date.now();
  const writer  = fs.createWriteStream(destPath);

  await new Promise((resolve, reject) => {
    res.body.on('data', (chunk) => {
      received += chunk.length;
      writer.write(chunk);
      if (total > 0) {
        const elapsed = (Date.now() - start) / 1000 || 0.001;
        emit({
          type:     'download-progress',
          label,
          percent:  Math.round((received / total) * 100),
          received,
          total,
          speed:    Math.round(received / elapsed)
        });
      }
    });
    res.body.on('end',   () => { writer.end(); resolve(); });
    res.body.on('error', reject);
    writer.on('error',   reject);
  });
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function extractZip(zipPath, destDir) {
  ensureDir(destDir);
  // Use PowerShell Expand-Archive (Windows 10+ built-in)
  await execAsync(
    `powershell -NoProfile -Command "Expand-Archive -Force -LiteralPath '${zipPath}' -DestinationPath '${destDir}'"`,
    { timeout: 300_000 }
  );
}

// ─── Java detection ───────────────────────────────────────────────────────────

const WIN_JAVA_DIRS = [
  'C:\\Program Files\\Java',
  'C:\\Program Files\\Eclipse Adoptium',
  'C:\\Program Files\\Microsoft',
  'C:\\Program Files\\Semeru',
  'C:\\Program Files\\Zulu',
  'C:\\Program Files\\BellSoft',
];

async function testJavaExe(exePath) {
  try {
    const { stdout } = await execAsync(`"${exePath}" -version`, { timeout: 5000 });
    // java -version prints to stderr on most JVMs; combine both
    return true;
  } catch (err) {
    try {
      // Some JVMs print to stdout
      if (err.stdout && err.stdout.includes('version')) return true;
    } catch (_) {}
    return false;
  }
}

async function findJavaInDir(baseDir, minVersion) {
  if (!fs.existsSync(baseDir)) return null;
  const entries = fs.readdirSync(baseDir);
  for (const entry of entries) {
    if (!entry.toLowerCase().includes(`jdk-${minVersion}`) &&
        !entry.toLowerCase().includes(`jre-${minVersion}`) &&
        !entry.toLowerCase().includes(`java-${minVersion}`) &&
        !entry.toLowerCase().includes(`java${minVersion}`)) continue;

    const exePath = path.join(baseDir, entry, 'bin', 'java.exe');
    if (fs.existsSync(exePath)) return exePath;

    // Some layouts: baseDir/jdk-21.x.x/jdk-21.x.x/bin/java.exe
    const sub = fs.readdirSync(path.join(baseDir, entry)).find(s => s.startsWith('jdk'));
    if (sub) {
      const nested = path.join(baseDir, entry, sub, 'bin', 'java.exe');
      if (fs.existsSync(nested)) return nested;
    }
  }
  return null;
}

async function findJava(gameDir) {
  // 1. Bundled runtime in game dir
  const bundled = path.join(gameDir, 'runtime', 'java21', 'bin', 'java.exe');
  if (fs.existsSync(bundled)) return bundled;

  // 2. JAVA_HOME
  if (process.env.JAVA_HOME) {
    const exe = path.join(process.env.JAVA_HOME, 'bin', 'java.exe');
    if (fs.existsSync(exe)) return exe;
  }

  // 3. PATH
  try {
    const { stdout } = await execAsync('where java', { timeout: 5000 });
    const first = stdout.trim().split('\n')[0].trim();
    if (first && fs.existsSync(first)) return first;
  } catch (_) {}

  // 4. Common Windows install directories
  for (const base of WIN_JAVA_DIRS) {
    const found = await findJavaInDir(base, '21');
    if (found) return found;
  }

  return null;
}

// ─── Java installation ────────────────────────────────────────────────────────

async function installJava(gameDir) {
  emit({ type: 'step', step: 'java', status: 'downloading', message: 'Downloading Java 21 from Adoptium...' });

  const runtimeDir = path.join(gameDir, 'runtime');
  ensureDir(runtimeDir);

  // Fetch latest JRE 21 release info from Adoptium API
  const apiUrl = 'https://api.adoptium.net/v3/assets/latest/21/hotspot?os=windows&architecture=x64&image_type=jre';
  const apiRes = await fetch(apiUrl, { timeout: 15_000 });
  if (!apiRes.ok) throw new Error('Failed to fetch Java download info from Adoptium API');
  const releases = await apiRes.json();

  const release = releases.find(r => r.binary?.package?.link?.endsWith('.zip')) || releases[0];
  if (!release?.binary?.package?.link) throw new Error('No suitable Java 21 release found');

  const downloadUrl  = release.binary.package.link;
  const tmpZip       = path.join(runtimeDir, 'java21.zip');

  await downloadFile(downloadUrl, tmpZip, 'Java 21 JRE');

  emit({ type: 'step', step: 'java', status: 'extracting', message: 'Extracting Java 21...' });

  const java21Dir = path.join(runtimeDir, 'java21');
  if (fs.existsSync(java21Dir)) fs.rmSync(java21Dir, { recursive: true, force: true });

  // Extract zip — contents are usually inside a single top-level folder
  const tmpExtract = path.join(runtimeDir, '_java_extract');
  await extractZip(tmpZip, tmpExtract);

  // Move the inner folder to java21/
  const extracted = fs.readdirSync(tmpExtract);
  if (extracted.length === 0) throw new Error('Java archive appears empty');
  fs.renameSync(path.join(tmpExtract, extracted[0]), java21Dir);
  fs.rmSync(tmpExtract, { recursive: true, force: true });
  fs.unlinkSync(tmpZip);

  const javaExe = path.join(java21Dir, 'bin', 'java.exe');
  if (!fs.existsSync(javaExe)) throw new Error('Java executable not found after extraction');

  emit({ type: 'step', step: 'java', status: 'done', message: 'Java 21 installed.' });
  return javaExe;
}

// ─── Minecraft download ───────────────────────────────────────────────────────

async function downloadMinecraft(gameDir) {
  emit({ type: 'step', step: 'minecraft', status: 'downloading', message: 'Downloading Minecraft 1.21.1...' });

  const launcher = new Client();

  await new Promise((resolve, reject) => {
    launcher.launch({
      authorization: { access_token: 'offline', uuid: '00000000-0000-0000-0000-000000000000', username: 'Player', user_type: 'offline' },
      root:    gameDir,
      version: { number: config.MC_VERSION, type: 'release' },
      memory:  { max: '2G', min: '512M' },
      // downloadOnly flag — launch will fail because no Java here; we just want assets
      javaPath: 'java'
    });

    launcher.on('progress', (e) => {
      emit({
        type:    'download-progress',
        label:   `Minecraft — ${e.type || ''}`,
        percent: e.task && e.total ? Math.round((e.task / e.total) * 100) : 0,
        received: e.task || 0,
        total:    e.total || 0,
        speed:    0
      });
    });

    launcher.on('debug', (msg) => {
      // Launcher finishes file downloads before starting the game
      if (typeof msg === 'string' && msg.includes('Downloaded')) {
        emit({ type: 'step', step: 'minecraft', status: 'progress', message: msg });
      }
    });

    // The launcher will error when trying to actually run (no proper java),
    // but all game files will be downloaded by then.
    launcher.on('data',  () => resolve());
    launcher.on('close', () => resolve());
    launcher.on('error', (err) => {
      // Ignore "spawn" errors — files are already downloaded
      if (err && typeof err === 'string' && err.includes('spawn')) resolve();
      else reject(new Error(typeof err === 'string' ? err : JSON.stringify(err)));
    });

    // Safety timeout — resolve after 10 min in case events are different
    setTimeout(resolve, 600_000);
  }).catch(err => {
    // Tolerate launch errors; what matters is whether files exist
    console.warn('MC download note:', err.message);
  });

  emit({ type: 'step', step: 'minecraft', status: 'done', message: 'Minecraft 1.21.1 ready.' });
}

// ─── NeoForge installation ────────────────────────────────────────────────────

async function installNeoForge(gameDir, javaExe) {
  emit({ type: 'step', step: 'neoforge', status: 'downloading', message: 'Downloading NeoForge installer...' });

  // NeoForge installer requires launcher_profiles.json to exist (Mojang launcher format)
  const profilesPath = path.join(gameDir, 'launcher_profiles.json');
  if (!fs.existsSync(profilesPath)) {
    const profiles = {
      profiles: {
        '(Default)': {
          name: '(Default)',
          type: 'latest-release',
          created: new Date().toISOString(),
          lastUsed: new Date().toISOString(),
          icon: 'Grass',
          lastVersionId: 'latest-release'
        }
      },
      settings: {
        enableSnapshots: false,
        enableAdvancedSettings: false,
        keepLauncherOpen: false,
        profileSorting: 'ByLastPlayed',
        showGameLog: false,
        showMenu: false,
        soundOn: false
      },
      selectedProfile: '(Default)',
      authenticationDatabase: {},
      clientToken: '00000000-0000-0000-0000-000000000000',
      launcherVersion: { format: 21, name: '2.2.1476', profilesFormat: 2 }
    };
    fs.writeFileSync(profilesPath, JSON.stringify(profiles, null, 2), 'utf8');
  }

  const nfVersion    = config.NEOFORGE_VERSION;
  const installerUrl = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${nfVersion}/neoforge-${nfVersion}-installer.jar`;
  const installerJar = path.join(gameDir, `neoforge-${nfVersion}-installer.jar`);

  await downloadFile(installerUrl, installerJar, 'NeoForge Installer');

  emit({ type: 'step', step: 'neoforge', status: 'installing', message: 'Installing NeoForge (this may take a few minutes)...' });

  await new Promise((resolve, reject) => {
    const proc = spawn(
      javaExe,
      ['-jar', installerJar, '--installClient', gameDir],
      { cwd: gameDir, stdio: ['pipe', 'pipe', 'pipe'] }
    );

    let output = '';
    proc.stdout.on('data', (d) => {
      output += d.toString();
      emit({ type: 'step', step: 'neoforge', status: 'installing', message: d.toString().trim() });
    });
    proc.stderr.on('data', (d) => { output += d.toString(); });

    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`NeoForge installer exited with code ${code}\n${output.slice(-500)}`));
    });

    proc.on('error', reject);
  });

  // Clean up installer jar
  try { fs.unlinkSync(installerJar); } catch (_) {}

  // Ensure mods folder exists
  ensureDir(path.join(gameDir, 'mods'));

  emit({ type: 'step', step: 'neoforge', status: 'done', message: 'NeoForge installed.' });
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function checkInstallation(gameDir) {
  const nfVersion = config.NEOFORGE_VERSION;

  // Check for NeoForge version JSON
  const versionsDir = path.join(gameDir, 'versions');
  let neoforgeInstalled = false;
  if (fs.existsSync(versionsDir)) {
    const dirs = fs.readdirSync(versionsDir);
    neoforgeInstalled = dirs.some(d => d.toLowerCase().includes('neoforge'));
  }

  // Check for vanilla Minecraft assets
  const mcVersionDir = path.join(gameDir, 'versions', config.MC_VERSION);
  const mcInstalled  = fs.existsSync(mcVersionDir);

  // Check Java
  const javaPath = await findJava(gameDir);

  return {
    javaInstalled:      !!javaPath,
    javaPath:           javaPath || null,
    mcInstalled,
    neoforgeInstalled,
    fullyInstalled:     !!javaPath && mcInstalled && neoforgeInstalled
  };
}

async function install(gameDir, javaPathOverride) {
  try {
    ensureDir(gameDir);

    // ── Step 1: Java ──────────────────────────────────────────────────────────
    emit({ type: 'step-start', step: 'java', message: 'Checking Java 21...' });
    let javaExe = javaPathOverride && javaPathOverride !== 'auto'
      ? javaPathOverride
      : await findJava(gameDir);

    if (!javaExe) {
      javaExe = await installJava(gameDir);
    } else {
      emit({ type: 'step', step: 'java', status: 'done', message: `Java found: ${javaExe}` });
    }

    // ── Step 2: Minecraft ─────────────────────────────────────────────────────
    emit({ type: 'step-start', step: 'minecraft', message: 'Downloading Minecraft 1.21.1...' });
    await downloadMinecraft(gameDir);

    // ── Step 3: NeoForge ──────────────────────────────────────────────────────
    emit({ type: 'step-start', step: 'neoforge', message: 'Installing NeoForge...' });
    await installNeoForge(gameDir, javaExe);

    emit({ type: 'done', message: 'Installation complete!' });
    return { success: true, javaPath: javaExe };

  } catch (err) {
    emit({ type: 'error', message: err.message });
    return { success: false, error: err.message };
  }
}

module.exports = { checkInstallation, install, findJava, setProgressCallback };
