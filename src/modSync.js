/**
 * modSync.js
 * Synchronises the mods folder with mods-list.json before every launch.
 * Steps: remove unknown jars → verify hashes → download missing/corrupted mods.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const fetch  = require('node-fetch');
const { pipeline } = require('stream/promises');

let progressCallback = null;

function setProgressCallback(cb) {
  progressCallback = cb;
}

function emit(data) {
  if (progressCallback) progressCallback(data);
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

async function downloadMod(mod, destPath) {
  const res = await fetch(mod.url, { timeout: 60_000 });
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${mod.name}`);

  const total  = parseInt(res.headers.get('content-length') || '0', 10);
  let received = 0;
  const start  = Date.now();

  res.body.on('data', (chunk) => {
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
  });

  await pipeline(res.body, fs.createWriteStream(destPath));
}

const DOWNLOAD_ATTEMPTS = 3;

async function downloadAndVerify(mod, destPath) {
  let lastError = null;

  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      emit({
        type:    'status',
        message: attempt === 1
          ? `Downloading ${mod.name}...`
          : `Retrying ${mod.name} (${attempt}/${DOWNLOAD_ATTEMPTS})...`
      });

      await downloadMod(mod, destPath);

      if (mod.sha256) {
        const hash = await getFileSHA256(destPath);
        if (hash.toLowerCase() !== mod.sha256.toLowerCase()) {
          throw new Error(`Hash verification failed for ${mod.name} after download`);
        }
      }
      return;
    } catch (err) {
      lastError = err;
      try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch (_) {}
    }
  }

  throw lastError;
}

// ─── Main sync ────────────────────────────────────────────────────────────────

async function sync(gameDir, modsListPath, disabledMods = []) {
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

    const disabled = new Set((disabledMods || []).map(f => String(f).toLowerCase()));
    modsList = modsList.filter(m => !(m.client === true && disabled.has(String(m.filename).toLowerCase())));

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
