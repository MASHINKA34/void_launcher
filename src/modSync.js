/**
 * modSync.js
 * Synchronises the mods folder with mods-list.json before every launch.
 * Steps: remove unknown jars → verify hashes → download missing/corrupted mods.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const fetch  = require('node-fetch');

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
  const writer = fs.createWriteStream(destPath);

  await new Promise((resolve, reject) => {
    res.body.on('data', (chunk) => {
      received += chunk.length;
      writer.write(chunk);
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
    res.body.on('end',   () => { writer.end(); resolve(); });
    res.body.on('error', reject);
    writer.on('error',   reject);
  });
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
        emit({ type: 'status', message: `Downloading ${mod.name}...` });
        await downloadMod(mod, modPath);

        // Verify hash after download
        if (mod.sha256) {
          const hash = await getFileSHA256(modPath);
          if (hash.toLowerCase() !== mod.sha256.toLowerCase()) {
            fs.unlinkSync(modPath);
            throw new Error(`Hash verification failed for ${mod.name} after download`);
          }
        }

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
