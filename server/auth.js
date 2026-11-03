'use strict';
const crypto = require('node:crypto');
const config = require('./config');
const users = require('./users');
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

// Sessietoken: "<verloop>.<methode>.<gebruiker>.<epoch>.<handtekening>"; methode is "pk" (passkey) of "pw" (wachtwoord).
// De epoch van de gebruiker staat erin: een nieuw wachtwoord, MFA aan/uit of een reset verhoogt hem en meldt zo alle
// sessies van die gebruiker af. Oudere tokens ("<verloop>.<methode>.<handtekening>" en "<verloop>.<handtekening>") zijn
// van vóór de gebruikers en gelden als sessie van de eigenaar met epoch 0 (zonder methode: passkey).
function readToken(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const parts = token.split('.');
  let exp, method = 'pk', uid = users.OWNER_ID, epoch = '0', sig;
  if (parts.length === 5) [exp, method, uid, epoch, sig] = parts;
  else if (parts.length === 3) [exp, method, sig] = parts;
  else if (parts.length === 2) [exp, sig] = parts;
  else return null;
  if (!exp || !sig || !uid || !['pk', 'pw'].includes(method) || !/^\d+$/.test(epoch)) return null;
  if (!safeEqual(sig, sign(parts.slice(0, -1).join('.')))) return null;
  return Number(exp) > Date.now() ? { method, uid, epoch: Number(epoch) } : null;
}

// De ingelogde gebruiker en hoe die is ingelogd, of null. Een verwijderde gebruiker of een oude epoch is niet ingelogd.
function session(req) {
  const t = readToken(req);
  if (!t) return null;
  const user = users.byId(t.uid);
  if (!user || (user.epoch || 0) !== t.epoch) return null;
  return { user, method: t.method };
}

const sessionMethod = (req) => session(req)?.method || null;
const isLoggedIn = (req) => session(req) !== null;

// Een sterke sessie mag de eigen inlog wijzigen: met een passkey gestart, of met een wachtwoord door iemand zonder passkey
// (dan is het wachtwoord de sterkste inlog die er is). Wie ook een passkey heeft, logt daarvoor met de passkey in.
const strong = (s) => !!s && (s.method === 'pk' || !users.hasPasskeys(s.user.id));

function startSession(req, res, method, user) {
  const exp = String(Date.now() + config.sessionHours * 3600 * 1000);
  const payload = `${exp}.${method}.${user.id}.${user.epoch || 0}`;
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${config.sessionHours * 3600}`];
  if (origin.secureCookie(req)) flags.push('Secure');
  res.append('Set-Cookie', `${COOKIE}=${payload}.${sign(payload)}; ${flags.join('; ')}`);
}

function endSession(res) {
  res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

function requireAdmin(req, res, next) {
  const s = session(req);
  if (!s) return res.status(401).json({ error: 'Niet ingelogd' });
  req.user = s.user;
  req.authMethod = s.method;
  next();
}

// Passkeys, wachtwoord en MFA wijzigen vraagt een sterke sessie (zie strong()).
function requireStrongSession(req, res, next) {
  const s = session(req);
  if (!s) return res.status(401).json({ error: 'Niet ingelogd' });
  if (!strong(s)) return res.status(403).json({ error: 'Log in met een passkey om dit te wijzigen' });
  req.user = s.user;
  req.authMethod = s.method;
  next();
}

// Gebruikersbeheer is alleen voor de eigenaar; de server dwingt dat af, het verbergen van de tab is alleen gemak.
function requireOwner(req, res, next) {
  if (req.user?.id !== users.OWNER_ID) return res.status(403).json({ error: 'Alleen de eigenaar kan gebruikers beheren' });
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

module.exports = { parseCookies, session, sessionMethod, strong, requireStrongSession, requireOwner, isLoggedIn, startSession, endSession, requireAdmin, sameOrigin, safeEqual, limiter };
