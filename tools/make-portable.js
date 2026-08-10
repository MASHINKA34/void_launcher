const fs = require('fs');
const path = require('path');
const pkg = require('../package.json');
const config = require('../config');

const ROOT = path.join(__dirname, '..');
const UNPACKED = path.join(ROOT, 'dist', 'win-unpacked');
const BUNDLE = path.join(UNPACKED, 'resources', 'bundle');
const OUT = path.join(ROOT, 'dist', `VoID-Cube-${pkg.version}-portable`);

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) count += copyTree(from, to);
    else if (entry.isFile()) { fs.copyFileSync(from, to); count++; }
  }
  return count;
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(p);
    else if (entry.isFile()) total += fs.statSync(p).size;
  }
  return total;
}

if (!isDir(UNPACKED)) {
  console.error(`Build not found: ${UNPACKED}\nRun: npm run build:offline`);
  process.exit(1);
}
if (!isDir(BUNDLE)) {
  console.error(`Bundle not found inside build: ${BUNDLE}\nRun: npm run bundle, then rebuild.`);
  process.exit(1);
}

fs.rmSync(OUT, { recursive: true, force: true });
console.log(`copying build -> ${OUT}`);
copyTree(UNPACKED, OUT);

fs.writeFileSync(
  path.join(OUT, 'portable.txt'),
  `VoID Cube ${pkg.version} portable\nGame data lives in .\\game, launcher data in .\\data\n`,
  'utf8'
);

const gameDir = path.join(OUT, 'game');
const outBundle = path.join(OUT, 'resources', 'bundle');

const modsSrc = path.join(outBundle, 'mods');
if (isDir(modsSrc)) {
  const n = copyTree(modsSrc, path.join(gameDir, 'mods'));
  fs.rmSync(modsSrc, { recursive: true, force: true });
  console.log(`mods      : ${n} jars pre-installed into game\\mods`);
}

const javaSrc = path.join(outBundle, 'runtime', 'java21');
if (isDir(javaSrc)) {
  const n = copyTree(javaSrc, path.join(gameDir, 'runtime', 'java21'));
  fs.rmSync(path.join(outBundle, 'runtime'), { recursive: true, force: true });
  console.log(`java      : ${n} files pre-installed into game\\runtime\\java21`);
}

const nfName = `neoforge-${config.NEOFORGE_VERSION}-installer.jar`;
const nfSrc = path.join(outBundle, 'neoforge', nfName);
if (fs.existsSync(nfSrc)) {
  fs.mkdirSync(gameDir, { recursive: true });
  fs.copyFileSync(nfSrc, path.join(gameDir, nfName));
  console.log(`neoforge  : ${nfName} pre-installed into game`);
}

fs.mkdirSync(path.join(OUT, 'data'), { recursive: true });

console.log(`\nportable  : ${(dirSize(OUT) / 1024 / 1024).toFixed(1)} MB -> ${OUT}`);
