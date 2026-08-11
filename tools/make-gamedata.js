const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const config = require('../config');

const ROOT = path.join(__dirname, '..');
const PARTS = ['versions', 'libraries', 'assets'];

const SOURCE = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, 'dist', `VoID-Cube-${require('../package.json').version}-portable`, 'game');
const OUT = path.join(ROOT, 'dist', 'game-data.zip');

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch (_) { return false; }
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

if (!isDir(SOURCE)) {
  console.error(`Game folder not found: ${SOURCE}`);
  console.error('Usage: node tools/make-gamedata.js <path to an installed game folder>');
  process.exit(1);
}

const mcJson = path.join(SOURCE, 'versions', config.MC_VERSION, `${config.MC_VERSION}.json`);
const mcJar  = path.join(SOURCE, 'versions', config.MC_VERSION, `${config.MC_VERSION}.jar`);
const nfJar  = path.join(SOURCE, 'libraries', 'net', 'neoforged', 'neoforge',
                         config.NEOFORGE_VERSION, `neoforge-${config.NEOFORGE_VERSION}-universal.jar`);

if (!isFile(mcJson) || !isFile(mcJar)) {
  console.error(`Minecraft ${config.MC_VERSION} is not installed in ${SOURCE}`);
  console.error('Run the launcher once with internet, then repeat.');
  process.exit(1);
}
if (!isFile(nfJar)) {
  console.error(`NeoForge ${config.NEOFORGE_VERSION} is not installed in ${SOURCE}`);
  console.error('Run the launcher once with internet, then repeat.');
  process.exit(1);
}

const missing = PARTS.filter(part => !isDir(path.join(SOURCE, part)));
if (missing.length) {
  console.error(`Missing folders in ${SOURCE}: ${missing.join(', ')}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
if (isFile(OUT)) fs.unlinkSync(OUT);

const zip = new AdmZip();
for (const part of PARTS) {
  const dir = path.join(SOURCE, part);
  console.log(`${part.padEnd(10)} ${(dirSize(dir) / 1024 / 1024).toFixed(1)} MB`);
  zip.addLocalFolder(dir, part);
}

console.log('\nwriting archive, this takes a few minutes...');
zip.writeZip(OUT);

console.log(`\ngame-data : ${(fs.statSync(OUT).size / 1024 / 1024).toFixed(1)} MB -> ${OUT}`);
console.log('Put this file next to "VoID Cube.exe" on the other machine and start the launcher.');
