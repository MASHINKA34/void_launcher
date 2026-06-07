/**
 * updater.js
 * Checks GitHub Releases for a newer version and downloads/installs it.
 */

const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const fetch  = require('node-fetch');
const config = require('../config');

let progressCallback = null;
function setProgressCallback(cb) { progressCallback = cb; }
function emit(data) { if (progressCallback) progressCallback(data); }

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
    const res = await fetch(
      `https://api.github.com/repos/${config.GITHUB_OWNER}/${config.GITHUB_REPO}/releases`,
      { headers: { 'User-Agent': config.LAUNCHER_NAME } }
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
        assetName:    asset.name,
        releaseNotes: release.body || ''
      };
    }

    return { hasUpdate: false };
  } catch (_) {
    return { hasUpdate: false };
  }
}

async function downloadUpdate(downloadUrl, assetName) {
  const dest = path.join(os.tmpdir(), assetName);

  try {
    const res = await fetch(downloadUrl, {
      headers: { 'User-Agent': config.LAUNCHER_NAME }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const total    = parseInt(res.headers.get('content-length') || '0', 10);
    let downloaded = 0;
    const out      = fs.createWriteStream(dest);

    await new Promise((resolve, reject) => {
      res.body.on('data', chunk => {
        downloaded += chunk.length;
        out.write(chunk);
        emit({
          type:       'progress',
          downloaded,
          total,
          percent:    total ? Math.round(downloaded / total * 100) : 0
        });
      });
      res.body.on('end',   () => { out.end(); resolve(); });
      res.body.on('error', reject);
      out.on('error',      reject);
    });

    return { success: true, filePath: dest };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function installUpdate(filePath) {
  const { spawn } = require('child_process');
  spawn(filePath, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
}

module.exports = { checkForUpdates, downloadUpdate, installUpdate, setProgressCallback };
