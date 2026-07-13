/**
 * modSync.js
 * Synchronises the mods folder with mods-list.json before every launch.
 * Steps: remove unknown jars → verify hashes → download missing/corrupted mods.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const config = require('../config');
const { fetchWithTimeout, toNodeReadable, normalizeNetworkError } = require('./net');

let progressCallback = null;

function setProgressCallback(cb) {
  progressCallback = cb;
}

function emit(data) {
  if (progressCallback) progressCallback(data);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function removeFileIfExists(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (_) {}
}

function validateManifest(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Список модов пуст или имеет неверный формат.');
  }

  const seen = new Set();
  let manifestVersion = null;

  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`Некорректная запись мода №${index + 1}.`);
    }

    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    const filename = typeof raw.filename === 'string' ? raw.filename.trim() : '';
    const sha256 = typeof raw.sha256 === 'string' ? raw.sha256.trim() : '';
    const size = raw.size;
    const version = raw.manifestVersion;

    if (!name || !filename || path.basename(filename) !== filename || !/\.jar$/i.test(filename)) {
      throw new Error(`Некорректное имя файла мода №${index + 1}.`);
    }
    if (!/^[a-f0-9]{64}$/i.test(sha256)) {
      throw new Error(`Некорректная контрольная сумма мода "${name}".`);
    }
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw new Error(`Некорректный размер мода "${name}".`);
    }
    if (!Number.isSafeInteger(version) || version <= 0) {
      throw new Error('Список модов не содержит корректную версию.');
    }
    if (manifestVersion === null) manifestVersion = version;
    if (version !== manifestVersion) {
      throw new Error('Версии записей в списке модов не совпадают.');
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(raw.url);
    } catch (_) {
      throw new Error(`Некорректная ссылка мода "${name}".`);
    }
    if (parsedUrl.protocol !== 'https:') {
      throw new Error(`Некорректная ссылка мода "${name}".`);
    }

    const key = filename.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`Мод "${filename}" указан в списке несколько раз.`);
    }
    seen.add(key);

    return {
      ...raw,
      name,
      filename,
      url: parsedUrl.toString(),
      sha256: sha256.toUpperCase(),
      size,
      manifestVersion: version
    };
  });
}

function normalizeDownloadError(mod, err) {
  const message = String(err?.message || err || '');

  if (/HTTP 404/i.test(message)) {
    return `Не удалось скачать мод "${mod.name}": файл не найден в релизе.`;
  }

  return `Не удалось скачать мод "${mod.name}": ${normalizeNetworkError(err)}.`;
}

function buildModSources(mod) {
  const sources = [];

  if (mod.url) {
    sources.push(mod.url);
  }

  if (Array.isArray(config.MOD_MIRRORS)) {
    for (const mirror of config.MOD_MIRRORS) {
      if (!mirror || !mod.filename) continue;
      const encodedName = encodeURIComponent(mod.filename);
      sources.push(
        mirror.includes('{filename}')
          ? mirror.replaceAll('{filename}', encodedName)
          : `${mirror.replace(/\/$/, '')}/${encodedName}`
      );
    }
  }

  const seen = new Set();
  return sources.filter(url => {
    if (seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

// ─── Hash ─────────────────────────────────────────────────────────────────────

function getFileSHA256(filePath) {
  return new Promise((resolve, reject) => {
    const hash   = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data',  (d) => hash.update(d));
    stream.on('end',   ()  => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// ─── Download ─────────────────────────────────────────────────────────────────

async function downloadModFromUrl(mod, url, partPath) {
  const res = await fetchWithTimeout(url, {
    headers: { 'User-Agent': config.LAUNCHER_NAME },
    redirect: 'follow'
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${mod.name}`);

  const responseSize = parseInt(res.headers.get('content-length') || '0', 10);
  if (responseSize > 0 && responseSize !== mod.size) {
    throw new Error(`SIZE_MISMATCH ${responseSize}/${mod.size}`);
  }

  const total  = mod.size;
  let received = 0;
  const start  = Date.now();
  const source = toNodeReadable(res.body);
  const target = fs.createWriteStream(partPath, { flags: 'wx' });
  let idleTimer = null;

  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      const error = new Error('TIMEOUT 30s');
      source.destroy(error);
      target.destroy(error);
    }, 30_000);
  };

  resetIdleTimer();
  try {
    await pipeline(
      source,
      new Transform({
        transform(chunk, _encoding, callback) {
          resetIdleTimer();
          received += chunk.length;
          const elapsed = (Date.now() - start) / 1000 || 0.001;
          emit({
            type:     'mod-download',
            modName:  mod.name,
            percent:  Math.min(100, Math.round((received / total) * 100)),
            received,
            total,
            speed:    Math.round(received / elapsed)
          });
          callback(null, chunk);
        }
      }),
      target
    );
  } finally {
    clearTimeout(idleTimer);
  }

  if (received !== total) {
    throw new Error(`INCOMPLETE_DOWNLOAD ${received}/${total}`);
  }
}

const DOWNLOAD_ATTEMPTS = 5;

async function verifyFile(filePath, mod) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (_) {
    return false;
  }
  if (!stat.isFile() || stat.size !== mod.size) return false;
  const hash = await getFileSHA256(filePath);
  return hash.toLowerCase() === mod.sha256.toLowerCase();
}

async function downloadAndVerify(mod, destPath) {
  let lastError = null;
  const partPath = `${destPath}.part`;
  const sources = buildModSources(mod);

  if (sources.length === 0) {
    throw new Error(`Для мода "${mod.name}" не указан источник загрузки.`);
  }

  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
    for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
      removeFileIfExists(partPath);

      try {
        emit({
          type:    'status',
          message: attempt === 1 && sourceIndex === 0
            ? `Downloading ${mod.name}...`
            : `Retrying ${mod.name} (${attempt}/${DOWNLOAD_ATTEMPTS})...`
        });

        await downloadModFromUrl(mod, sources[sourceIndex], partPath);
        if (!await verifyFile(partPath, mod)) {
          throw new Error(`Hash verification failed for ${mod.name} after download`);
        }
        removeFileIfExists(destPath);
        fs.renameSync(partPath, destPath);
        return;
      } catch (err) {
        lastError = err;
        removeFileIfExists(partPath);

        if (attempt < DOWNLOAD_ATTEMPTS) {
          await sleep(1_000 * attempt);
        }
      }
    }
  }

  throw new Error(normalizeDownloadError(mod, lastError));
}

// ─── Main sync ────────────────────────────────────────────────────────────────

async function sync(gameDir, modsListPath) {
  try {
    const modsDir = path.join(gameDir, 'mods');
    if (!fs.existsSync(modsDir)) fs.mkdirSync(modsDir, { recursive: true });

    const modsList = validateManifest(JSON.parse(fs.readFileSync(modsListPath, 'utf8')));
    const expectedFilenames = new Set(modsList.map(m => m.filename.toLowerCase()));

    let current = 0;
    for (const mod of modsList) {
      current++;
      const modPath = path.join(modsDir, mod.filename);

      emit({
        type:    'mod-check',
        modName: mod.name,
        current,
        total:   modsList.length,
        message: `Checking ${mod.name}...`
      });

      emit({ type: 'status', message: `Verifying ${mod.name}...` });
      const needsDownload = !await verifyFile(modPath, mod);

      if (needsDownload) {
        await downloadAndVerify(mod, modPath);
        emit({ type: 'mod-done', modName: mod.name });
      }
    }

    emit({ type: 'status', message: 'Final verification...' });
    for (const mod of modsList) {
      if (!await verifyFile(path.join(modsDir, mod.filename), mod)) {
        throw new Error(`Мод "${mod.name}" не прошёл итоговую проверку.`);
      }
    }

    const existing = fs.readdirSync(modsDir).filter(f => f.toLowerCase().endsWith('.jar'));
    for (const file of existing) {
      if (!expectedFilenames.has(file.toLowerCase())) {
        fs.unlinkSync(path.join(modsDir, file));
        emit({ type: 'status', message: `Removed: ${file}` });
      }
    }

    emit({ type: 'done', message: `All ${modsList.length} mods verified.` });
    return { success: true, manifestVersion: modsList[0].manifestVersion };

  } catch (err) {
    emit({ type: 'error', message: err.message });
    return { success: false, error: err.message };
  }
}

module.exports = { sync, setProgressCallback, validateManifest, verifyFile };
