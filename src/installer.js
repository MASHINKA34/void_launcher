

const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const { exec, execFile, spawn } = require('child_process');
const util     = require('util');
const crypto   = require('crypto');
const AdmZip   = require('adm-zip');
const { Client } = require('minecraft-launcher-core');
const config   = require('../config');
const { fetchWithTimeout, toNodeReadable, normalizeNetworkError } = require('./net');

const execAsync = util.promisify(exec);
const execFileAsync = util.promisify(execFile);

let progressCallback = null;
let bundleDir = null;

function setProgressCallback(cb) {
  progressCallback = cb;
}

function setBundleDir(dir) {
  bundleDir = dir || null;
}

function copyFromBundle(relativePath, destPath) {
  if (!bundleDir) return false;
  const src = path.join(bundleDir, relativePath);
  try {
    if (!fs.statSync(src).isFile()) return false;
    fs.copyFileSync(src, destPath);
    return true;
  } catch (_) {
    return false;
  }
}

function emit(data) {
  if (progressCallback) progressCallback(data);
}

let installLog = null;

function openInstallLog(gameDir) {
  try {
    const dir = path.join(gameDir, 'logs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    installLog = fs.createWriteStream(path.join(dir, `install-${ts}.log`), { flags: 'a' });
    dlog(`installer v${config.LAUNCHER_VERSION} | ${os.platform()} ${os.arch()} ${os.release()} | node ${process.versions.node}`);
  } catch (_) {
    installLog = null;
  }
}

function dlog(msg) {
  try { if (installLog) installLog.write(`[${new Date().toISOString()}] ${msg}\n`); } catch (_) {}
}

function closeInstallLog() {
  try { if (installLog) installLog.end(); } catch (_) {}
  installLog = null;
}


function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function removeFileIfExists(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (_) {}
}

function removeDirIfExists(dirPath) {
  try {
    if (fs.existsSync(dirPath)) fs.rmSync(dirPath, { recursive: true, force: true });
  } catch (_) {}
}

function assertZipFile(filePath, label, minBytes = 1024) {
  let stat = null;
  try {
    stat = fs.statSync(filePath);
  } catch (_) {
    throw new Error(`${label}: архив не найден после загрузки`);
  }

  if (stat.size < minBytes) {
    throw new Error(`${label}: архив скачался некорректно. Попробуйте повторить установку.`);
  }

  const fd = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(4);
    fs.readSync(fd, header, 0, 4, 0);
    if (header[0] !== 0x50 || header[1] !== 0x4b) {
      throw new Error(`${label}: сервер вернул не zip-архив. Проверьте подключение или VPN.`);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function makeSizeShaVerifier(expectedSize, expectedSha, label) {
  return async (filePath) => {
    const actualSize = fs.statSync(filePath).size;
    if (expectedSize && actualSize !== expectedSize) {
      dlog(`${label}: verify FAIL size got=${actualSize} expected=${expectedSize}`);
      throw new Error('INCOMPLETE_DOWNLOAD size mismatch');
    }
    if (expectedSha) {
      const actualSha = (await sha256File(filePath)).toLowerCase();
      if (actualSha !== expectedSha.toLowerCase()) {
        dlog(`${label}: verify FAIL sha got=${actualSha} expected=${expectedSha}`);
        throw new Error('CHECKSUM_MISMATCH');
      }
    }
    dlog(`${label}: verify OK size=${actualSize}`);
  };
}

async function downloadFileOnce(url, partPath, label, opts) {
  let startByte = 0;
  try {
    const st = fs.statSync(partPath);
    if (st.size > 0) startByte = st.size;
  } catch (_) {}

  const headers = { 'User-Agent': config.LAUNCHER_NAME };
  if (startByte > 0) headers['Range'] = `bytes=${startByte}-`;

  dlog(`GET ${label} resume=${startByte} ${url}`);
  const res = await fetchWithTimeout(url, { headers, redirect: 'follow' }, opts.requestTimeoutMs);

  if (res.status === 416) { dlog(`  HTTP 416 (already complete)`); return; }
  if (!res.ok && res.status !== 206) { dlog(`  HTTP ${res.status} (abort)`); throw new Error(`HTTP ${res.status}`); }

  const resuming = res.status === 206;
  if (startByte > 0 && !resuming) startByte = 0;

  let total = 0;
  const range = res.headers.get('content-range');
  if (range) {
    const m = /\/(\d+)\s*$/.exec(range);
    if (m) total = parseInt(m[1], 10);
  }
  if (!total) {
    const len = parseInt(res.headers.get('content-length') || '0', 10);
    total = resuming ? startByte + len : len;
  }

  dlog(`  HTTP ${res.status} resuming=${resuming} total=${total} startByte=${startByte}`);

  let received  = startByte;
  const start   = Date.now();
  const writer  = fs.createWriteStream(partPath, { flags: resuming ? 'a' : 'w' });
  const body    = toNodeReadable(res.body);

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
      dlog(`  FAIL ${err.message} (received ${received} / ${total})`);
      try { body.destroy(); } catch (_) {}
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
      dlog(`  OK received=${received} total=${total}`);
      resolve();
    };

    resetIdleTimer();

    body.on('data', (chunk) => {
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
          speed:    Math.round((received - startByte) / elapsed)
        });
      }
    });
    body.on('error', fail);
    writer.on('error',   fail);
    writer.on('finish',  finish);
    body.pipe(writer);
  });
}

async function downloadFile(url, destPath, label, options = {}) {
  const opts = {
    retries:          options.retries || 3,
    requestTimeoutMs: options.requestTimeoutMs || 30_000,
    idleTimeoutMs:    options.idleTimeoutMs || 45_000,
    retryDelayMs:     options.retryDelayMs || 1_500,
    step:             options.step || null,
    verify:           options.verify || null,
    keepPartOnFail:   options.keepPartOnFail || false
  };

  const partPath = `${destPath}.part`;
  let lastError = null;

  for (let attempt = 1; attempt <= opts.retries; attempt++) {
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
      if (opts.verify) {
        try {
          await opts.verify(partPath);
        } catch (vErr) {
          removeFileIfExists(partPath);
          throw vErr;
        }
      }
      removeFileIfExists(destPath);
      fs.renameSync(partPath, destPath);
      return;
    } catch (err) {
      lastError = err;
      if (attempt < opts.retries) {
        await sleep(opts.retryDelayMs * attempt);
      }
    }
  }

  if (!opts.keepPartOnFail) removeFileIfExists(partPath);
  throw new Error(`${label}: ${normalizeNetworkError(lastError)}`);
}

async function resolveYandexUrl(publicKey, filePath) {
  let api = `https://cloud-api.yandex.net/v1/disk/public/resources/download?public_key=${encodeURIComponent(publicKey)}`;
  if (filePath) api += `&path=${encodeURIComponent(filePath)}`;
  const res = await fetchWithTimeout(api, { headers: { 'User-Agent': config.LAUNCHER_NAME } }, 15_000);
  if (!res.ok) throw new Error(`Yandex API HTTP ${res.status}`);
  const data = await res.json();
  if (!data || !data.href) throw new Error('Yandex: нет ссылки на скачивание');
  dlog(`resolved Yandex ${publicKey}${filePath ? ' path=' + filePath : ''}`);
  return data.href;
}


async function downloadFromSources(sourcesIn, destPath, label, options = {}) {
  const sources = sourcesIn.filter(Boolean);
  let lastError = null;

  for (let i = 0; i < sources.length; i++) {
    const isLast = i === sources.length - 1;

    if (i > 0) {
      removeFileIfExists(`${destPath}.part`);
      emit({
        type:    'step',
        step:    options.step || null,
        status:  'downloading',
        message: `${label}: основной источник недоступен, пробую запасной (${i + 1}/${sources.length})...`
      });
    }

    try {
      const src = sources[i];
      const url = typeof src === 'function' ? await src() : src;
      await downloadFile(url, destPath, label, {
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

async function extractViaPowerShell(zipPath, destDir) {
  await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
     'Expand-Archive -Force -LiteralPath $env:VC_ZIP_SRC -DestinationPath $env:VC_ZIP_DEST'],
    { timeout: 300_000, env: { ...process.env, VC_ZIP_SRC: zipPath, VC_ZIP_DEST: destDir } }
  );
}

function extractWithAdmZip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onUncaught = (err) => finish(err);
    const timer = setTimeout(() => finish(new Error('extract timed out')), 5 * 60 * 1000);
    function finish(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.removeListener('uncaughtException', onUncaught);
      if (err) reject(err);
      else resolve();
    }
    process.on('uncaughtException', onUncaught);
    try {
      const zip = new AdmZip(zipPath);
      zip.extractAllToAsync(destDir, true, false, (err) => finish(err));
    } catch (err) {
      finish(err);
    }
  });
}

async function extractZip(zipPath, destDir) {
  ensureDir(destDir);
  try {
    await extractWithAdmZip(zipPath, destDir);
  } catch (err) {
    await extractViaPowerShell(zipPath, destDir);
  }
}


const WIN_JAVA_DIRS = [
  'C:\\Program Files\\Java',
  'C:\\Program Files\\Eclipse Adoptium',
  'C:\\Program Files\\Microsoft',
  'C:\\Program Files\\Semeru',
  'C:\\Program Files\\Zulu',
  'C:\\Program Files\\BellSoft',
];

async function getJavaMajor(exePath) {
  const parse = (text) => {
    if (!text) return null;
    const m = text.match(/version "(\d+)(?:\.(\d+))?/);
    if (!m) return null;
    let major = parseInt(m[1], 10);
    if (major === 1 && m[2]) major = parseInt(m[2], 10);
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
  const accept = async (exe) => {
    if (!exe || !fs.existsSync(exe)) return false;
    const major = await getJavaMajor(exe);
    return major !== null && major >= REQUIRED_JAVA_MAJOR;
  };

  const bundled = path.join(gameDir, 'runtime', 'java21', 'bin', 'java.exe');
  if (await accept(bundled)) return bundled;

  if (process.env.JAVA_HOME) {
    const exe = path.join(process.env.JAVA_HOME, 'bin', 'java.exe');
    if (await accept(exe)) return exe;
  }

  try {
    const { stdout } = await execAsync('where java', { timeout: 5000 });
    for (const line of stdout.trim().split(/\r?\n/)) {
      const cand = line.trim();
      if (await accept(cand)) return cand;
    }
  } catch (_) {}

  for (const base of WIN_JAVA_DIRS) {
    const found = await findJavaInDir(base, '21');
    if (await accept(found)) return found;
  }

  return null;
}


async function installJava(gameDir) {
  emit({ type: 'step', step: 'java', status: 'downloading', message: 'Downloading Java 21...' });

  const runtimeDir = path.join(gameDir, 'runtime');
  ensureDir(runtimeDir);

  const java        = config.JAVA || {};
  const expectedSha  = java.SHA256 || null;
  const expectedSize = java.SIZE || 0;
  const tmpZip       = path.join(runtimeDir, 'java21.zip');
  const java21Dir     = path.join(runtimeDir, 'java21');
  const tmpExtract    = path.join(runtimeDir, '_java_extract');

  const sources = [];
  if (java.ASSET_NAME && java.RELEASE_TAG &&
      config.GITHUB_OWNER && config.GITHUB_REPO &&
      config.GITHUB_OWNER !== 'YOUR_GITHUB_OWNER') {
    sources.push(`https://github.com/${config.GITHUB_OWNER}/${config.GITHUB_REPO}/releases/download/${java.RELEASE_TAG}/${java.ASSET_NAME}`);
  }
  if (java.ADOPTIUM_URL) sources.push(java.ADOPTIUM_URL);
  if (config.YANDEX_DISK_URL && java.YANDEX_PATH) {
    sources.push(() => resolveYandexUrl(config.YANDEX_DISK_URL, java.YANDEX_PATH));
  }
  if (sources.length === 0) throw new Error('Java 21 JRE: не задан источник загрузки в config.js');

  removeFileIfExists(tmpZip);
  removeFileIfExists(`${tmpZip}.part`);
  removeDirIfExists(tmpExtract);

  dlog(`installJava start | expectedSize=${expectedSize} expectedSha=${expectedSha} | sources=${JSON.stringify(sources)}`);

  let lastFailKind = null;
  const verifyZip = async (filePath) => {
    const actualSize = fs.statSync(filePath).size;
    if (expectedSize && actualSize !== expectedSize) {
      lastFailKind = 'size';
      dlog(`verify FAIL size: got ${actualSize}, expected ${expectedSize}`);
      throw new Error('INCOMPLETE_DOWNLOAD size mismatch');
    }
    if (expectedSha) {
      const actualSha = (await sha256File(filePath)).toLowerCase();
      if (actualSha !== expectedSha.toLowerCase()) {
        lastFailKind = 'checksum';
        dlog(`verify FAIL sha: got ${actualSha}, expected ${expectedSha} (size ${actualSize} OK)`);
        throw new Error('CHECKSUM_MISMATCH');
      }
    }
    lastFailKind = null;
    dlog(`verify OK size=${actualSize}`);
  };

  try {
    try {
      await downloadFromSources(sources, tmpZip, 'Java 21 JRE', {
        step: 'java', verify: verifyZip, retries: 4, mirrorRetries: 3
      });
    } catch (err) {
      if (lastFailKind === 'checksum') {
        throw new Error('Java 21 JRE: файл скачался, но повреждён (размер верный, контрольная сумма не совпала). Обычно виноват антивирус или прокси, который меняет файл — отключите его или смените сеть/VPN и повторите.');
      }
      if (lastFailKind === 'size') {
        throw new Error('Java 21 JRE: файл скачался не полностью — соединение обрывается. Проверьте интернет/VPN и повторите (докачка продолжится с места обрыва).');
      }
      throw err;
    }
    assertZipFile(tmpZip, 'Java 21 JRE', 1024 * 1024);

    emit({ type: 'step', step: 'java', status: 'extracting', message: 'Extracting Java 21...' });

    removeDirIfExists(java21Dir);
    removeDirIfExists(tmpExtract);

    await extractZip(tmpZip, tmpExtract);

    const extracted = fs.readdirSync(tmpExtract);
    if (extracted.length === 0) throw new Error('Java 21 JRE: архив распаковался пустым. Повторите установку.');
    fs.renameSync(path.join(tmpExtract, extracted[0]), java21Dir);
  } catch (err) {
    removeDirIfExists(java21Dir);
    throw err;
  } finally {
    removeDirIfExists(tmpExtract);
    removeFileIfExists(tmpZip);
    removeFileIfExists(`${tmpZip}.part`);
  }

  const javaExe = path.join(java21Dir, 'bin', 'java.exe');
  if (!fs.existsSync(javaExe)) throw new Error('Java 21 JRE: java.exe не найден после распаковки. Повторите установку.');

  emit({ type: 'step', step: 'java', status: 'done', message: 'Java 21 installed.' });
  return javaExe;
}


async function downloadMinecraft(gameDir, javaExe) {
  emit({ type: 'step', step: 'minecraft', status: 'downloading', message: 'Downloading Minecraft 1.21.1...' });

  const launcher = new Client();
  let gameProc = null;

  const killGameProc = () => {
    if (!gameProc) return;
    try { gameProc.kill(); } catch (_) {}
    gameProc = null;
  };

  await new Promise((resolve, reject) => {
    let settled = false;
    let idleTimer = null;
    let safetyTimer = null;

    const cleanup = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (safetyTimer) clearTimeout(safetyTimer);
    };

    const finish = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      killGameProc();
      if (err) reject(err);
      else resolve();
    };

    const touch = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        finish(new Error('Minecraft download stalled. Проверьте интернет и повторите установку.'));
      }, 90_000);
    };

    touch();
    safetyTimer = setTimeout(() => finish(), 600_000);

    launcher.launch({
      authorization: { access_token: 'offline', uuid: '00000000-0000-0000-0000-000000000000', username: 'Player', user_type: 'offline' },
      root:    gameDir,
      version: { number: config.MC_VERSION, type: 'release' },
      memory:  { max: '2G', min: '512M' },
      javaPath: javaExe
    }).then((proc) => {
      gameProc = proc || null;
      if (settled) killGameProc();
    }).catch((err) => finish(err));

    launcher.on('progress', (e) => {
      touch();
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
      touch();
      if (typeof msg === 'string' && msg.includes('Downloaded')) {
        emit({ type: 'step', step: 'minecraft', status: 'progress', message: msg });
      }
    });

    launcher.on('data',  () => finish());
    launcher.on('close', () => finish());
    launcher.on('error', (err) => {
      if (err && typeof err === 'string' && err.includes('spawn')) finish();
      else finish(new Error(typeof err === 'string' ? err : JSON.stringify(err)));
    });
  }).catch(err => {
    console.warn('MC download note:', err.message);
  });

  if (!isMinecraftInstalled(gameDir)) {
    throw new Error('Minecraft 1.21.1 не скачался полностью. Проверьте интернет и повторите установку.');
  }

  emit({ type: 'step', step: 'minecraft', status: 'done', message: 'Minecraft 1.21.1 ready.' });
}


async function installNeoForge(gameDir, javaExe) {
  ensureLauncherProfiles(gameDir);

  const nfVersion = config.NEOFORGE_VERSION;
  const hasOfflineArchive = !!(config.NEOFORGE && config.NEOFORGE.OFFLINE_SHA256);
  const hasMirror = hasOfflineArchive &&
                    config.GITHUB_OWNER && config.GITHUB_REPO &&
                    config.GITHUB_OWNER !== 'YOUR_GITHUB_OWNER';

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

  await installNeoForgeViaInstaller(gameDir, javaExe, nfVersion);
  ensureDir(path.join(gameDir, 'mods'));
  emit({ type: 'step', step: 'neoforge', status: 'done', message: 'NeoForge installed.' });
}

async function installNeoForgeFromArchive(gameDir, nfVersion) {
  const archiveName = `neoforge-${nfVersion}-offline.zip`;
  const archiveUrl  = `https://github.com/${config.GITHUB_OWNER}/${config.GITHUB_REPO}/releases/download/neoforge/${archiveName}`;
  const archivePath = path.join(gameDir, archiveName);

  emit({ type: 'step', step: 'neoforge', status: 'downloading', message: 'Загрузка готового NeoForge...' });

  const nf = config.NEOFORGE || {};
  const verify = (nf.OFFLINE_SHA256 || nf.OFFLINE_SIZE)
    ? makeSizeShaVerifier(nf.OFFLINE_SIZE, nf.OFFLINE_SHA256, 'NeoForge (offline)')
    : null;

  let haveArchive = false;
  if (verify && fs.existsSync(archivePath)) {
    try { await verify(archivePath); haveArchive = true; }
    catch (_) { removeFileIfExists(archivePath); }
  }
  if (!haveArchive) {
    const sources = [archiveUrl];
    if (config.YANDEX_DISK_URL && nf.OFFLINE_YANDEX_PATH) {
      sources.push(() => resolveYandexUrl(config.YANDEX_DISK_URL, nf.OFFLINE_YANDEX_PATH));
    }
    await downloadFromSources(sources, archivePath, 'NeoForge (offline)', {
      step: 'neoforge', verify, retries: 8, mirrorRetries: 6, keepPartOnFail: true
    });
  }
  assertZipFile(archivePath, 'NeoForge (offline)', 1024);

  emit({ type: 'step', step: 'neoforge', status: 'installing', message: 'Распаковка NeoForge...' });
  try {
    await extractZip(archivePath, gameDir);
  } finally {
    removeFileIfExists(archivePath);
    removeFileIfExists(`${archivePath}.part`);
  }

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

  const nf = config.NEOFORGE || {};

  const sources = [];
  if (config.GITHUB_OWNER && config.GITHUB_REPO &&
      config.GITHUB_OWNER !== 'YOUR_GITHUB_OWNER') {
    sources.push(`https://github.com/${config.GITHUB_OWNER}/${config.GITHUB_REPO}/releases/download/neoforge/${installerName}`);
  }
  sources.push(`https://maven.neoforged.net/releases/net/neoforged/neoforge/${nfVersion}/${installerName}`);
  if (config.YANDEX_DISK_URL && nf.INSTALLER_YANDEX_PATH) {
    sources.push(() => resolveYandexUrl(config.YANDEX_DISK_URL, nf.INSTALLER_YANDEX_PATH));
  }

  const verify = (nf.INSTALLER_SHA256 || nf.INSTALLER_SIZE)
    ? makeSizeShaVerifier(nf.INSTALLER_SIZE, nf.INSTALLER_SHA256, 'NeoForge Installer')
    : null;

  if (!fs.existsSync(installerJar) && copyFromBundle(path.join('neoforge', installerName), installerJar)) {
    dlog('NeoForge installer taken from bundle');
  }

  let haveInstaller = false;
  if (fs.existsSync(installerJar)) {
    if (!verify) {
      haveInstaller = true;
    } else {
      try { await verify(installerJar); haveInstaller = true; }
      catch (_) { removeFileIfExists(installerJar); }
    }
  }

  if (haveInstaller) {
    dlog('NeoForge installer already present, skipping download');
    emit({ type: 'step', step: 'neoforge', status: 'installing', message: 'Установщик NeoForge уже в комплекте.' });
  } else {
    await downloadFromSources(sources, installerJar, 'NeoForge Installer', { step: 'neoforge', verify });
  }

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

  try { fs.unlinkSync(installerJar); } catch (_) {}
}


function isMinecraftInstalled(gameDir) {
  const versionDir = path.join(gameDir, 'versions', config.MC_VERSION);
  return fs.existsSync(path.join(versionDir, `${config.MC_VERSION}.json`)) &&
         fs.existsSync(path.join(versionDir, `${config.MC_VERSION}.jar`));
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
  ensureDir(gameDir);
  openInstallLog(gameDir);
  try {
    emit({ type: 'step-start', step: 'java', message: 'Checking Java 21...' });
    let javaExe = null;

    if (javaPathOverride && javaPathOverride !== 'auto' && fs.existsSync(javaPathOverride)) {
      const major = await getJavaMajor(javaPathOverride);
      if (major !== null && major >= REQUIRED_JAVA_MAJOR) javaExe = javaPathOverride;
    }

    if (!javaExe) {
      javaExe = await findJava(gameDir);
    }

    dlog(`java resolved before install: ${javaExe || '(none)'}`);

    if (!javaExe) {
      javaExe = await installJava(gameDir);
    } else {
      emit({ type: 'step', step: 'java', status: 'done', message: `Java found: ${javaExe}` });
    }

    emit({ type: 'step-start', step: 'minecraft', message: 'Downloading Minecraft 1.21.1...' });
    if (isMinecraftInstalled(gameDir)) {
      emit({ type: 'step', step: 'minecraft', status: 'done', message: 'Minecraft 1.21.1 ready.' });
    } else {
      await downloadMinecraft(gameDir, javaExe);
    }

    emit({ type: 'step-start', step: 'neoforge', message: 'Installing NeoForge...' });
    if (isNeoForgeInstalled(gameDir)) {
      ensureDir(path.join(gameDir, 'mods'));
      emit({ type: 'step', step: 'neoforge', status: 'done', message: 'NeoForge installed.' });
    } else {
      await installNeoForge(gameDir, javaExe);
    }

    emit({ type: 'done', message: 'Installation complete!' });
    dlog('installation complete');
    return { success: true, javaPath: javaExe };

  } catch (err) {
    dlog(`ERROR: ${err.message}`);
    emit({ type: 'error', message: err.message });
    return { success: false, error: err.message };
  } finally {
    closeInstallLog();
  }
}

function cleanForRepair(gameDir) {
  removeDirIfExists(path.join(gameDir, 'versions'));
  removeDirIfExists(path.join(gameDir, 'libraries'));
  removeFileIfExists(path.join(gameDir, 'launcher_profiles.json'));
  try {
    for (const f of fs.readdirSync(gameDir)) {
      const lower = f.toLowerCase();
      if (lower.endsWith('.part') ||
          (lower.startsWith('neoforge-') && (lower.endsWith('.jar') || lower.endsWith('.zip')))) {
        removeFileIfExists(path.join(gameDir, f));
      }
    }
  } catch (_) {}
}

async function repair(gameDir, javaPathOverride) {
  ensureDir(gameDir);
  emit({ type: 'step-start', step: 'java', message: 'Сброс повреждённой установки...' });
  cleanForRepair(gameDir);
  return install(gameDir, javaPathOverride);
}

module.exports = { checkInstallation, install, repair, findJava, getJavaMajor, setProgressCallback, setBundleDir };
