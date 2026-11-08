'use strict';
// Inloggen en accounts van het beheer: de installatie-wizard, passkeys, gebruikersnaam + wachtwoord, tweestapsverificatie
// (TOTP met herstelcodes), bevestigen van gevoelige acties en uitnodigingen voor meer gebruikers.
// Volgt App-Guidance: shared/framework/technical-framework/auth-passkeys-password-mfa.md, onboarding-wizard.md en
// shared/guidelines/user-management.md. Passkeys via @simplewebauthn/server, TOTP via otpauth (zie users.js).
const crypto = require('node:crypto');
const net = require('node:net');
const express = require('express');
const {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const config = require('./config');
const store = require('./store');
const auth = require('./auth');
const origin = require('./origin');
const users = require('./users');
const lang = require('./lang');
const { hashPassword, verifyPassword } = require('./password');

const siteTitle = () => lang.text('siteTitle') || config.siteTitle;
// De naam van een passkey in de wachtwoordbeheerder: de eigen naam uit het beheer (Config → App), anders de naam van de
// app, anders de sitenaam. Het domein dat er ook bij staat, kan een site niet veranderen. iCloud-sleutelhanger, Google
// Wachtwoordmanager en de meeste andere tonen naast het domein de accountnaam en niet de naam van de site (rp.name);
// daarom staat de naam ook in de accountnaam: "Sint Maarten Hoogland (beheerder)". Inloggen gebruikt die naam niet.
const passkeyLabel = () => store.db().settings?.passkeyName || lang.text('appName') || siteTitle();
const passkeyAccount = (username) => `${passkeyLabel()} (${username})`;
// Voor de WebAuthn Signal API in de browser: zo krijgt ook een bestaande passkey van deze gebruiker de huidige naam.
const passkeyDetails = (req, user) => {
  if (!user || !store.db().passkeys.some((p) => p.userId === user.id)) return null;
  const name = passkeyAccount(user.username);
  return { rpId: origin.rpID(req), userId: user.webauthnId, name, displayName: name };
};
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const asyncRoute = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    if (!err.status) console.error(err);
    res.status(err.status || 400).json({ error: err.message || 'Er ging iets mis' });
  });
const TOO_MANY = 'Te veel pogingen, probeer later opnieuw';

// ---------- uitdagingen (in het geheugen, kort geldig) ----------
// Begrensd: wie /login/options blijft aanroepen kan het geheugen niet laten vollopen (de oudste vallen eruit).
const challenges = new Map();
const MAX_CHALLENGES = 5000;
function putChallenge(data, ttl = 5 * 60 * 1000) {
  const now = Date.now();
  for (const [k, v] of challenges) if (v.exp < now) challenges.delete(k);
  while (challenges.size >= MAX_CHALLENGES) challenges.delete(challenges.keys().next().value);
  const id = crypto.randomBytes(16).toString('base64url');
  challenges.set(id, { ...data, exp: now + ttl });
  return id;
}
function peekChallenge(id) {
  const c = typeof id === 'string' ? challenges.get(id) : null;
  if (!c) return null;
  if (c.exp < Date.now()) { challenges.delete(id); return null; }
  return c;
}
function takeChallenge(id) {
  const c = peekChallenge(id);
  if (c) challenges.delete(id);
  return c;
}

// ---------- kan een passkey hier werken? ----------
// Een passkey heeft een echte domeinnaam en HTTPS nodig (localhost is de uitzondering voor ontwikkelen). De reden is
// deel van het contract: de wizard toont hem letterlijk, zodat de beheerder weet wat er aan ORIGIN moet veranderen.
const LOCAL_SUFFIXES = ['.local', '.lan', '.home', '.home.arpa', '.internal', '.localdomain', '.intranet', '.private'];
function passkeySupport(pageOrigin, rpID) {
  const host = String(rpID || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const localhost = host === 'localhost' || host.endsWith('.localhost');
  const no = (reason) => ({ available: false, reason });
  if (net.isIP(host)) return no('Je opent de app via een IP-adres; een passkey heeft een echte domeinnaam nodig.');
  if (!localhost && !host.includes('.')) return no('Het adres van de app heeft geen domeinnaam (zoals "nas"); een passkey heeft een echte domeinnaam nodig.');
  if (LOCAL_SUFFIXES.some((s) => host.endsWith(s))) return no('Het adres van de app bestaat alleen op je eigen netwerk (zoals .local of .lan); een passkey heeft een echte domeinnaam nodig.');
  if (!String(pageOrigin).startsWith('https://') && !localhost) return no('De app draait niet via HTTPS; een passkey werkt alleen via HTTPS.');
  return { available: true, reason: '' };
}
// Voor deze aanvraag: met ORIGIN het vaste adres, anders het adres waarop de app is geopend (zie origin.js).
const passkeySupportFor = (req) => passkeySupport(origin.pageOrigin(req), origin.rpID(req));
// Een passkey-uitdaging onthoudt het adres en domein waarop ze is uitgegeven; het antwoord wordt daartegen gecontroleerd.
const ceremony = (req) => ({ origin: origin.pageOrigin(req), rpID: origin.rpID(req) });

// ---------- installatiecode ----------
function checkSetupToken(req) {
  if (auth.limiter.blocked(req.ip)) throw fail(TOO_MANY, 429);
  if (!auth.safeEqual(req.body.setupToken || '', config.setupToken)) {
    auth.limiter.fail(req.ip);
    throw fail('Onjuiste installatiecode', 403);
  }
}

// ---------- passkey-controle ----------
// Controleert een passkey-antwoord op een eerder uitgegeven uitdaging ("login" of "confirm"). Bij "confirm" moet de
// passkey van de ingelogde gebruiker zijn. Geeft de gebruikte passkey terug.
async function verifyAssertion(req, kind, user = null) {
  const c = takeChallenge(req.body.challengeId);
  if (!c || c.kind !== kind || (user && c.userId !== user.id)) throw fail('Sessie verlopen, begin opnieuw');
  const pk = store.db().passkeys.find((p) => p.id === req.body.response?.id && (!user || p.userId === user.id));
  if (!pk) throw fail('Onbekende passkey');
  const v = await verifyAuthenticationResponse({
    response: req.body.response,
    expectedChallenge: c.challenge,
    expectedOrigin: c.origin,
    expectedRPID: c.rpID,
    requireUserVerification: true,
    credential: { id: pk.id, publicKey: Buffer.from(pk.publicKey, 'base64url'), counter: pk.counter, transports: pk.transports },
  });
  if (!v.verified) throw fail('Passkey kon niet worden geverifieerd');
  pk.counter = v.authenticationInfo.newCounter;
  pk.lastUsed = new Date().toISOString();
  store.save();
  return pk;
}

// Na een await kan er intussen iets veranderd zijn (een reset, een ander apparaat dat het wachtwoord wijzigde, de
// gebruiker verwijderd). Een wijziging aan de inlog gaat alleen door als deze sessie dan nog steeds geldig is.
function assertCurrent(req) {
  const s = auth.session(req);
  if (!s || s.user !== req.user) throw fail('Sessie verlopen, log opnieuw in', 401);
}

// Gevoelige acties (wachtwoord, MFA, backups/edities verwijderen) bevestig je opnieuw: met een eigen passkey als je die
// hebt, anders met je wachtwoord (en de MFA-code als die aan staat). Het bewijs zit in de body:
// { challengeId, response } voor een passkey, { confirm: { password, code } } voor het wachtwoord.
async function confirm(req) {
  const u = req.user;
  if (users.hasPasskeys(u.id)) {
    await verifyAssertion(req, 'confirm', u);
    return assertCurrent(req);
  }
  if (auth.limiter.blocked(req.ip)) throw fail(TOO_MANY, 429);
  const c = req.body.confirm && typeof req.body.confirm === 'object' ? req.body.confirm : {};
  const pwOk = !!u.password && await verifyPassword(typeof c.password === 'string' ? c.password.slice(0, 200) : '', u.password);
  if (!pwOk || (u.mfa && !users.verifyMfa(u, c.code))) {
    auth.limiter.fail(req.ip);
    throw fail(u.mfa ? 'Onjuist wachtwoord of onjuiste code' : 'Onjuist wachtwoord');
  }
  return assertCurrent(req);
}

const pkOptions = (list) => list.map((p) => ({ id: p.id, transports: p.transports }));

// ======================================================================================================
// Publiek: /api/auth
// ======================================================================================================
const pub = express.Router();

pub.get('/status', (req, res) => {
  const s = auth.session(req);
  const db = store.db();
  res.json({
    configured: users.configured(),
    loggedIn: !!s,
    method: s?.method || null,
    passwordEnabled: db.users.some((u) => u.password), // het wachtwoordformulier tonen op het inlogscherm
    passkeysEnabled: db.passkeys.length > 0,
    passkey: passkeySupportFor(req),
    user: s ? { ...users.summary(s.user), strong: auth.strong(s) } : null,
    passkeyDetails: s ? passkeyDetails(req, s.user) : null,
  });
});

// Een passkey registreren, in drie situaties:
// - de eerste installatie (installatiecode, maakt de eigenaar),
// - een uitnodiging (invite: de link is het bewijs; maakt een gebruiker of vervangt bij een reset de oude inlog),
// - een extra passkey voor jezelf (sterke sessie).
pub.post('/register/options', asyncRoute(async (req, res) => {
  const s = auth.session(req);
  const name = String(req.body.name || 'Passkey').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Passkey';
  let c, userName, webauthnId, exclude = [];
  if (req.body.invite !== undefined) {
    const i = users.findInvite(req.body.invite);
    if (!i) throw fail(users.INVALID_INVITE, 404);
    userName = users.inviteName(i, req.body.username); // een bezette naam wordt geweigerd vóórdat er een passkey is
    webauthnId = i.kind === 'reset' ? users.byId(i.userId).webauthnId : crypto.randomBytes(32).toString('base64url');
    c = { mode: 'invite', inviteId: i.id };
  } else if (s) {
    if (!auth.strong(s)) throw fail('Log in met een passkey om dit te wijzigen', 403);
    // Vanuit een wachtwoordsessie zou een gestolen sessie anders een eigen passkey kunnen toevoegen: een blijvende
    // inlog zonder wachtwoord en MFA. Daarom eerst bevestigen met het wachtwoord (en de MFA-code).
    if (s.method === 'pw') { req.user = s.user; await confirm(req); }
    userName = s.user.username;
    webauthnId = s.user.webauthnId;
    exclude = users.passkeysOf(s.user.id);
    c = { mode: 'add', userId: s.user.id };
  } else {
    if (users.configured()) throw fail('Niet ingelogd', 401);
    checkSetupToken(req);
    userName = users.cleanUsername(req.body.username || users.DEFAULT_USERNAME);
    webauthnId = crypto.randomBytes(32).toString('base64url');
    c = { mode: 'setup' };
  }
  const at = ceremony(req);
  const options = await generateRegistrationOptions({
    rpName: passkeyLabel(),
    rpID: at.rpID,
    userName: passkeyAccount(userName), // alleen wat de wachtwoordbeheerder toont; de gebruikersnaam zelf blijft userName
    userDisplayName: passkeyAccount(userName),
    userID: Buffer.from(webauthnId, 'base64url'),
    attestationType: 'none',
    excludeCredentials: pkOptions(exclude),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
  const challengeId = putChallenge({ ...c, ...at, kind: 'register', challenge: options.challenge, name, username: userName, webauthnId });
  res.json({ challengeId, options });
}));

pub.post('/register/verify', asyncRoute(async (req, res) => {
  const c = takeChallenge(req.body.challengeId);
  if (!c || c.kind !== 'register') throw fail('Sessie verlopen, begin opnieuw');
  const db = store.db();
  // Vooraf controleren wat kan, zodat er geen passkey wordt geverifieerd voor een actie die toch niet mag.
  if (c.mode === 'setup' && users.configured()) throw fail('Het beheer is al ingesteld', 403);
  const sessionOk = () => { const s = auth.session(req); return !!s && s.user.id === c.userId && auth.strong(s); };
  if (c.mode === 'add' && !sessionOk()) throw fail('Niet ingelogd met een passkey', 401);
  const v = await verifyRegistrationResponse({
    response: req.body.response,
    expectedChallenge: c.challenge,
    expectedOrigin: c.origin,
    expectedRPID: c.rpID,
  });
  if (!v.verified) throw fail('Passkey kon niet worden geverifieerd');
  if (c.mode === 'add' && !sessionOk()) throw fail('Sessie verlopen, log opnieuw in', 401); // intussen gereset of afgemeld
  // Vanaf hier synchroon: niets kan er meer tussen komen.
  const { credential } = v.registrationInfo;
  if (db.passkeys.some((p) => p.id === credential.id)) throw fail('Deze passkey is al geregistreerd', 409);
  let user;
  if (c.mode === 'setup') user = users.setupOwner(c.username, c.webauthnId);
  else if (c.mode === 'invite') user = users.acceptInvite(c.inviteId, c.username, c.webauthnId);
  else user = users.byId(c.userId);
  if (!user) throw fail('Niet ingelogd', 401);
  db.passkeys.push({
    id: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter,
    transports: credential.transports || [],
    name: c.name,
    createdAt: new Date().toISOString(),
    userId: user.id,
  });
  store.save();
  auth.limiter.reset(req.ip);
  if (c.mode !== 'add') auth.startSession(req, res, 'pk', user);
  res.json({ ok: true });
}));

// De eerste installatie met gebruikersnaam en wachtwoord (in plaats van een passkey).
pub.post('/setup/password', asyncRoute(async (req, res) => {
  if (users.configured()) throw fail('Het beheer is al ingesteld', 403);
  checkSetupToken(req);
  const username = users.cleanUsername(req.body.username || users.DEFAULT_USERNAME);
  users.checkPassword(req.body.password, username);
  const hash = await hashPassword(req.body.password);
  const owner = users.setupOwner(username); // gooit als iemand anders intussen klaar was
  owner.password = hash;
  store.save();
  auth.limiter.reset(req.ip);
  auth.startSession(req, res, 'pw', owner);
  res.json({ ok: true });
}));

pub.post('/login/options', asyncRoute(async (req, res) => {
  const db = store.db();
  if (!db.passkeys.length) throw fail('Nog geen passkey ingesteld', 409);
  if (auth.limiter.blocked(req.ip)) throw fail(TOO_MANY, 429);
  // Alle passkeys van alle gebruikers: de gekozen passkey bepaalt wie er inlogt (geen gebruikersnaam nodig).
  const at = ceremony(req);
  const options = await generateAuthenticationOptions({ rpID: at.rpID, userVerification: 'preferred', allowCredentials: pkOptions(db.passkeys) });
  res.json({ challengeId: putChallenge({ ...at, challenge: options.challenge, kind: 'login' }), options });
}));

pub.post('/login/verify', asyncRoute(async (req, res) => {
  if (auth.limiter.blocked(req.ip)) throw fail(TOO_MANY, 429);
  let pk;
  try {
    pk = await verifyAssertion(req, 'login');
  } catch (err) {
    auth.limiter.fail(req.ip);
    throw err;
  }
  const user = users.byId(pk.userId);
  if (!user) throw fail('Onbekende passkey');
  auth.limiter.reset(req.ip);
  auth.startSession(req, res, 'pk', user);
  res.json({ ok: true });
}));

// Inloggen met gebruikersnaam en wachtwoord. Met MFA in twee stappen: eerst naam + wachtwoord, dan de code. De eerste
// stap geeft dan een kortlevend ticket terug (5 minuten, geen sessie en geen cookie) dat bij deze gebruiker hoort.
const PW_GLOBAL = '*password';
const MFA_TRIES = 5;
pub.post('/password-login', asyncRoute(async (req, res) => {
  if (auth.limiter.blocked(req.ip) || auth.limiter.blocked(PW_GLOBAL, 30)) throw fail(TOO_MANY, 429);
  const user = await users.checkLogin(req.body.username, req.body.password);
  if (!user) {
    auth.limiter.fail(req.ip);
    auth.limiter.fail(PW_GLOBAL);
    throw fail('Onjuiste gebruikersnaam of wachtwoord', 401);
  }
  if (user.mfa) {
    const ticket = putChallenge({ kind: 'mfa', userId: user.id, epoch: user.epoch || 0, tries: 0 });
    return res.json({ mfaRequired: true, ticket });
  }
  auth.limiter.reset(req.ip);
  auth.startSession(req, res, 'pw', user);
  res.json({ ok: true });
}));

pub.post('/mfa-login', asyncRoute(async (req, res) => {
  if (auth.limiter.blocked(req.ip) || auth.limiter.blocked(PW_GLOBAL, 30)) throw fail(TOO_MANY, 429);
  const c = peekChallenge(req.body.ticket);
  const user = c && c.kind === 'mfa' ? users.byId(c.userId) : null;
  if (!user || (user.epoch || 0) !== c.epoch || !user.mfa) {
    if (c) challenges.delete(req.body.ticket);
    throw fail('Sessie verlopen, log opnieuw in', 401);
  }
  if (!users.verifyMfa(user, req.body.code)) {
    auth.limiter.fail(req.ip);
    auth.limiter.fail(PW_GLOBAL);
    if (++c.tries >= MFA_TRIES) challenges.delete(req.body.ticket);
    throw fail('Onjuiste code', 401);
  }
  challenges.delete(req.body.ticket);
  auth.limiter.reset(req.ip);
  auth.startSession(req, res, 'pw', user);
  res.json({ ok: true });
}));

pub.post('/logout', (req, res) => { auth.endSession(res); res.json({ ok: true }); });

// ======================================================================================================
// Publiek: /api/invites — de token uit de link (#invite=…) is het bewijs
// ======================================================================================================
const invites = express.Router();

invites.get('/info', (req, res) => {
  const i = users.findInvite(req.get('X-Invite-Token'));
  if (!i) return res.status(404).json({ error: users.INVALID_INVITE });
  res.set('Cache-Control', 'no-store').json({ ...users.inviteInfo(i), passkey: passkeySupportFor(req) });
});

invites.post('/password', asyncRoute(async (req, res) => {
  const i = users.findInvite(req.body.token);
  if (!i) throw fail(users.INVALID_INVITE, 404);
  const username = users.inviteName(i, req.body.username);
  users.checkPassword(req.body.password, username);
  const hash = await hashPassword(req.body.password);
  const user = users.acceptInvite(i.id, username); // controleert opnieuw: een tweede tabblad of een intrekking
  user.password = hash;
  store.save();
  auth.startSession(req, res, 'pw', user);
  res.json({ ok: true });
}));

// ======================================================================================================
// Beheer (achter requireAdmin): de eigen inlog, bevestigen, en gebruikersbeheer voor de eigenaar
// ======================================================================================================
const admin = express.Router();
const strongOnly = auth.requireStrongSession;
// Na een nieuwe epoch krijgt dit apparaat meteen een nieuw cookie; de andere sessies van deze gebruiker vervallen.
const renew = (req, res) => auth.startSession(req, res, req.authMethod, req.user);

admin.get('/account', (req, res) => res.json({ ...users.summary(req.user), strong: auth.strong({ user: req.user, method: req.authMethod }) }));

admin.put('/account/username', strongOnly, asyncRoute(async (req, res) => {
  const username = users.cleanUsername(req.body.username);
  if (users.nameTaken(username, { exceptUser: req.user.id })) throw fail(users.NAME_TAKEN, 409);
  req.user.username = username;
  store.save();
  res.json({ username });
}));

// Hoe bevestig je een gevoelige actie: met een passkey (uitdaging alleen voor je eigen passkeys) of met je wachtwoord.
admin.post('/confirm/options', asyncRoute(async (req, res) => {
  const own = users.passkeysOf(req.user.id);
  if (!own.length) return res.json({ method: 'password', mfa: !!req.user.mfa });
  const at = ceremony(req);
  const options = await generateAuthenticationOptions({ rpID: at.rpID, userVerification: 'required', allowCredentials: pkOptions(own) });
  res.json({ method: 'passkey', challengeId: putChallenge({ ...at, challenge: options.challenge, kind: 'confirm', userId: req.user.id }), options });
}));

admin.put('/password', strongOnly, asyncRoute(async (req, res) => {
  users.checkPassword(req.body.password, req.user.username);
  await confirm(req);
  const hash = await hashPassword(req.body.password);
  assertCurrent(req);
  req.user.password = hash;
  users.bumpEpoch(req.user);
  store.save();
  renew(req, res);
  res.json({ ok: true });
}));

// Zonder passkey is het wachtwoord de enige inlog; dan kan het niet weg.
admin.post('/password/remove', strongOnly, asyncRoute(async (req, res) => {
  if (!users.hasPasskeys(req.user.id)) throw fail('Je kunt het wachtwoord alleen verwijderen als je een passkey hebt');
  await confirm(req);
  req.user.password = null;
  users.disableMfa(req.user); // MFA hoort bij het wachtwoord
  users.bumpEpoch(req.user);
  store.save();
  renew(req, res);
  res.json({ ok: true });
}));

admin.get('/passkeys', (req, res) => {
  res.json(users.passkeysOf(req.user.id).map(({ id, name, createdAt, lastUsed }) => ({ id, name, createdAt, lastUsed })));
});

admin.delete('/passkeys/:id', strongOnly, (req, res) => {
  const db = store.db();
  const own = users.passkeysOf(req.user.id);
  if (!own.some((p) => p.id === req.params.id)) return res.status(404).json({ error: 'Passkey niet gevonden' });
  if (own.length <= 1 && !req.user.password) return res.status(400).json({ error: 'Je kunt je laatste passkey alleen verwijderen als je een wachtwoord hebt ingesteld' });
  db.passkeys = db.passkeys.filter((p) => p.id !== req.params.id);
  store.save();
  res.json({ ok: true });
});

// MFA instellen in twee stappen: start geeft een nieuw geheim (QR-code), confirm zet het pas aan met een geldige code.
// Een half ingesteld geheim staat alleen in het geheugen en houdt het inloggen nooit tegen.
// Aanzetten vraagt een bevestiging (een gestolen sessie mag de echte gebruiker niet buitensluiten); opnieuw instellen
// kan pas nadat MFA is uitgezet, wat de huidige code vraagt.
admin.post('/mfa/start', strongOnly, asyncRoute(async (req, res) => {
  if (!req.user.password) throw fail('Stel eerst een wachtwoord in; tweestapsverificatie hoort bij inloggen met een wachtwoord');
  if (req.user.mfa) throw fail('Tweestapsverificatie staat al aan; zet hem eerst uit om een andere app te koppelen');
  await confirm(req);
  const { secret, uri } = users.newTotp(req.user, siteTitle());
  const challengeId = putChallenge({ kind: 'mfa-setup', userId: req.user.id, secret, tries: 0 }, 15 * 60 * 1000);
  res.json({ challengeId, secret, uri });
}));

admin.post('/mfa/confirm', strongOnly, asyncRoute(async (req, res) => {
  const c = peekChallenge(req.body.challengeId);
  if (!c || c.kind !== 'mfa-setup' || c.userId !== req.user.id) throw fail('Sessie verlopen, begin opnieuw');
  if (req.user.mfa) throw fail('Tweestapsverificatie staat al aan; zet hem eerst uit om een andere app te koppelen');
  const step = users.totpStep(c.secret, req.body.code);
  if (step === null) {
    if (++c.tries >= 10) challenges.delete(req.body.challengeId);
    throw fail('Onjuiste code');
  }
  challenges.delete(req.body.challengeId);
  const recoveryCodes = users.enableMfa(req.user, c.secret, step);
  users.bumpEpoch(req.user);
  store.save();
  renew(req, res);
  res.json({ recoveryCodes });
}));

admin.post('/mfa/disable', strongOnly, asyncRoute(async (req, res) => {
  if (!req.user.mfa) throw fail('Tweestapsverificatie staat niet aan');
  await confirm(req);
  users.disableMfa(req.user);
  users.bumpEpoch(req.user);
  store.save();
  renew(req, res);
  res.json({ ok: true });
}));

admin.post('/mfa/recovery', strongOnly, asyncRoute(async (req, res) => {
  if (!req.user.mfa) throw fail('Tweestapsverificatie staat niet aan');
  await confirm(req);
  const recoveryCodes = users.newRecoveryCodes(req.user);
  store.save();
  res.json({ recoveryCodes });
}));

// ---------- gebruikersbeheer (alleen de eigenaar) ----------
const owner = express.Router();
owner.use(auth.requireOwner);

owner.get('/', (req, res) => {
  res.json({ users: users.all().map(users.summary), invites: users.listInvites() });
});

owner.post('/invites', asyncRoute(async (req, res) => {
  res.json(users.createInvite({ kind: 'new', username: req.body.username, createdBy: req.user.id, base: origin.pageOrigin(req) }));
}));

owner.delete('/invites/:id', asyncRoute(async (req, res) => {
  users.revokeInvite(req.params.id);
  res.json({ ok: true });
}));

// Een nieuwe inloglink voor iemand die niet meer kan inloggen. De oude inlog blijft werken tot de nieuwe is ingesteld.
owner.post('/:id/reset', asyncRoute(async (req, res) => {
  res.json(users.createInvite({ kind: 'reset', userId: req.params.id, createdBy: req.user.id, base: origin.pageOrigin(req) }));
}));

owner.delete('/:id', asyncRoute(async (req, res) => {
  users.removeUser(req.params.id);
  res.json({ ok: true });
}));

admin.use('/users', owner);

module.exports = { pub, invites, admin, confirm, passkeySupport };
