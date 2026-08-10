const fs = require('fs');
const path = require('path');
const config = require('../config');

const ROOT = path.join(__dirname, '..');
const BUNDLE = path.join(ROOT, 'bundle');

const MODS_SRC = process.env.VC_MODS_SRC
  || path.join(__dirname, 'staging-mods-original');
const MODS_FALLBACK = 'C:/Users/mashi/curseforge/minecraft/Instances/kal/mods';
const JAVA_SRC = process.env.VC_JAVA_SRC
  || 'C:/Users/mashi/curseforge/minecraft/Install/java/Jre_21';
const NF_INSTALLER = process.env.VC_NEOFORGE_INSTALLER
  || path.join(__dirname, `neoforge-${config.NEOFORGE_VERSION}-installer.jar`);

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch (_) { return false; }
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

const modsSrc = isDir(MODS_SRC) ? MODS_SRC : MODS_FALLBACK;

if (!isDir(modsSrc)) {
  console.error(`Mods source not found: ${modsSrc}\nSet VC_MODS_SRC to the instance mods folder.`);
  process.exit(1);
}
if (!isFile(path.join(JAVA_SRC, 'bin', 'java.exe'))) {
  console.error(`Java 21 runtime not found: ${JAVA_SRC}\nSet VC_JAVA_SRC to a JRE 21 folder.`);
  process.exit(1);
}
if (!isFile(NF_INSTALLER)) {
  console.error(`NeoForge installer not found: ${NF_INSTALLER}\nSet VC_NEOFORGE_INSTALLER or drop the jar into tools/.`);
  process.exit(1);
}

fs.rmSync(BUNDLE, { recursive: true, force: true });
fs.mkdirSync(BUNDLE, { recursive: true });

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'mods-list.json'), 'utf8'));
const modsDest = path.join(BUNDLE, 'mods');
fs.mkdirSync(modsDest, { recursive: true });

let missing = 0;
for (const mod of manifest) {
  const from = path.join(modsSrc, mod.filename);
  if (!isFile(from)) {
    console.error(`  MISSING ${mod.filename}`);
    missing++;
    continue;
  }
  const size = fs.statSync(from).size;
  if (size !== mod.size) {
    console.error(`  SIZE MISMATCH ${mod.filename}: ${size} != ${mod.size}`);
    missing++;
    continue;
  }
  fs.copyFileSync(from, path.join(modsDest, mod.filename));
}

if (missing > 0) {
  console.error(`\n${missing} mods missing or stale. Regenerate mods-list.json first:`);
  console.error(`  node tools/gen-mods-list.js "${modsSrc}"`);
  process.exit(1);
}
console.log(`mods      : ${manifest.length} jars`);

const javaDest = path.join(BUNDLE, 'runtime', 'java21');
const javaFiles = copyTree(JAVA_SRC, javaDest);
console.log(`java      : ${javaFiles} files from ${JAVA_SRC}`);

const nfDest = path.join(BUNDLE, 'neoforge');
fs.mkdirSync(nfDest, { recursive: true });
fs.copyFileSync(NF_INSTALLER, path.join(nfDest, path.basename(NF_INSTALLER)));
console.log(`neoforge  : ${path.basename(NF_INSTALLER)}`);

console.log(`\nbundle    : ${(dirSize(BUNDLE) / 1024 / 1024).toFixed(1)} MB -> ${BUNDLE}`);
