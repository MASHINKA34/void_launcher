'use strict';
/* ─────────────────────────────────────────────────────────────── State */
const state = {
  profile:  null,   // { username }
  settings: null,   // loaded settings
  systemRam: 16,
  modsList:  [],
  serverPingInterval: null,
  serverStatusKnown: false,
  serverPingInFlight: false,
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
let particlesStarted = false;

function initParticles() {
  if (particlesStarted) return;
  particlesStarted = true;

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
const NICK_RE = /^[a-zA-Z0-9_]{3,16}$/;
const PASSWORD_MIN = 4;
let authMode = 'login';
let loginScreenInitialized = false;

function validateNick(val) {
  if (!val) return 'Никнейм обязателен.';
  if (val.length < 3)  return 'Минимум 3 символа.';
  if (val.length > 16) return 'Максимум 16 символов.';
  if (!NICK_RE.test(val)) return 'Только латинские буквы, цифры и _ (кириллица не поддерживается).';
  return null;
}

function validatePassword(val) {
  if (!val) return 'Пароль обязателен.';
  if (val.length < PASSWORD_MIN) return `Минимум ${PASSWORD_MIN} символа.`;
  if (val.length > 128) return 'Максимум 128 символов.';
  return null;
}

function setFieldError(input, errEl, message) {
  if (message) {
    input.classList.add('error');
    errEl.textContent = message;
    errEl.classList.remove('hidden');
  } else {
    input.classList.remove('error');
    errEl.classList.add('hidden');
  }
}

function initLoginScreen(prefillNick = '') {
  initParticles();
  const input    = $('nickname-input');
  const errEl    = $('nickname-error');
  const passInput = $('password-input');
  const passErrEl = $('password-error');
  const passToggle = $('password-toggle');
  const btnEnter = $('btn-enter');
  const btnToggle = $('btn-auth-toggle');
  const dropdown = $('nick-dropdown');

  function setPasswordVisible(visible) {
    passInput.type = visible ? 'text' : 'password';
    passToggle.title = visible ? 'Скрыть пароль' : 'Показать пароль';
    passToggle.setAttribute('aria-label', passToggle.title);
    passToggle.innerHTML = `<i data-lucide="${visible ? 'eye-off' : 'eye'}" width="18" height="18"></i>`;
    if (window.lucide) window.lucide.createIcons();
  }

  function setAuthMode(mode) {
    authMode = mode;
    btnEnter.querySelector('span').textContent = mode === 'register' ? 'ЗАРЕГИСТРИРОВАТЬ' : 'ВОЙТИ В МИР';
    btnToggle.textContent = mode === 'register' ? 'Уже есть аккаунт? Войти' : 'Создать аккаунт';
    passInput.autocomplete = mode === 'register' ? 'new-password' : 'current-password';
    setFieldError(input, errEl, null);
    setFieldError(passInput, passErrEl, null);
  }

  async function renderDropdown() {
    const profiles = await window.api.getProfiles();
    if (!profiles.length) { dropdown.classList.add('hidden'); return; }

    dropdown.innerHTML = '';
    profiles.forEach(nick => {
      const item = document.createElement('div');
      item.className = 'nick-dropdown-item';
      item.innerHTML = `<span class="nick-label">${nick}</span><span class="nick-delete" title="Удалить">×</span>`;

      item.addEventListener('mousedown', (e) => {
        if (e.target.classList.contains('nick-delete')) return;
        e.preventDefault();
        input.value = nick;
        dropdown.classList.add('hidden');
        errEl.classList.add('hidden');
        input.classList.remove('error');
        passInput.focus();
      });

      item.querySelector('.nick-delete').addEventListener('mousedown', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await window.api.deleteProfileFromHistory(nick);
        renderDropdown();
      });

      dropdown.appendChild(item);
    });
    dropdown.classList.remove('hidden');
  }

  async function submitAuth() {
    const nick = input.value.trim();
    const password = passInput.value;
    const nickErr = validateNick(nick);
    const passErr = validatePassword(password);

    setFieldError(input, errEl, nickErr);
    setFieldError(passInput, passErrEl, passErr);

    if (nickErr) { input.focus(); return; }
    if (passErr) { passInput.focus(); return; }

    btnEnter.disabled = true;
    try {
      const remember = $('remember-me')?.checked ?? true;
      const request = { username: nick, password, remember };
      const result = authMode === 'register'
        ? await window.api.registerAccount(request)
        : await window.api.loginAccount(request);

      if (!result.success) {
        setFieldError(passInput, passErrEl, result.error || 'Не удалось войти.');
        passInput.focus();
        return;
      }

      state.profile = result.profile || { username: nick };
      passInput.value = '';
      await enterMain();
    } finally {
      btnEnter.disabled = false;
    }
  }

  if (prefillNick) input.value = prefillNick;
  passInput.value = '';
  setPasswordVisible(false);
  setAuthMode('login');

  if (loginScreenInitialized) {
    setTimeout(() => (input.value ? passInput : input).focus(), 0);
    return;
  }
  loginScreenInitialized = true;

  input.addEventListener('focus', renderDropdown);
  input.addEventListener('blur', () => setTimeout(() => dropdown.classList.add('hidden'), 150));
  input.addEventListener('input', () => {
    renderDropdown();
    setFieldError(input, errEl, validateNick(input.value.trim()));
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if (passInput.value) submitAuth();
      else passInput.focus();
    }
    if (e.key === 'Escape') dropdown.classList.add('hidden');
  });

  passInput.addEventListener('input', () => {
    if (!passInput.value) setFieldError(passInput, passErrEl, null);
    else setFieldError(passInput, passErrEl, validatePassword(passInput.value));
  });

  passInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitAuth();
  });

  passToggle.addEventListener('click', () => {
    setPasswordVisible(passInput.type === 'password');
    passInput.focus();
  });

  btnEnter.addEventListener('click', submitAuth);
  btnToggle.addEventListener('click', () => {
    setAuthMode(authMode === 'register' ? 'login' : 'register');
    passInput.focus();
  });

  setTimeout(() => (input.value ? passInput : input).focus(), 0);
}

/* ─────────────────────────────────────────────────────────────── Install Screen */
const STEPS = [
  { id: 'java',      label: 'Java 21 Runtime'   },
  { id: 'minecraft', label: 'Minecraft 1.21.1'  },
  { id: 'neoforge',  label: 'NeoForge 21.1.233' }
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
  state.serverStatusKnown = true;
  dot.className = 'status-dot ' + (res.online ? 'online' : 'offline');
  if (res.online) {
    text.textContent = `ОНЛАЙН  ${res.players.online}/${res.players.max} игроков`;
  } else {
    text.textContent = 'ОФФЛАЙН';
  }
}

async function pingServer() {
  if (state.serverPingInFlight) return;
  state.serverPingInFlight = true;
  if (!state.serverStatusKnown) {
    qs('#server-status .status-dot').className = 'status-dot checking';
    $('status-text').textContent = 'Проверка...';
  }
  try {
    const res = await window.api.pingServer();
    updateServerStatus(res);
  } catch (_) {
    updateServerStatus({ online: false, ping: -1, players: { online: 0, max: 0 } });
  } finally {
    state.serverPingInFlight = false;
  }
}

/* ─────────────────────────────────────────────────────────────── News */
function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function linkify(text) {
  return escapeHtml(text).replace(/(https?:\/\/[^\s<]+)/g, (match) => {
    const clean = match.replace(/[.,!?;:)]+$/, '');
    const trail = match.slice(clean.length);
    return `<a href="${clean}" target="_blank" rel="noopener noreferrer" class="news-link">${clean}</a>${trail}`;
  });
}

function openNewsModal(item) {
  $('news-modal-date').textContent  = item.date  || '';
  $('news-modal-title').textContent = item.title || '';
  $('news-modal-body').innerHTML    = linkify(item.body || '');
  $('news-modal-overlay').classList.remove('hidden');
}

function closeNewsModal() {
  $('news-modal-overlay').classList.add('hidden');
}

async function loadNews() {
  const list = $('news-list');
  try {
    const news = await window.api.getNews();
    if (!news.length) {
      if (!list.querySelector('.news-item')) {
        list.innerHTML = '<div class="news-loading">Новостей пока нет.</div>';
      }
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const item of news) {
      const el = document.createElement('div');
      el.className = 'news-item';
      el.innerHTML = `
        <div class="news-date">${escapeHtml(item.date || '')}</div>
        <div class="news-title">${escapeHtml(item.title || '')}</div>
        <div class="news-body">${linkify(item.body || '')}</div>
      `;
      el.addEventListener('click', (e) => {
        if (e.target.closest('a')) return;
        if (window.getSelection().toString()) return;
        openNewsModal(item);
      });
      fragment.appendChild(el);
    }
    list.innerHTML = '';
    list.appendChild(fragment);
  } catch (_) {
    // не трогаем список если уже есть новости
    if (!list.querySelector('.news-item')) {
      list.innerHTML = '<div class="news-loading">Ошибка загрузки новостей.</div>';
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  $('news-modal-close').addEventListener('click', closeNewsModal);
  $('news-modal-overlay').addEventListener('click', (e) => {
    if (e.target === $('news-modal-overlay')) closeNewsModal();
  });
});

/* ─────────────────────────────────────────────────────────────── Mods info */
function modsWord(n) {
  return n === 1 ? 'мод' : (n >= 2 && n <= 4) ? 'мода' : 'модов';
}

function renderModsTab(mods) {
  const list  = $('mods-tab-list');
  const count = $('mods-tab-count');
  count.textContent = `${mods.length} ${modsWord(mods.length)}`;

  if (!mods.length) {
    list.innerHTML = '<div class="mods-tab-empty">Модов в сборке нет</div>';
    return;
  }

  list.innerHTML = '';
  mods.forEach(mod => list.appendChild(buildModCard(mod)));
}

function buildModCard(mod) {
  const card = document.createElement('div');
  card.className = 'mod-card';

  card.innerHTML = `
    <div class="mod-card-row">
      <div class="mod-card-icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/>
        </svg>
      </div>
      <div class="mod-card-info">
        <div class="mod-card-name">${mod.name || mod.filename}</div>
        <div class="mod-card-file">${mod.filename}</div>
      </div>
    </div>
    <div class="mod-card-desc hidden">${mod.description || 'Мод сборки.'}</div>
  `;

  const desc = card.querySelector('.mod-card-desc');
  card.querySelector('.mod-card-row').addEventListener('click', () => {
    desc.classList.toggle('hidden');
  });

  return card;
}

async function loadModsInfo() {
  const el = $('mods-info');
  try {
    const mods = await window.api.getModsList();
    state.modsList = mods;
    el.textContent = `${mods.length} ${modsWord(mods.length)} в сборке`;
    renderModsTab(mods);
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
  window.api.onGameExit((data) => {
    const code  = (data && typeof data === 'object') ? data.code  : data;
    const crash = (data && typeof data === 'object') ? data.crash : null;
    state.isGameRunning = false;
    setPlayBtnState('idle');
    appendConsole(`\n[Лаунчер] Игра завершена (код ${code})\n`, 'system');
    if (crash) {
      appendConsole(`[Лаунчер] ${crash}\n`, 'stderr');
      showError(crash);
    }
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
let playButtonBound = false;

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
        `Ошибка синхронизации модов:\n${syncResult.error}`,
        () => startGame()
      );
      return;
    }

    appendConsole('[Лаунчер] Моды синхронизированы ✓\n', 'system');
    loadModsInfo();

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
      javaPath: state.settings.javaPath,
      autoJoinServer: !!state.settings.autoJoinServer,
      fullscreen: !!state.settings.fullscreen,
      distantHorizons: !!state.settings.distantHorizons,
      gpu: state.settings.gpu
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
  $('setting-gpu').value     = s.gpu || 'auto';
  $('setting-nickname').value = state.profile?.username || '';
  $('setting-auto-join').checked = !!s.autoJoinServer;
  $('setting-fullscreen').checked = !!s.fullscreen;
  $('setting-dh').checked = !!s.distantHorizons;
}

function initSettingsUI() {
  // RAM slider — обновляем и UI и state сразу
  $('setting-ram').addEventListener('input', () => {
    const val = parseInt($('setting-ram').value, 10);
    $('ram-value').textContent = `${val} ГБ`;
    state.settings.ram = val;
  });

  $('setting-ram').addEventListener('change', () => {
    state.settings.ram = parseInt($('setting-ram').value, 10);
    window.api.saveSettings(state.settings);
  });

  // Browse folder
  $('btn-browse').addEventListener('click', async () => {
    const folder = await window.api.browseFolder();
    if (folder) {
      $('setting-gamedir').value = folder;
      state.settings.gameDir = folder;
      window.api.saveSettings(state.settings);
    }
  });

  $('btn-skins').addEventListener('click', () => {
    window.open('https://ely.by/skins', '_blank');
  });

  $('btn-skin-local').addEventListener('click', async () => {
    const res = await window.api.setLocalSkin({ gameDir: state.settings.gameDir, username: state.profile?.username });
    if (res?.success) showError('✓ Локальный скин установлен. Будет виден тебе после перезахода в игру.');
    else if (res && !res.canceled) showError('Не удалось установить скин: ' + (res.error || ''));
  });

  $('setting-auto-join').addEventListener('change', () => {
    state.settings.autoJoinServer = $('setting-auto-join').checked;
    window.api.saveSettings(state.settings);
  });

  $('setting-fullscreen').addEventListener('change', () => {
    state.settings.fullscreen = $('setting-fullscreen').checked;
    window.api.saveSettings(state.settings);
  });

  $('setting-dh').addEventListener('change', () => {
    state.settings.distantHorizons = $('setting-dh').checked;
    window.api.saveSettings(state.settings);
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
      ...state.settings,
      ram:     parseInt($('setting-ram').value,    10),
      width:   parseInt($('setting-width').value,  10),
      height:  parseInt($('setting-height').value, 10),
      gameDir: $('setting-gamedir').value.trim() || state.settings.gameDir,
      javaPath: $('setting-java').value.trim() || 'auto',
      autoJoinServer: $('setting-auto-join').checked,
      fullscreen: $('setting-fullscreen').checked,
      distantHorizons: $('setting-dh').checked,
      gpu: $('setting-gpu').value
    };
    await window.api.saveSettings(newSettings);
    state.settings = newSettings;

    const saved = $('settings-saved');
    saved.classList.remove('hidden');
    setTimeout(() => saved.classList.add('hidden'), 2500);
  });

  // Change nickname
  $('btn-change-nick').addEventListener('click', async () => {
    await window.api.logoutAccount();
    await window.api.deleteProfile();
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

/* ─────────────────────────────────────────────────────────────── Profiles modal */
async function openProfilesModal() {
  const modal       = $('profiles-modal');
  const list        = $('profiles-list');
  const newWrap     = $('profiles-new-wrap');
  const newInput    = $('profiles-new-input');
  const newError    = $('profiles-new-error');
  const btnNew      = $('profiles-btn-new');
  const btnCancel   = $('profiles-btn-cancel');
  const btnConfirm  = $('profiles-btn-confirm');

  let selectedNick = null;

  newWrap.classList.add('hidden');
  btnConfirm.style.display = 'none';
  newInput.value = '';
  newError.classList.add('hidden');

  async function renderList() {
    const profiles = await window.api.getProfiles();
    list.innerHTML = '';
    selectedNick = null;
    btnConfirm.style.display = 'none';

    profiles.forEach(nick => {
      const item = document.createElement('div');
      item.className = 'profile-item' + (nick === state.profile?.username ? ' active' : '');
      item.innerHTML = `<span class="profile-item-name">${nick}</span><span class="profile-item-del" title="Удалить">×</span>`;

      item.querySelector('.profile-item-name').addEventListener('click', () => {
        document.querySelectorAll('.profile-item').forEach(el => el.classList.remove('active'));
        item.classList.add('active');
        selectedNick = nick;
        newWrap.classList.add('hidden');
        btnConfirm.style.display = '';
      });

      item.querySelector('.profile-item-del').addEventListener('click', async (e) => {
        e.stopPropagation();
        await window.api.deleteProfileFromHistory(nick);
        renderList();
      });

      list.appendChild(item);
    });
  }

  await renderList();
  modal.classList.remove('hidden');

  btnNew.onclick = () => {
    document.querySelectorAll('.profile-item').forEach(el => el.classList.remove('active'));
    selectedNick = null;
    newWrap.classList.remove('hidden');
    newInput.focus();
    btnConfirm.style.display = '';
  };

  newInput.oninput = () => {
    const err = validateNick(newInput.value.trim());
    if (err) { newError.textContent = err; newError.classList.remove('hidden'); }
    else     { newError.classList.add('hidden'); }
  };

  btnCancel.onclick = () => modal.classList.add('hidden');

  btnConfirm.onclick = async () => {
    let nick = selectedNick;

    if (!nick) {
      nick = newInput.value.trim();
      const err = validateNick(nick);
      if (err) { newError.textContent = err; newError.classList.remove('hidden'); return; }
    }

    modal.classList.add('hidden');
    await window.api.logoutAccount();
    state.profile = null;
    showScreen('login');
    initLoginScreen(nick);
  };
}

/* ─────────────────────────────────────────────────────────────── Title bar */
function initTitleBar() {
  $('login-btn-minimize').addEventListener('click', () => window.api.minimize());
  $('login-btn-close').addEventListener('click',    () => window.api.close());

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

/* ─────────────────────────────────────────────────────────────── Auto-update */
async function checkAndShowUpdate() {
  try {
    const info = await window.api.checkUpdate();
    if (!info.hasUpdate) return;

    const banner  = $('update-banner');
    const text    = $('update-banner-text');
    const btn     = $('btn-update-launcher');
    const progWrap = $('update-progress-wrap');
    const progFill = $('update-progress-fill');
    const progPct  = $('update-progress-pct');

    text.textContent = `Доступно обновление v${info.latestVersion}`;
    text.title = '';
    banner.classList.remove('hidden');

    window.api.removeAllListeners('update-progress');
    window.api.onUpdateProgress((data) => {
      progFill.style.width = `${data.percent}%`;
      progPct.textContent  = `${data.percent}%`;
    });

    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = 'Скачивание...';
      text.title = '';
      progFill.style.width = '0%';
      progPct.textContent  = '0%';
      progWrap.classList.remove('hidden');

      const result = await window.api.downloadUpdate({
        downloadUrl: info.downloadUrl,
        assetApiUrl: info.assetApiUrl,
        assetName:   info.assetName
      });

      if (!result.success) {
        const errorText = result.error || 'не удалось скачать обновление. Попробуйте снова';
        btn.disabled = false;
        btn.textContent = 'Повторить';
        progWrap.classList.add('hidden');
        text.textContent = `Ошибка загрузки: ${errorText}`;
        text.title = result.details || errorText;
        return;
      }

      // Скачано — запускаем установщик и закрываем лаунчер
      progFill.style.width = '100%';
      progPct.textContent  = '100%';
      btn.textContent = 'Установка...';
      text.textContent = 'Запуск установщика...';
      text.title = '';

      setTimeout(() => window.api.installUpdate(result.filePath), 600);
    };
  } catch (_) {
    // Тихо игнорируем — обновление не критично
  }
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
  const installed = await window.api.checkInstallation(state.settings.gameDir, state.settings.javaPath);

  if (!installed.fullyInstalled) {
    const ok = await runInstallation();
    if (!ok) return; // stays on install screen with error
  }

  showScreen('main');
  showTab('home');

  // Проверяем обновления лаунчера (тихо, в фоне)
  checkAndShowUpdate();

  // Load content
  await Promise.all([loadNews(), loadModsInfo()]);
  setInterval(loadNews, 60_000);

  // Server ping
  await pingServer();
  state.serverPingInterval = setInterval(pingServer, 5_000);

  // PLAY button
  if (!playButtonBound) {
    $('btn-play').addEventListener('click', startGame);
    playButtonBound = true;
  }
}

/* ─────────────────────────────────────────────────────────────── Boot */
async function boot() {
  initTitleBar();
  initSidebar();
  initConsole();
  initSettingsUI();

  try {
    const v = await window.api.getVersions();
    $('login-version-tag').textContent  = `v${v.launcher}`;
    $('about-launcher-ver').textContent = v.launcher;
    $('about-mc-ver').textContent       = `${v.mc} — NeoForge ${v.neoforge}`;
    const badge = $('home-version-badge');
    if (badge) badge.textContent = `NeoForge ${v.mc}`;
    STEPS[1].label = `Minecraft ${v.mc}`;
    STEPS[2].label = `NeoForge ${v.neoforge}`;
  } catch (_) {}

  const session = await window.api.restoreSession();
  if (session.success) {
    state.profile = session.profile;
    await enterMain();
    return;
  }

  const profile = await window.api.getProfile();

  showScreen('login');
  initLoginScreen(profile?.username || '');
}

// Инициализация Lucide иконок
if (window.lucide) window.lucide.createIcons();

boot().catch(err => {
  console.error('Boot error:', err);
  showError(`Лаунчер не смог запуститься:\n${err.message}`);
});
