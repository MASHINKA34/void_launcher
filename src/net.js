const fetch = require('node-fetch');
const { Readable } = require('stream');

function getFetchers() {
  const fetchers = [];

  try {
    const electron = require('electron');
    if (electron?.net?.fetch) {
      fetchers.push({ name: 'electron', fn: electron.net.fetch.bind(electron.net) });
    }
  } catch (_) {}

  fetchers.push({ name: 'node', fn: fetch });
  return fetchers;
}

function getFetch() {
  return getFetchers()[0].fn;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 90_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await getFetch()(url, {
      ...options,
      signal: controller.signal
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`TIMEOUT ${Math.round(timeoutMs / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAny(url, options = {}, timeoutMs = 10_000) {
  const attempts = [];

  for (const fetcher of getFetchers()) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetcher.fn(url, { ...options, signal: controller.signal });
      return { res, via: fetcher.name, attempts };
    } catch (err) {
      attempts.push({
        via: fetcher.name,
        error: err?.name === 'AbortError'
          ? `TIMEOUT ${Math.round(timeoutMs / 1000)}s`
          : String(err?.code || err?.message || err)
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  const error = new Error(attempts.map(a => `${a.via}: ${a.error}`).join(' | ') || 'no fetch backend');
  error.attempts = attempts;
  throw error;
}

function toNodeReadable(body) {
  if (body?.pipe) return body;
  if (body?.getReader && Readable.fromWeb) return Readable.fromWeb(body);
  throw new Error('EMPTY_RESPONSE_BODY');
}

function normalizeNetworkError(err) {
  const message = String(err?.message || err || '');

  if (/TIMEOUT|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up/i.test(message)) {
    return 'нет стабильного соединения с сервером загрузки. Проверьте интернет, VPN/прокси или фаервол и попробуйте снова';
  }

  if (/ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED/i.test(message)) {
    return 'сервер загрузки не найден. Проверьте DNS или подключение к интернету';
  }

  if (/HTTP 404/i.test(message)) {
    return 'файл не найден на сервере загрузки';
  }

  if (/HTTP 403|HTTP 429/i.test(message)) {
    return 'сервер временно ограничил загрузку. Попробуйте позже';
  }

  if (/INCOMPLETE_DOWNLOAD|EMPTY_RESPONSE_BODY|SIZE_MISMATCH|Hash verification failed/i.test(message)) {
    return 'файл скачался не полностью. Попробуйте снова';
  }

  return 'не удалось скачать файл. Попробуйте снова';
}

module.exports = { fetchWithTimeout, fetchAny, toNodeReadable, normalizeNetworkError };
