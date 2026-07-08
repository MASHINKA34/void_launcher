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

  const total  = parseInt(res.headers.get('content-length') || '0', 10);
  let received = 0;
  const start  = Date.now();

  await pipeline(
    toNodeReadable(res.body),
    new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (total > 0) {
          const elapsed = (Date.now() - start) / 1000 || 0.001;
          emit({
            type:     'mod-download',
            modName:  mod.name,
            percent:  Math.round((received / total) * 100),
            received,
            total,
            speed:    Math.round(received / elapsed)
          });
        }

        callback(null, chunk);
      }
    }),
    fs.createWriteStream(partPath)
  );

  if (total > 0 && received !== total) {
    throw new Error(`INCOMPLETE_DOWNLOAD ${received}/${total}`);
  }
}

const DOWNLOAD_ATTEMPTS = 3;

async function downloadAndVerify(mod, destPath) {
  let lastError = null;
  const partPath = `${destPath}.part`;
  const sources = buildModSources(mod);

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
        removeFileIfExists(destPath);
        fs.renameSync(partPath, destPath);

        if (mod.sha256) {
          const hash = await getFileSHA256(destPath);
          if (hash.toLowerCase() !== mod.sha256.toLowerCase()) {
            throw new Error(`Hash verification failed for ${mod.name} after download`);
          }
        }
        removeFileIfExists(partPath);
        return;
      } catch (err) {
        lastError = err;
        removeFileIfExists(partPath);
        removeFileIfExists(destPath);

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

    // Read mod list
    let modsList = [];
    try {
      modsList = JSON.parse(fs.readFileSync(modsListPath, 'utf8'));
    } catch (_) {
      emit({ type: 'done', message: 'No mods list found — skipping sync.' });
      return { success: true };
    }

    const expectedFilenames = new Set(modsList.map(m => m.filename));

    // ── Step 1: Remove unknown jars ────────────────────────────────────────────
    emit({ type: 'status', message: 'Cleaning old mods...' });
    const existing = fs.readdirSync(modsDir).filter(f => f.endsWith('.jar'));
    for (const file of existing) {
      if (!expectedFilenames.has(file)) {
        fs.unlinkSync(path.join(modsDir, file));
        emit({ type: 'status', message: `Removed: ${file}` });
      }
    }

    // ── Step 2: Verify / download each mod ────────────────────────────────────
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

      let needsDownload = false;

      if (!fs.existsSync(modPath)) {
        needsDownload = true;
      } else if (mod.sha256) {
        // Verify hash
        emit({ type: 'status', message: `Verifying ${mod.name}...` });
        const hash = await getFileSHA256(modPath);
        if (hash.toLowerCase() !== mod.sha256.toLowerCase()) {
          emit({ type: 'status', message: `Hash mismatch for ${mod.name}, re-downloading...` });
          fs.unlinkSync(modPath);
          needsDownload = true;
        }
      }

      if (needsDownload) {
        await downloadAndVerify(mod, modPath);
        emit({ type: 'mod-done', modName: mod.name });
      }
    }

    emit({ type: 'done', message: `All ${modsList.length} mods verified.` });
    return { success: true };

  } catch (err) {
    emit({ type: 'error', message: err.message });
    return { success: false, error: err.message };
  }
}

module.exports = { sync, setProgressCallback };
