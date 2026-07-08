/**
 * updater.js
 * Checks GitHub Releases for a newer version and downloads/installs it.
 */

const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const config = require('../config');
const { fetchWithTimeout, toNodeReadable, normalizeNetworkError } = require('./net');

let progressCallback = null;
function setProgressCallback(cb) { progressCallback = cb; }
function emit(data) { if (progressCallback) progressCallback(data); }

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function removeFileIfExists(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (_) {}
}

async function writeResponseToFile(res, dest, total) {
  let downloaded = 0;
  const started = Date.now();

  await pipeline(
    toNodeReadable(res.body),
    new Transform({
      transform(chunk, _encoding, callback) {
        downloaded += chunk.length;
        const elapsed = (Date.now() - started) / 1000 || 0.001;

        emit({
          type:       'progress',
          downloaded,
          total,
          percent:    total ? Math.round(downloaded / total * 100) : 0,
          speed:      Math.round(downloaded / elapsed)
        });

        callback(null, chunk);
      }
    }),
    fs.createWriteStream(dest)
  );

  if (total > 0 && downloaded !== total) {
    throw new Error(`INCOMPLETE_DOWNLOAD ${downloaded}/${total}`);
  }
}

function normalizeDownloadError(err) {
  const message = String(err?.message || err || '');

  if (/HTTP 404/i.test(message)) {
    return 'файл обновления не найден в релизе';
  }

  return `не удалось скачать обновление: ${normalizeNetworkError(err)}`;
}

function buildDownloadSources(opts) {
  const sources = [];

  if (opts.downloadUrl) {
    sources.push({
      url: opts.downloadUrl,
      headers: { 'User-Agent': config.LAUNCHER_NAME }
    });
  }

  if (opts.assetApiUrl) {
    sources.push({
      url: opts.assetApiUrl,
      headers: {
        'User-Agent': config.LAUNCHER_NAME,
        Accept: 'application/octet-stream'
      }
    });
  }

  if (Array.isArray(config.UPDATE_MIRRORS)) {
    for (const mirror of config.UPDATE_MIRRORS) {
      if (!mirror || !opts.assetName) continue;
      const encodedName = encodeURIComponent(opts.assetName);
      const url = mirror.includes('{assetName}')
        ? mirror.replaceAll('{assetName}', encodedName)
        : `${mirror.replace(/\/$/, '')}/${encodedName}`;

      sources.push({
        url,
        headers: { 'User-Agent': config.LAUNCHER_NAME }
      });
    }
  }

  const seen = new Set();
  return sources.filter(source => {
    if (seen.has(source.url)) return false;
    seen.add(source.url);
    return true;
  });
}

// Returns 1 if a > b, -1 if a < b, 0 if equal (ignores leading 'v')
function compareVersions(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return  1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

async function checkForUpdates(currentVersion) {
  if (!config.GITHUB_OWNER || !config.GITHUB_REPO ||
      config.GITHUB_OWNER === 'YOUR_GITHUB_OWNER') {
    return { hasUpdate: false };
  }

  try {
    const res = await fetchWithTimeout(
      `https://api.github.com/repos/${config.GITHUB_OWNER}/${config.GITHUB_REPO}/releases`,
      { headers: { 'User-Agent': config.LAUNCHER_NAME } },
      15_000
    );
    if (!res.ok) return { hasUpdate: false };

    const releases = await res.json();
    const release = releases
      .filter(r => /^v\d+\.\d+\.\d+$/.test(r.tag_name || ''))
      .find(r => r.assets.some(a => a.name.toLowerCase().endsWith('.exe')));

    if (!release) return { hasUpdate: false };

    const latest  = release.tag_name.replace(/^v/, '');

    if (compareVersions(latest, currentVersion) > 0) {
      const asset = release.assets.find(a => a.name.toLowerCase().endsWith('.exe'));
      if (!asset) return { hasUpdate: false };

      return {
        hasUpdate:    true,
        currentVersion,
        latestVersion: latest,
        downloadUrl:  asset.browser_download_url,
        assetApiUrl:  asset.url,
        assetName:    asset.name,
        releaseNotes: release.body || ''
      };
    }

    return { hasUpdate: false };
  } catch (_) {
    return { hasUpdate: false };
  }
}

async function downloadUpdate(options, legacyAssetName) {
  const opts = typeof options === 'string'
    ? { downloadUrl: options, assetName: legacyAssetName }
    : options || {};

  const assetName = opts.assetName ? path.basename(opts.assetName) : '';

  if (!assetName || assetName === '.' || assetName === '..') {
    return { success: false, error: 'не найден файл обновления' };
  }

  const dest = path.join(os.tmpdir(), assetName);
  const part = `${dest}.part`;
  const sources = buildDownloadSources({ ...opts, assetName });
  let lastError = null;

  if (sources.length === 0) {
    return { success: false, error: 'не найден файл обновления' };
  }

  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      removeFileIfExists(part);

      try {
        const res = await fetchWithTimeout(sources[sourceIndex].url, {
          headers: sources[sourceIndex].headers,
          redirect: 'follow'
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const total = parseInt(res.headers.get('content-length') || '0', 10);
        await writeResponseToFile(res, part, total);

        removeFileIfExists(dest);
        fs.renameSync(part, dest);
        return { success: true, filePath: dest };
      } catch (err) {
        lastError = err;
        removeFileIfExists(part);

        if (attempt < 3) {
          await sleep(1_000 * attempt);
        }
      }
    }
  }

  return {
    success: false,
    error: normalizeDownloadError(lastError),
    details: String(lastError?.message || lastError || '')
  };
}

function installUpdate(filePath) {
  const { spawn } = require('child_process');
  spawn(filePath, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
}

module.exports = { checkForUpdates, downloadUpdate, installUpdate, setProgressCallback };
