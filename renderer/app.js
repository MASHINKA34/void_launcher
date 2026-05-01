'use strict';
/* ─────────────────────────────────────────────────────────────── State */
const state = {
  profile:  null,   // { username }
  settings: null,   // loaded settings
  systemRam: 16,
  modsList:  [],
  serverPingInterval: null,
  isGameRunning: false
};

/* ─────────────────────────────────────────────────────────────── Util */
function $(id)   { return document.getElementById(id); }
function qs(sel) { return document.querySelector(sel); }

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = $(`screen-${name}`);
  if (el) el.classList.add('active');
}

function showTab(name) {
  document.querySelectorAll('.sidebar-icon').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  const btn = $(`nav-${name}`);
  const pane = $(`tab-${name}`);
  if (btn)  btn.classList.add('active');
  if (pane) pane.classList.add('active');
}

function fmtBytes(bytes) {
  if (bytes < 1024)         return `${bytes} B`;
  if (bytes < 1024*1024)    return `${(bytes/1024).toFixed(1)} KB`;
  if (bytes < 1024*1024*1024) return `${(bytes/1024/1024).toFixed(1)} MB`;
  return `${(bytes/1024/1024/1024).toFixed(2)} GB`;
}
function fmtSpeed(bps) {
  if (bps < 1024)       return `${bps} B/s`;
  if (bps < 1024*1024)  return `${(bps/1024).toFixed(1)} KB/s`;
  return `${(bps/1024/1024).toFixed(1)} MB/s`;
}

/* ─────────────────────────────────────────────────────────────── Error modal */
let modalRetryFn = null;

function showError(msg, retryFn = null) {
  $('modal-msg').textContent = msg;
  const retryBtn = $('modal-retry');
  if (retryFn) {
    retryBtn.style.display = '';
    modalRetryFn = retryFn;
  } else {
    retryBtn.style.display = 'none';
    modalRetryFn = null;
  }
  $('error-modal').classList.remove('hidden');
}

$('modal-ok').addEventListener('click', () => $('error-modal').classList.add('hidden'));
$('modal-retry').addEventListener('click', () => {
  $('error-modal').classList.add('hidden');
  if (modalRetryFn) modalRetryFn();
});

/* ─────────────────────────────────────────────────────────────── Particles */
function initParticles() {
  const canvas = $('particles-canvas');
  const ctx    = canvas.getContext('2d');
  canvas.width  = 900;
  canvas.height = 600;

  const particles = Array.from({ length: 55 }, () => ({
    x:   Math.random() * 900,
    y:   Math.random() * 600,
    r:   Math.random() * 1.8 + 0.4,
    vx:  (Math.random() - 0.5) * 0.35,
    vy:  (Math.random() - 0.5) * 0.35,
    o:   Math.random() * 0.5 + 0.1
  }));

  function draw() {
    ctx.clearRect(0, 0, 900, 600);
    for (const p of particles) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(168, 85, 247, ${p.o})`;
      ctx.fill();
      p.x += p.vx;
      p.y += p.vy;
      if (p.x < 0 || p.x > 900) p.vx *= -1;
      if (p.y < 0 || p.y > 600) p.vy *= -1;
    }
    requestAnimationFrame(draw);
  }
  draw();
}

/* ─────────────────────────────────────────────────────────────── Login Screen */
function initLoginScreen() {
  initParticles();
  const input   = $('nickname-input');
  const errEl   = $('nickname-error');
  const btnEnter = $('btn-enter');

  const NICK_RE = /^[a-zA-Z0-9_]{3,16}$/;

  function validateNick(val) {
    if (!val) return 'Никнейм обязателен.';
    if (val.length < 3)  return 'Минимум 3 символа.';
    if (val.length > 16) return 'Максимум 16 символов.';
    if (!NICK_RE.test(val)) return 'Только буквы, цифры и символ подчёркивания (_).';
    return null;
  }

  input.addEventListener('input', () => {
    const err = validateNick(input.value.trim());
    if (err) {
      input.classList.add('error');
      errEl.textContent = err;
      errEl.classList.remove('hidden');
    } else {
      input.classList.remove('error');
      errEl.classList.add('hidden');
    }
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnEnter.click();
  });

  btnEnter.addEventListener('click', async () => {
    const nick = input.value.trim();
    const err  = validateNick(nick);
    if (err) {
      input.classList.add('error');
      errEl.textContent = err;
      errEl.classList.remove('hidden');
      input.focus();
      return;
    }
    state.profile = { username: nick };
    await window.api.saveProfile(state.profile);
    await enterMain();
  });

  input.focus();
}

/* ─────────────────────────────────────────────────────────────── Install Screen */
const STEPS = [
  { id: 'java',      label: 'Java 21 Runtime'   },
  { id: 'minecraft', label: 'Minecraft 1.21.1'  },
  { id: 'neoforge',  label: 'NeoForge 21.1.172' }
];

let stepStatus = {};

function renderInstallSteps() {
  const container = $('install-steps');
  container.innerHTML = '';
  for (const step of STEPS) {
    const s   = stepStatus[step.id] || 'pending';
    const row = document.createElement('div');
    row.className = `install-step ${s === 'active' ? 'active' : ''} ${s === 'done' ? 'done' : ''} ${s === 'error' ? 'error' : ''}`;
    row.id = `step-row-${step.id}`;

    let iconHtml;
    if (s === 'active')  iconHtml = '<div class="spinner"></div>';
    else if (s === 'done')  iconHtml = '<span class="check">✓</span>';
    else if (s === 'error') iconHtml = '<span class="cross">✗</span>';
    else                    iconHtml = '<div class="dot"></div>';

    row.innerHTML = `<div class="step-icon">${iconHtml}</div><span>${step.label}</span>`;
    container.appendChild(row);
  }
}

function setInstallProgress(pct, label, speed) {
  const bar = $('install-progress-bar');
  const lbl = $('install-progress-label');
  const spd = $('install-speed');
  const track = bar.parentElement;

  if (pct === null) {
    track.classList.add('progress-indeterminate');
    bar.style.width = '40%';
  } else {
    track.classList.remove('progress-indeterminate');
    bar.style.width = `${Math.min(100, pct)}%`;
  }
  if (label) lbl.textContent = label;
  if (speed !== undefined) spd.textContent = speed;
}

function handleInstallProgress(data) {
  switch (data.type) {
    case 'step-start':
      stepStatus[data.step] = 'active';
      renderInstallSteps();
      setInstallProgress(null, data.message, '');
      break;

    case 'step':
      if (data.status === 'done') {
        stepStatus[data.step] = 'done';
        renderInstallSteps();
        setInstallProgress(100, data.message, '');
      } else if (data.status === 'error') {
        stepStatus[data.step] = 'error';
        renderInstallSteps();
      } else {
        setInstallProgress(null, data.message, '');
      }
      break;

    case 'download-progress':
      setInstallProgress(
        data.percent,
        `${data.label} — ${fmtBytes(data.received)} / ${fmtBytes(data.total)}`,
        fmtSpeed(data.speed)
      );
      break;

    case 'done':
      setInstallProgress(100, data.message, '');
      break;

    case 'error':
      $('install-error-msg').textContent = data.message;
      $('install-error').classList.remove('hidden');
      break;
  }
}

async function runInstallation() {
  showScreen('install');
  stepStatus = { java: 'pending', minecraft: 'pending', neoforge: 'pending' };
  renderInstallSteps();
  setInstallProgress(0, 'Начало установки...', '');
  $('install-error').classList.add('hidden');

  window.api.removeAllListeners('install-progress');
  window.api.onInstallProgress(handleInstallProgress);

  const result = await window.api.installGame({
    gameDir:  state.settings.gameDir,
    javaPath: state.settings.javaPath
  });

  if (!result.success) {
    $('install-error-msg').textContent = result.error || 'Установка завершилась с ошибкой.';
    $('install-error').classList.remove('hidden');
    $('btn-retry').onclick = () => runInstallation();
    return false;
  }

  if (result.javaPath && result.javaPath !== 'auto') {
    state.settings.javaPath = result.javaPath;
    await window.api.saveSettings(state.settings);
  }

  return true;
}

/* ─────────────────────────────────────────────────────────────── Server ping */
function updateServerStatus(res) {
  const dot  = qs('#server-status .status-dot');
  const text = $('status-text');
  dot.className = 'status-dot ' + (res.online ? 'online' : 'offline');
  if (res.online) {
    text.textContent = `ОНЛАЙН  ${res.players.online}/${res.players.max} игроков  ${res.ping}мс`;
  } else {
    text.textContent = 'ОФФЛАЙН';
  }
}

async function pingServer() {
  qs('#server-status .status-dot').className = 'status-dot checking';
  $('status-text').textContent = 'Проверка...';
  try {
    const res = await window.api.pingServer();
    updateServerStatus(res);
  } catch (_) {
    updateServerStatus({ online: false, ping: -1, players: { online: 0, max: 0 } });
  }
}

/* ─────────────────────────────────────────────────────────────── News */
async function loadNews() {
  const list = $('news-list');
  try {
    const news = await window.api.getNews();
    if (!news.length) { list.innerHTML = '<div class="news-loading">Новостей пока нет.</div>'; return; }
    list.innerHTML = '';
    for (const item of news) {
      const el = document.createElement('div');
      el.className = 'news-item';
      el.innerHTML = `
        <div class="news-date">${item.date || ''}</div>
        <div class="news-title">${item.title || ''}</div>
        <div class="news-body">${item.body || ''}</div>
      `;
      list.appendChild(el);
    }
  } catch (_) {
    list.innerHTML = '<div class="news-loading">Ошибка загрузки новостей.</div>';
  }
}

/* ─────────────────────────────────────────────────────────────── Mods info */
async function loadModsInfo() {
  const el = $('mods-info');
  try {
    const mods = await window.api.getModsList();
    state.modsList = mods;
    el.textContent = `${mods.length} ${mods.length === 1 ? 'мод' : mods.length >= 2 && mods.length <= 4 ? 'мода' : 'модов'} в сборке`;
  } catch (_) {
    el.textContent = '0 модов в сборке';
  }
}

/* ─────────────────────────────────────────────────────────────── Console */
let consoleAutoScroll = true;

function appendConsole(text, cls) {
  const output = $('console-output');
  const lines  = text.split('\n');
  for (const line of lines) {
    if (!line && lines[lines.length - 1] === line) continue;
    const span = document.createElement('span');
    span.className = `console-line ${cls}`;
    span.textContent = line;
    output.appendChild(span);
  }
  if (consoleAutoScroll) output.scrollTop = output.scrollHeight;
}

function initConsole() {
  $('btn-clear-console').addEventListener('click', () => {
    $('console-output').innerHTML = '';
  });

  $('btn-copy-console').addEventListener('click', async () => {
    const text = $('console-output').innerText;
    if (!text.trim()) return;
    try {
      await navigator.clipboard.writeText(text);
      const btn = $('btn-copy-console');
      const orig = btn.innerHTML;
      btn.textContent = '✓ Скопировано!';
      setTimeout(() => { btn.innerHTML = orig; }, 2000);
    } catch (_) {
      showError('Не удалось скопировать в буфер обмена.');
    }
  });

  window.api.onGameStdout((data) => appendConsole(data, 'stdout'));
  window.api.onGameStderr((data) => appendConsole(data, 'stderr'));
  window.api.onGameExit((code) => {
    state.isGameRunning = false;
    setPlayBtnState('idle');
    appendConsole(`\n[Лаунчер] Игра завершена (код ${code})\n`, 'system');
  });
}

/* ─────────────────────────────────────────────────────────────── Sync mods */
function handleModSyncProgress(data) {
  const overlay  = $('sync-overlay');
  const modName  = $('sync-mod-name');
  const bar      = $('sync-progress-bar');
  const detail   = $('sync-detail');

  switch (data.type) {
    case 'status':
      overlay.classList.remove('hidden');
      modName.textContent = data.message || '';
      break;
    case 'mod-check':
      overlay.classList.remove('hidden');
      modName.textContent = `(${data.current}/${data.total}) ${data.modName}`;
      bar.style.width = `${Math.round((data.current / data.total) * 100)}%`;
      break;
    case 'mod-download':
      overlay.classList.remove('hidden');
      detail.textContent = `${fmtBytes(data.received)} / ${fmtBytes(data.total)}  ${fmtSpeed(data.speed)}`;
      bar.style.width = `${data.percent}%`;
      break;
    case 'done':
      bar.style.width = '100%';
      overlay.classList.add('hidden');
      break;
    case 'error':
      overlay.classList.add('hidden');
      break;
  }
}

/* ─────────────────────────────────────────────────────────────── Play */
function setPlayBtnState(state_) {
  const btn = $('btn-play');
  if (state_ === 'loading') {
    btn.disabled = true;
    btn.innerHTML = `<div class="play-spinner"></div><span>ЗАПУСК...</span>`;
  } else if (state_ === 'syncing') {
    btn.disabled = true;
    btn.innerHTML = `<div class="play-spinner"></div><span>СИНХРОНИЗАЦИЯ</span>`;
  } else {
    btn.disabled = false;
    btn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg><span>ИГРАТЬ</span>`;
  }
}

async function startGame() {
  if (state.isGameRunning) {
    appendConsole('[Лаунчер] Игра уже запущена\n', 'system');
    showTab('console');
    return;
  }

  appendConsole('[Лаунчер] Нажата кнопка ИГРАТЬ\n', 'system');

  const overlay = $('sync-overlay');
  setPlayBtnState('syncing');
  $('sync-progress-bar').style.width = '0%';
  $('sync-mod-name').textContent = 'Подготовка...';
  $('sync-detail').textContent   = '';

  window.api.removeAllListeners('mod-sync-progress');
  window.api.onModSyncProgress(handleModSyncProgress);

  try {
    // ── Синхронизация модов ─────────────────────────────────────────
    overlay.classList.remove('hidden');
    appendConsole('[Лаунчер] Синхронизация модов...\n', 'system');

    const syncResult = await window.api.syncMods({ gameDir: state.settings.gameDir });
    overlay.classList.add('hidden');

    if (!syncResult.success) {
      setPlayBtnState('idle');
      appendConsole(`[ОШИБКА] Синхронизация: ${syncResult.error}\n`, 'stderr');
      showError(
        `Ошибка синхронизации модов:\n${syncResult.error}\n\nПроверь подключение к интернету.`,
        () => startGame()
      );
      return;
    }

    appendConsole('[Лаунчер] Моды синхронизированы ✓\n', 'system');

    // ── Запуск игры ─────────────────────────────────────────────────
    setPlayBtnState('loading');
    showTab('console');
    appendConsole(`[Лаунчер] Запуск Minecraft...\n[Лаунчер] Игрок: ${state.profile.username}\n[Лаунчер] Папка: ${state.settings.gameDir}\n[Лаунчер] ОЗУ: ${state.settings.ram}ГБ\n`, 'system');

    const result = await window.api.launchGame({
      username: state.profile.username,
      gameDir:  state.settings.gameDir,
      ram:      state.settings.ram,
      width:    state.settings.width,
      height:   state.settings.height,
      javaPath: state.settings.javaPath
    });

    if (!result.success) {
      setPlayBtnState('idle');
      appendConsole(`[ОШИБКА] ${result.error}\n`, 'stderr');
      showError(`Не удалось запустить Minecraft:\n${result.error}`);
      return;
    }

    appendConsole('[Лаунчер] Minecraft запущен!\n', 'system');
    state.isGameRunning = true;

  } catch (err) {
    overlay.classList.add('hidden');
    setPlayBtnState('idle');
    appendConsole(`[КРИТИЧЕСКАЯ ОШИБКА] ${err.message}\n`, 'stderr');
    showError(`Критическая ошибка:\n${err.message}`);
  }
}

/* ─────────────────────────────────────────────────────────────── Settings UI */
async function loadSettings() {
  const s = state.settings;
  $('setting-ram').max    = state.systemRam;
  $('setting-ram').value  = s.ram;
  $('ram-value').textContent = `${s.ram} ГБ`;
  $('setting-width').value   = s.width;
  $('setting-height').value  = s.height;
  $('setting-gamedir').value = s.gameDir;
  $('setting-java').value    = s.javaPath === 'auto' ? '' : s.javaPath;
  $('setting-nickname').value = state.profile?.username || '';
}

function initSettingsUI() {
  // RAM slider live update
  $('setting-ram').addEventListener('input', () => {
    $('ram-value').textContent = `${$('setting-ram').value} ГБ`;
  });

  // Browse folder
  $('btn-browse').addEventListener('click', async () => {
    const folder = await window.api.browseFolder();
    if (folder) $('setting-gamedir').value = folder;
  });

  // Detect Java
  $('btn-detect-java').addEventListener('click', async () => {
    $('btn-detect-java').textContent = 'Поиск...';
    $('btn-detect-java').disabled    = true;
    try {
      const java = await window.api.detectJava(state.settings.gameDir);
      $('setting-java').value = java || '';
      if (!java) showError('Java 21 не найдена. Установи Java 21 или запусти установку игры.');
    } finally {
      $('btn-detect-java').textContent = 'Определить';
      $('btn-detect-java').disabled    = false;
    }
  });

  // Save settings
  $('btn-save-settings').addEventListener('click', async () => {
    const newSettings = {
      ram:     parseInt($('setting-ram').value,    10),
      width:   parseInt($('setting-width').value,  10),
      height:  parseInt($('setting-height').value, 10),
      gameDir: $('setting-gamedir').value.trim() || state.settings.gameDir,
      javaPath: $('setting-java').value.trim() || 'auto'
    };
    await window.api.saveSettings(newSettings);
    state.settings = newSettings;

    const saved = $('settings-saved');
    saved.classList.remove('hidden');
    setTimeout(() => saved.classList.add('hidden'), 2500);
  });

  // Change nickname
  $('btn-change-nick').addEventListener('click', async () => {
    await window.api.deleteProfile();
    // Stop ping interval
    if (state.serverPingInterval) {
      clearInterval(state.serverPingInterval);
      state.serverPingInterval = null;
    }
    window.api.removeAllListeners('game-stdout');
    window.api.removeAllListeners('game-stderr');
    window.api.removeAllListeners('game-exit');
    state.profile = null;
    showScreen('login');
    initLoginScreen();
  });
}

/* ─────────────────────────────────────────────────────────────── Title bar */
function initTitleBar() {
  $('btn-minimize').addEventListener('click', () => window.api.minimize());
  $('btn-close').addEventListener('click',    () => window.api.close());

  // Install screen titlebar buttons
  $('install-btn-minimize').addEventListener('click', () => window.api.minimize());
  $('install-btn-close').addEventListener('click',    () => window.api.close());
}

/* ─────────────────────────────────────────────────────────────── Sidebar nav */
function initSidebar() {
  // Применяем Lucide иконки
  if (window.lucide) window.lucide.createIcons();

  document.querySelectorAll('.sidebar-icon').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      if (tab === 'settings') loadSettings();
      showTab(tab);
    });
  });
}

/* ─────────────────────────────────────────────────────────────── Enter main */
async function enterMain() {
  // Load settings
  state.settings  = await window.api.getSettings();
  state.systemRam = await window.api.getSystemRam();

  // Update player UI
  const nick = state.profile.username;
  $('player-name').textContent   = nick;
  $('player-avatar').textContent = nick.charAt(0).toUpperCase();

  showScreen('main');

  // Check installation
  const installed = await window.api.checkInstallation(state.settings.gameDir);

  if (!installed.fullyInstalled) {
    const ok = await runInstallation();
    if (!ok) return; // stays on install screen with error
  }

  showScreen('main');
  showTab('home');

  // Load content
  await Promise.all([loadNews(), loadModsInfo()]);

  // Server ping
  await pingServer();
  state.serverPingInterval = setInterval(pingServer, 30_000);

  // PLAY button
  $('btn-play').addEventListener('click', startGame);
}

/* ─────────────────────────────────────────────────────────────── Boot */
async function boot() {
  initTitleBar();
  initSidebar();
  initConsole();
  initSettingsUI();

  const profile = await window.api.getProfile();

  if (profile && profile.username) {
    state.profile = profile;
    await enterMain();
  } else {
    showScreen('login');
    initLoginScreen();
  }
}

// Инициализация Lucide иконок
if (window.lucide) window.lucide.createIcons();

boot().catch(err => {
  console.error('Boot error:', err);
  showError(`Лаунчер не смог запуститься:\n${err.message}`);
});
