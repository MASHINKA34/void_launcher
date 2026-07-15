const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const INSTANCE_MODS = process.argv[2] || 'C:\\Users\\mashi\\curseforge\\minecraft\\Instances\\kal\\mods';
const OWNER = 'MASHINKA34';
const REPO = 'void_launcher';
const RELEASE_TAG = 'mods';
const STAGING = path.join(__dirname, 'staging-mods');
const OUT = path.join(__dirname, '..', 'mods-list.json');
const MANIFEST_VERSION = Date.now();
const ASSET_TAG = RELEASE_TAG;

const STOP = /^(v?\d|neoforge|forge|fabric|quilt|mc?1\.\d|1\.\d)/i;

function prettyName(filename) {
  const base = filename.replace(/\.jar$/i, '');
  const parts = base.split(/[-_]/);
  const words = [];
  for (const p of parts) {
    if (STOP.test(p)) break;
    words.push(p);
  }
  const name = (words.length ? words : [base]).join(' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return name || base;
}

function safeName(filename) {
  return filename.replace(/\.jar$/i, '').replace(/[^A-Za-z0-9._-]+/g, '.').replace(/\.+/g, '.') + '.jar';
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();
}

fs.rmSync(STAGING, { recursive: true, force: true });
fs.mkdirSync(STAGING, { recursive: true });

const jars = fs.readdirSync(INSTANCE_MODS).filter(f => f.toLowerCase().endsWith('.jar')).sort();
const seen = new Set();
const list = jars.map(original => {
  let assetName = safeName(original);
  let n = 1;
  while (seen.has(assetName.toLowerCase())) assetName = safeName(original).replace(/\.jar$/i, `.${n++}.jar`);
  seen.add(assetName.toLowerCase());

  const buf = fs.readFileSync(path.join(INSTANCE_MODS, original));
  fs.writeFileSync(path.join(STAGING, assetName), buf);

  return {
    name: prettyName(original),
    filename: original,
    url: `https://github.com/${OWNER}/${REPO}/releases/download/${ASSET_TAG}/${assetName}`,
    sha256: sha256(buf),
    size: buf.length,
    manifestVersion: MANIFEST_VERSION
  };
});

fs.writeFileSync(OUT, JSON.stringify(list, null, 2) + '\n', 'utf8');
console.log(`Staged ${list.length} jars -> ${STAGING}`);
console.log(`Wrote ${list.length} mods -> ${OUT}`);
