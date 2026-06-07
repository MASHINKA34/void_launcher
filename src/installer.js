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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function removeFileIfExists(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (_) {}
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Connection timed out after ${Math.round(timeoutMs / 1000)}s: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function downloadFileOnce(url, partPath, label, opts) {
  const res = await fetchWithTimeout(url, opts.requestTimeoutMs);
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}): ${url}`);

  const total   = parseInt(res.headers.get('content-length') || '0', 10);
  let received  = 0;
  const start   = Date.now();
  const writer  = fs.createWriteStream(partPath);

  await new Promise((resolve, reject) => {
    let settled = false;
    let idleTimer = null;

    const cleanup = () => {
      if (idleTimer) clearTimeout(idleTimer);
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { res.body.destroy(); } catch (_) {}
      try { writer.destroy(); } catch (_) {}
      reject(err);
    };

    const resetIdleTimer = () => {
      cleanup();
      idleTimer = setTimeout(() => {
        fail(new Error(`${label} download stalled for ${Math.round(opts.idleTimeoutMs / 1000)}s`));
      }, opts.idleTimeoutMs);
    };

    const finish = () => {
      if (settled) return;
      if (total > 0 && received !== total) {
        fail(new Error(`${label} download incomplete (${received} / ${total} bytes)`));
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };

    resetIdleTimer();

    res.body.on('data', (chunk) => {
      received += chunk.length;
      resetIdleTimer();
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
    res.body.on('error', fail);
    writer.on('error',   fail);
    writer.on('finish',  finish);
    res.body.pipe(writer);
  });
}

async function downloadFile(url, destPath, label, options = {}) {
  const opts = {
    retries:          options.retries || 3,
    requestTimeoutMs: options.requestTimeoutMs || 30_000,
    idleTimeoutMs:    options.idleTimeoutMs || 45_000,
    retryDelayMs:     options.retryDelayMs || 1_500,
    step:             options.step || null
  };

  const partPath = `${destPath}.part`;
  let lastError = null;

  for (let attempt = 1; attempt <= opts.retries; attempt++) {
    removeFileIfExists(partPath);

    if (attempt > 1) {
      emit({
        type:    'step',
        step:    opts.step,
        status:  'downloading',
        message: `${label}: retry ${attempt}/${opts.retries}...`
      });
    }

    try {
      await downloadFileOnce(url, partPath, label, opts);
      removeFileIfExists(destPath);
      fs.renameSync(partPath, destPath);
      return;
    } catch (err) {
      lastError = err;
      removeFileIfExists(partPath);

      if (attempt < opts.retries) {
        await sleep(opts.retryDelayMs * attempt);
      }
    }
  }

  throw new Error(`${label} download failed after ${opts.retries} attempts: ${lastError.message}`);
}

/**
 * Tries several URLs in order until one succeeds.
 * Use for files available from a primary mirror + an official fallback.
 */
async function downloadFromSources(urls, destPath, label, options = {}) {
  const sources = urls.filter(Boolean);
  let lastError = null;

  for (let i = 0; i < sources.length; i++) {
    const isLast = i === sources.length - 1;

    if (i > 0) {
      emit({
        type:    'step',
        step:    options.step || null,
        status:  'downloading',
        message: `${label}: основной источник недоступен, пробую запасной (${i + 1}/${sources.length})...`
      });
    }

    try {
      // Non-final mirrors get fewer retries so we fall back to the next source quickly.
      await downloadFile(sources[i], destPath, label, {
        ...options,
        retries: isLast ? (options.retries || 3) : (options.mirrorRetries || 2)
      });
      return;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error(`${label}: все источники недоступны`);
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

// Returns the major Java version of an executable (8, 17, 21, ...), or null if unknown.
// `java -version` prints e.g. `version "21.0.10"` (modern) or `version "1.8.0_401"` (Java 8),
// usually to stderr and with exit code 0.
async function getJavaMajor(exePath) {
  const parse = (text) => {
    if (!text) return null;
    const m = text.match(/version "(\d+)(?:\.(\d+))?/);
    if (!m) return null;
    let major = parseInt(m[1], 10);
    if (major === 1 && m[2]) major = parseInt(m[2], 10); // 1.8 → 8
    return Number.isNaN(major) ? null : major;
  };
  try {
    const { stdout, stderr } = await execAsync(`"${exePath}" -version`, { timeout: 5000 });
    return parse(`${stderr || ''}\n${stdout || ''}`);
  } catch (err) {
    return parse(`${err.stderr || ''}\n${err.stdout || ''}`);
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

const REQUIRED_JAVA_MAJOR = 21;

async function findJava(gameDir) {
  // 1. Bundled runtime in game dir — this is always the Java 21 we install ourselves.
  const bundled = path.join(gameDir, 'runtime', 'java21', 'bin', 'java.exe');
  if (fs.existsSync(bundled)) return bundled;

  // Accept a candidate only if it is actually Java 21+ (a system Java 8 must be rejected,
  // otherwise NeoForge fails at launch with "Unrecognized option: -p").
  const accept = async (exe) => {
    if (!exe || !fs.existsSync(exe)) return false;
    const major = await getJavaMajor(exe);
    return major !== null && major >= REQUIRED_JAVA_MAJOR;
  };

  // 2. JAVA_HOME (only if Java 21+)
  if (process.env.JAVA_HOME) {
    const exe = path.join(process.env.JAVA_HOME, 'bin', 'java.exe');
    if (await accept(exe)) return exe;
  }

  // 3. PATH (check every entry, skip older Javas like a system-wide Java 8)
  try {
    const { stdout } = await execAsync('where java', { timeout: 5000 });
    for (const line of stdout.trim().split(/\r?\n/)) {
      const cand = line.trim();
      if (await accept(cand)) return cand;
    }
  } catch (_) {}

  // 4. Common Windows install directories
  for (const base of WIN_JAVA_DIRS) {
    const found = await findJavaInDir(base, '21');
    if (await accept(found)) return found;
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

  await downloadFile(downloadUrl, tmpZip, 'Java 21 JRE', { step: 'java' });

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
  // launcher_profiles.json is expected by the NeoForge installer (Mojang launcher format).
  ensureLauncherProfiles(gameDir);

  const nfVersion = config.NEOFORGE_VERSION;
  const hasMirror = config.GITHUB_OWNER && config.GITHUB_REPO &&
                    config.GITHUB_OWNER !== 'YOUR_GITHUB_OWNER';

  // Preferred path: download a pre-installed NeoForge archive from our GitHub mirror and
  // unpack it. This avoids maven.neoforged.net entirely (it is often blocked/throttled),
  // so no installer needs to run and no libraries are fetched at install time.
  if (hasMirror) {
    try {
      await installNeoForgeFromArchive(gameDir, nfVersion);
      ensureDir(path.join(gameDir, 'mods'));
      emit({ type: 'step', step: 'neoforge', status: 'done', message: 'NeoForge installed.' });
      return;
    } catch (err) {
      emit({
        type:    'step',
        step:    'neoforge',
        status:  'downloading',
        message: `Готовый NeoForge недоступен (${err.message}). Перехожу на официальный установщик...`
      });
    }
  }

  // Fallback: the official installer (requires access to maven.neoforged.net).
  await installNeoForgeViaInstaller(gameDir, javaExe, nfVersion);
  ensureDir(path.join(gameDir, 'mods'));
  emit({ type: 'step', step: 'neoforge', status: 'done', message: 'NeoForge installed.' });
}

// Pre-installed NeoForge: a zip with versions/<neoforge> + the neoforged-hosted libraries,
// produced once on a machine where maven.neoforged.net is reachable, then served from GitHub.
async function installNeoForgeFromArchive(gameDir, nfVersion) {
  const archiveName = `neoforge-${nfVersion}-offline.zip`;
  const archiveUrl  = `https://github.com/${config.GITHUB_OWNER}/${config.GITHUB_REPO}/releases/download/neoforge/${archiveName}`;
  const archivePath = path.join(gameDir, archiveName);

  emit({ type: 'step', step: 'neoforge', status: 'downloading', message: 'Загрузка готового NeoForge...' });
  await downloadFile(archiveUrl, archivePath, 'NeoForge (offline)', { step: 'neoforge' });

  emit({ type: 'step', step: 'neoforge', status: 'installing', message: 'Распаковка NeoForge...' });
  await extractZip(archivePath, gameDir);
  try { fs.unlinkSync(archivePath); } catch (_) {}

  // Verify the unpacked archive is complete: the version manifest AND the universal jar
  // that registers the neoforge/minecraft mod providers. If either is missing, throw so
  // the caller falls back to the official installer.
  const versionJson  = path.join(gameDir, 'versions', `neoforge-${nfVersion}`, `neoforge-${nfVersion}.json`);
  const universalJar = path.join(gameDir, 'libraries', 'net', 'neoforged', 'neoforge', nfVersion, `neoforge-${nfVersion}-universal.jar`);
  if (!fs.existsSync(versionJson) || !fs.existsSync(universalJar)) {
    throw new Error('архив распакован, но неполный (нет манифеста или universal.jar)');
  }
}

function ensureLauncherProfiles(gameDir) {
  const profilesPath = path.join(gameDir, 'launcher_profiles.json');
  if (fs.existsSync(profilesPath)) return;
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

async function installNeoForgeViaInstaller(gameDir, javaExe, nfVersion) {
  emit({ type: 'step', step: 'neoforge', status: 'downloading', message: 'Downloading NeoForge installer...' });

  const installerName = `neoforge-${nfVersion}-installer.jar`;
  const installerJar  = path.join(gameDir, installerName);

  // Источники по приоритету: своё зеркало в GitHub Releases (тег "neoforge") → официальный maven.
  const sources = [];
  if (config.GITHUB_OWNER && config.GITHUB_REPO &&
      config.GITHUB_OWNER !== 'YOUR_GITHUB_OWNER') {
    sources.push(`https://github.com/${config.GITHUB_OWNER}/${config.GITHUB_REPO}/releases/download/neoforge/${installerName}`);
  }
  sources.push(`https://maven.neoforged.net/releases/net/neoforged/neoforge/${nfVersion}/${installerName}`);

  await downloadFromSources(sources, installerJar, 'NeoForge Installer', { step: 'neoforge' });

  emit({ type: 'step', step: 'neoforge', status: 'installing', message: 'Installing NeoForge (this may take a few minutes)...' });

  await new Promise((resolve, reject) => {
    const proc = spawn(
      javaExe,
      ['-jar', installerJar, '--installClient', gameDir],
      { cwd: gameDir, stdio: ['pipe', 'pipe', 'pipe'] }
    );

    let output = '';
    let settled = false;
    const timeoutMs = 10 * 60 * 1000;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill(); } catch (_) {}
      reject(new Error(`NeoForge installer timed out after ${Math.round(timeoutMs / 60000)} minutes`));
    }, timeoutMs);

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (err) reject(err);
      else resolve();
    };

    proc.stdout.on('data', (d) => {
      const message = d.toString();
      output += message;
      if (message.trim()) {
        emit({ type: 'step', step: 'neoforge', status: 'installing', message: message.trim() });
      }
    });
    proc.stderr.on('data', (d) => {
      const message = d.toString();
      output += message;
      if (message.trim()) {
        emit({ type: 'step', step: 'neoforge', status: 'installing', message: message.trim() });
      }
    });

    proc.on('close', (code) => {
      if (code === 0) finish();
      else finish(new Error(`NeoForge installer exited with code ${code}\n${output.slice(-500)}`));
    });

    proc.on('error', finish);
  });

  // Clean up installer jar
  try { fs.unlinkSync(installerJar); } catch (_) {}
}

// ─── Public API ───────────────────────────────────────────────────────────────

function isMinecraftInstalled(gameDir) {
  return fs.existsSync(path.join(gameDir, 'versions', config.MC_VERSION));
}

function isNeoForgeInstalled(gameDir) {
  const nfVersion = config.NEOFORGE_VERSION;
  const universalJar = path.join(
    gameDir, 'libraries', 'net', 'neoforged', 'neoforge', nfVersion,
    `neoforge-${nfVersion}-universal.jar`
  );
  if (!fs.existsSync(universalJar)) return false;

  const versionsDir = path.join(gameDir, 'versions');
  if (!fs.existsSync(versionsDir)) return false;

  return fs.readdirSync(versionsDir).some(d => {
    const lower = d.toLowerCase();
    return lower.includes('neoforge') &&
           d.includes(nfVersion) &&
           fs.existsSync(path.join(versionsDir, d, `${d}.json`));
  });
}

async function checkInstallation(gameDir, savedJavaPath) {
  const neoforgeInstalled = isNeoForgeInstalled(gameDir);
  const mcInstalled       = isMinecraftInstalled(gameDir);

  let javaPath = await findJava(gameDir);
  if (!javaPath && savedJavaPath && savedJavaPath !== 'auto' && fs.existsSync(savedJavaPath)) {
    const major = await getJavaMajor(savedJavaPath);
    if (major !== null && major >= REQUIRED_JAVA_MAJOR) javaPath = savedJavaPath;
  }

  return {
    javaInstalled:  !!javaPath,
    javaPath:       javaPath || null,
    mcInstalled,
    neoforgeInstalled,
    fullyInstalled: !!javaPath && mcInstalled && neoforgeInstalled
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
    if (isMinecraftInstalled(gameDir)) {
      emit({ type: 'step', step: 'minecraft', status: 'done', message: 'Minecraft 1.21.1 ready.' });
    } else {
      await downloadMinecraft(gameDir);
    }

    // ── Step 3: NeoForge ──────────────────────────────────────────────────────
    emit({ type: 'step-start', step: 'neoforge', message: 'Installing NeoForge...' });
    if (isNeoForgeInstalled(gameDir)) {
      ensureDir(path.join(gameDir, 'mods'));
      emit({ type: 'step', step: 'neoforge', status: 'done', message: 'NeoForge installed.' });
    } else {
      await installNeoForge(gameDir, javaExe);
    }

    emit({ type: 'done', message: 'Installation complete!' });
    return { success: true, javaPath: javaExe };

  } catch (err) {
    emit({ type: 'error', message: err.message });
    return { success: false, error: err.message };
  }
}

module.exports = { checkInstallation, install, findJava, getJavaMajor, setProgressCallback };
