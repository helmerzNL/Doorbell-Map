'use strict';
const crypto = require('node:crypto');
const config = require('./config');
const store = require('./store');
const origin = require('./origin');

const COOKIE = 'sm_session';

const sign = (payload) =>
  crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Sessietoken: "<verloop>.<methode>.<handtekening>"; methode is "pk" (passkey) of "pw" (wachtwoord).
// Oudere tokens zonder methode ("<verloop>.<handtekening>") gelden als passkey-sessie.
function sessionMethod(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const parts = token.split('.');
  let exp, method, sig;
  if (parts.length === 3) [exp, method, sig] = parts;
  else if (parts.length === 2) { [exp, sig] = parts; method = 'pk'; }
  else return null;
  if (!exp || !sig || !['pk', 'pw'].includes(method)) return null;
  const payload = parts.length === 3 ? `${exp}.${method}` : exp;
  if (!safeEqual(sig, sign(payload))) return null;
  return Number(exp) > Date.now() ? method : null;
}

const isLoggedIn = (req) => sessionMethod(req) !== null;

function startSession(req, res, method = 'pk') {
  const exp = String(Date.now() + config.sessionHours * 3600 * 1000);
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${config.sessionHours * 3600}`];
  if (origin.secureCookie(req)) flags.push('Secure');
  res.append('Set-Cookie', `${COOKIE}=${exp}.${method}.${sign(`${exp}.${method}`)}; ${flags.join('; ')}`);
}

function endSession(res) {
  res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

function requireAdmin(req, res, next) {
  if (!isLoggedIn(req)) return res.status(401).json({ error: 'Niet ingelogd' });
  next();
}

// Gevoelige acties (passkeys en wachtwoord beheren) vragen een sessie die met een passkey is gestart. Zonder passkeys is het
// wachtwoord de enige manier van inloggen (bijvoorbeeld op een adres zonder https) en telt een wachtwoordsessie dus ook.
const hasPasskeys = () => store.db().passkeys.length > 0;
function fullSession(req) {
  const m = sessionMethod(req);
  return m === 'pk' || (m === 'pw' && !hasPasskeys());
}

function requireFullSession(req, res, next) {
  if (!sessionMethod(req)) return res.status(401).json({ error: 'Niet ingelogd' });
  if (!fullSession(req)) return res.status(403).json({ error: 'Log in met een passkey om dit te wijzigen' });
  next();
}

// Mutaties moeten van onze eigen origin komen (extra CSRF-bescherming bovenop SameSite=Strict).
function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const o = req.headers.origin;
  if (o && !origin.isOwnOrigin(req, o)) return res.status(403).json({ error: 'Ongeldige origin' });
  next();
}

// Eenvoudige in-memory limiter voor mislukte pogingen per IP.
const fails = new Map();
const WINDOW = 15 * 60 * 1000;
const MAX_FAILS = 10;
const limiter = {
  blocked(ip, max = MAX_FAILS) {
    const f = (fails.get(ip) || []).filter((t) => Date.now() - t < WINDOW);
    fails.set(ip, f);
    return f.length >= max;
  },
  fail(ip) { fails.set(ip, [...(fails.get(ip) || []), Date.now()]); },
  reset(ip) { fails.delete(ip); },
};

module.exports = { parseCookies, sessionMethod, fullSession, hasPasskeys, requireFullSession, isLoggedIn, startSession, endSession, requireAdmin, sameOrigin, safeEqual, limiter };
