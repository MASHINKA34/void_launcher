/**
 * Local launcher account store.
 *
 * This protects the launcher flow from casual nickname spoofing. A Minecraft
 * offline-mode server still needs server-side auth/online-mode for real trust.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const NICK_RE = /^[a-zA-Z0-9_]{3,16}$/;
const PASSWORD_MIN = 4;
const PASSWORD_MAX = 128;
const HASH_BYTES = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };

function getStorePath(userDataDir) {
  return path.join(userDataDir, 'accounts.json');
}

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

function validateUsername(username) {
  const nick = String(username || '').trim();
  if (!nick) return 'Никнейм обязателен.';
  if (nick.length < 3) return 'Минимум 3 символа.';
  if (nick.length > 16) return 'Максимум 16 символов.';
  if (!NICK_RE.test(nick)) return 'Только латинские буквы, цифры и _.';
  return null;
}

function validatePassword(password) {
  const pass = String(password || '');
  if (!pass) return 'Пароль обязателен.';
  if (pass.length < PASSWORD_MIN) return `Пароль должен быть минимум ${PASSWORD_MIN} символа.`;
  if (pass.length > PASSWORD_MAX) return `Пароль должен быть не длиннее ${PASSWORD_MAX} символов.`;
  return null;
}

function readStore(userDataDir) {
  const storePath = getStorePath(userDataDir);
  try {
    if (!fs.existsSync(storePath)) return { version: 1, accounts: {} };

    const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return { version: 1, accounts: {} };
    if (!parsed.accounts || typeof parsed.accounts !== 'object') parsed.accounts = {};
    return parsed;
  } catch (_) {
    return { version: 1, accounts: {} };
  }
}

function writeStore(userDataDir, store) {
  fs.writeFileSync(getStorePath(userDataDir), JSON.stringify(store, null, 2), 'utf8');
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, HASH_BYTES, SCRYPT_OPTIONS).toString('hex');
}

function verifyPassword(password, account) {
  if (!account?.salt || !account?.passwordHash) return false;

  const expected = Buffer.from(account.passwordHash, 'hex');
  const actual = Buffer.from(hashPassword(password, account.salt), 'hex');
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

function register(userDataDir, username, password) {
  const cleanUsername = String(username || '').trim();
  const usernameError = validateUsername(cleanUsername);
  if (usernameError) return { success: false, error: usernameError };

  const passwordError = validatePassword(password);
  if (passwordError) return { success: false, error: passwordError };

  const key = normalizeUsername(cleanUsername);
  const store = readStore(userDataDir);

  if (store.accounts[key]) {
    return {
      success: false,
      error: 'Этот ник уже зарегистрирован. Введите пароль от него или выберите другой ник.'
    };
  }

  const now = new Date().toISOString();
  const salt = crypto.randomBytes(16).toString('hex');
  store.accounts[key] = {
    username: cleanUsername,
    salt,
    passwordHash: hashPassword(password, salt),
    createdAt: now,
    lastLoginAt: now
  };

  writeStore(userDataDir, store);
  return { success: true, profile: { username: cleanUsername } };
}

function login(userDataDir, username, password) {
  const cleanUsername = String(username || '').trim();
  const usernameError = validateUsername(cleanUsername);
  if (usernameError) return { success: false, error: usernameError };

  const passwordError = validatePassword(password);
  if (passwordError) return { success: false, error: passwordError };

  const key = normalizeUsername(cleanUsername);
  const store = readStore(userDataDir);
  const account = store.accounts[key];

  if (!account) {
    return { success: false, error: 'Аккаунт с таким ником не найден. Нажмите «Создать аккаунт».' };
  }

  if (!verifyPassword(password, account)) {
    return { success: false, error: 'Неверный пароль для этого никнейма.' };
  }

  account.lastLoginAt = new Date().toISOString();
  writeStore(userDataDir, store);

  return { success: true, profile: { username: account.username || cleanUsername } };
}

function hasAccount(userDataDir, username) {
  const key = normalizeUsername(username);
  if (!key) return false;
  const store = readStore(userDataDir);
  return !!store.accounts[key];
}

module.exports = {
  login,
  register,
  validateUsername,
  validatePassword,
  normalizeUsername,
  hasAccount
};
