'use strict';
const crypto = require('node:crypto');
const path = require('node:path');

// ORIGIN en RP_ID zijn optioneel. Leeg betekent: het adres waarop de app wordt geopend (zie origin.js).
const origin = (process.env.ORIGIN || '').trim().replace(/\/+$/, '') || null;
let rpID = (process.env.RP_ID || '').trim().toLowerCase() || null;
if (!rpID && origin) {
  try { rpID = new URL(origin).hostname; } catch { rpID = null; }
}

function secret(name, bytes) {
  const v = process.env[name];
  if (v && v.length >= 16) return { value: v, generated: false };
  return { value: crypto.randomBytes(bytes).toString('hex'), generated: true };
}

const sessionSecret = secret('SESSION_SECRET', 32);
const setupToken = secret('SETUP_TOKEN', 12);

module.exports = {
  port: Number(process.env.PORT) || 9888,
  origin,
  rpID,
  siteTitle: process.env.SITE_TITLE || 'Onze wijk',
  dataDir: path.resolve(process.env.DATA_DIR || './data'),
  sessionSecret: sessionSecret.value,
  sessionSecretGenerated: sessionSecret.generated,
  setupToken: setupToken.value,
  setupTokenGenerated: setupToken.generated,
  sessionHours: Number(process.env.SESSION_HOURS) || 12,
};
