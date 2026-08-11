const fs = require('fs');
const path = require('path');
const pkg = require('../package.json');
const config = require('../config');
const installer = require('../src/installer');

const ROOT = path.join(__dirname, '..');
const PORTABLE = path.join(ROOT, 'dist', `VoID-Cube-${pkg.version}-portable`);
const GAME = path.join(PORTABLE, 'game');
const OUT = process.argv[2] || `D:\\VoID-Cube-${pkg.version}-ГОТОВО.zip`;

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

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

function step(text) {
  console.log(`\n=== ${text} ===`);
}

if (!isDir(PORTABLE)) {
  console.error(`Нет собранной портативной версии: ${PORTABLE}`);
  console.error('Сначала выполни:  npm run build:portable');
  process.exit(1);
}

let lastPrint = 0;
installer.setProgressCallback((p) => {
  const now = Date.now();
  if (p.type === 'download-progress') {
    if (now - lastPrint < 2000) return;
    lastPrint = now;
    const speed = p.speed ? ` — ${(p.speed / 1024 / 1024).toFixed(1)} МБ/с` : '';
    console.log(`  ${p.label} ${p.percent}%${speed}`);
    return;
  }
  if (p.message) console.log(`  ${p.message}`);
});

(async () => {
  step('Скачиваю Minecraft и NeoForge в папку игры');
  console.log(`  ${GAME}`);
  console.log('  Это около 900 МБ, 10-25 минут. Нужен интернет.');

  installer.setBundleDir(path.join(PORTABLE, 'resources', 'bundle'));
  const result = await installer.install(GAME);

  if (!result.success) {
    console.error(`\nНе получилось: ${result.error}`);
    console.error(`Лог: ${path.join(GAME, 'logs')}`);
    process.exit(1);
  }

  const mcJar = path.join(GAME, 'versions', config.MC_VERSION, `${config.MC_VERSION}.jar`);
  const nfJar = path.join(GAME, 'libraries', 'net', 'neoforged', 'neoforge',
                          config.NEOFORGE_VERSION, `neoforge-${config.NEOFORGE_VERSION}-universal.jar`);
  if (!isFile(mcJar) || !isFile(nfJar)) {
    console.error('\nИгра скачалась не полностью, повтори команду.');
    process.exit(1);
  }

  step('Убираю мусор');
  for (const junk of [path.join(GAME, 'logs'), path.join(PORTABLE, 'data')]) {
    fs.rmSync(junk, { recursive: true, force: true });
    console.log(`  ${path.basename(junk)}`);
  }
  fs.mkdirSync(path.join(PORTABLE, 'data'), { recursive: true });
  for (const file of fs.readdirSync(GAME)) {
    if (/\.log$/i.test(file) || /\.part$/i.test(file)) {
      fs.rmSync(path.join(GAME, file), { force: true });
      console.log(`  ${file}`);
    }
  }

  step('Собираю архив');
  console.log(`  ${OUT}`);
  console.log(`  Внутри: ${mb(dirSize(PORTABLE))}. Займёт несколько минут.`);

  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  zip.addLocalFolder(PORTABLE, `VoID-Cube-${pkg.version}`);
  zip.writeZip(OUT);

  step('Готово');
  console.log(`  Файл:   ${OUT}`);
  console.log(`  Размер: ${mb(fs.statSync(OUT).size)}`);
  console.log('\n  Отправляй этот файл целиком. Валентину нужно:');
  console.log('  1. распаковать в папку без русских букв, например C:\\VoIDCube');
  console.log('  2. запустить "VoID Cube.exe"');
  console.log('  3. придумать ник и пароль, нажать "Создать аккаунт"');
  console.log('  Ничего не качается, интернет нужен только для игры на сервере.');
})();
