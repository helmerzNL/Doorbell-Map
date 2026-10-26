'use strict';
const { execFileSync } = require('node:child_process');

// In de Docker-image zetten de build-args APP_VERSION en GIT_SHA deze waarden; lokaal vallen we terug op git.
function gitSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'], cwd: __dirname }).toString().trim();
  } catch {
    return '';
  }
}

const version = (process.env.APP_VERSION || 'dev').trim();
const sha = (process.env.GIT_SHA && process.env.GIT_SHA !== 'onbekend' ? process.env.GIT_SHA : gitSha()).trim();

// Kanaal: "beta" voor een beta-build (SINTMAARTEN_TAG bevat "beta", of het image is op de beta-branch gebouwd), anders "stable".
const channel = /beta/i.test(process.env.SINTMAARTEN_TAG || '') || /beta/i.test(version) ? 'beta' : 'stable';

module.exports = {
  version,
  channel,
  beta: channel === 'beta',
  build: sha ? sha.slice(0, 7) : 'onbekend',
  buildFull: sha || 'onbekend',
  // "v0.1.3 (abc1234)"
  label: `${/^\d/.test(version) ? 'v' : ''}${version} (${sha ? sha.slice(0, 7) : 'onbekend'})`,
};
