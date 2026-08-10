

const fs   = require('fs');
const path = require('path');
const config = require('../config');

let progressCallback = null;

function setProgressCallback(cb) {
  progressCallback = cb;
}

function emit(data) {
  if (progressCallback) progressCallback(data);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch (_) { return false; }
}

function sameSize(a, b) {
  try { return fs.statSync(a).size === fs.statSync(b).size; } catch (_) { return false; }
}

function copyTree(srcDir, destDir, { overwrite = false } = {}) {
  ensureDir(destDir);
  let copied = 0;
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src  = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copied += copyTree(src, dest, { overwrite });
    } else if (entry.isFile()) {
      if (!overwrite && isFile(dest) && sameSize(src, dest)) continue;
      fs.copyFileSync(src, dest);
      copied++;
    }
  }
  return copied;
}

function resolveBundleDir(appPath, resourcesPath, packaged) {
  const dirName = config.BUNDLE_DIR_NAME || 'bundle';
  const candidates = packaged
    ? [path.join(resourcesPath, dirName), path.join(appPath, '..', dirName)]
    : [path.join(appPath, dirName)];

  for (const candidate of candidates) {
    if (isDir(candidate)) return candidate;
  }
  return null;
}

function seedJava(bundleDir, gameDir) {
  const src = path.join(bundleDir, 'runtime', 'java21');
  if (!isFile(path.join(src, 'bin', 'java.exe'))) return { skipped: 'no-bundle' };

  const dest = path.join(gameDir, 'runtime', 'java21');
  if (isFile(path.join(dest, 'bin', 'java.exe'))) return { skipped: 'already-installed' };

  emit({ type: 'step', step: 'java', status: 'installing', message: 'Распаковка Java 21 из комплекта...' });
  const files = copyTree(src, dest);
  return { copied: files };
}

function seedMods(bundleDir, gameDir) {
  const src = path.join(bundleDir, 'mods');
  if (!isDir(src)) return { skipped: 'no-bundle' };

  const dest = path.join(gameDir, 'mods');
  ensureDir(dest);

  let copied = 0;
  for (const file of fs.readdirSync(src)) {
    if (!file.toLowerCase().endsWith('.jar')) continue;
    const from = path.join(src, file);
    const to   = path.join(dest, file);
    if (isFile(to) && sameSize(from, to)) continue;
    fs.copyFileSync(from, to);
    copied++;
  }

  if (copied > 0) {
    emit({ type: 'status', message: `Моды из комплекта: скопировано ${copied}.` });
  }
  return { copied };
}

function seedNeoForgeInstaller(bundleDir, gameDir) {
  const name = `neoforge-${config.NEOFORGE_VERSION}-installer.jar`;
  const src  = path.join(bundleDir, 'neoforge', name);
  if (!isFile(src)) return { skipped: 'no-bundle' };

  const dest = path.join(gameDir, name);
  if (isFile(dest) && sameSize(src, dest)) return { skipped: 'already-present' };

  ensureDir(gameDir);
  fs.copyFileSync(src, dest);
  return { copied: 1 };
}

function seed(bundleDir, gameDir) {
  if (!bundleDir || !isDir(bundleDir) || !gameDir) {
    return { available: false };
  }

  ensureDir(gameDir);
  const result = { available: true };

  try { result.java = seedJava(bundleDir, gameDir); }
  catch (err) { result.java = { error: err.message }; }

  try { result.neoforge = seedNeoForgeInstaller(bundleDir, gameDir); }
  catch (err) { result.neoforge = { error: err.message }; }

  try { result.mods = seedMods(bundleDir, gameDir); }
  catch (err) { result.mods = { error: err.message }; }

  return result;
}

module.exports = { seed, resolveBundleDir, setProgressCallback };
