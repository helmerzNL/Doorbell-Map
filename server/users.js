'use strict';
// Gebruikers van het beheer: één eigenaar en eventueel uitgenodigde gebruikers. Elke gebruiker logt in met een passkey
// en/of gebruikersnaam + wachtwoord, met optioneel tweestapsverificatie (TOTP) en herstelcodes.
// Volgt App-Guidance: shared/guidelines/user-management.md en
// shared/framework/technical-framework/auth-passkeys-password-mfa.md.
//
// Gegevens in db.json:
//   users:    [{ id, username, createdAt, epoch, webauthnId, password, mfa: { secret (versleuteld), lastCounter, createdAt }, recovery: [sha256] }]
//   passkeys: [{ id, publicKey, counter, transports, name, createdAt, lastUsed, userId }]
//   invites:  [{ id, tokenHash, kind: 'new' | 'reset', userId, username, createdBy, createdAt, expiresAt }]
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const OTPAuth = require('otpauth');
const config = require('./config');
const store = require('./store');
const { hashPassword, verifyPassword } = require('./password');

const OWNER_ID = 'owner';
const DEFAULT_USERNAME = 'beheerder';
const INVITE_TTL = 7 * 24 * 3600 * 1000;
const MAX_USERS = 50;
const MAX_INVITES = 50;

const INVALID_INVITE = 'Deze link is ongeldig of verlopen';
const NAME_TAKEN = 'Deze gebruikersnaam is al in gebruik';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const db = () => store.db();
const all = () => db().users;
const nameKey = (s) => String(s).toLowerCase();
const now = () => new Date().toISOString();

const byId = (id) => all().find((u) => u.id === id) || null;
const byName = (name) => all().find((u) => nameKey(u.username) === nameKey(name)) || null;
const passkeysOf = (id) => db().passkeys.filter((p) => p.userId === id);
const hasPasskeys = (id) => db().passkeys.some((p) => p.userId === id);
// Geïnstalleerd zodra iemand een inlog heeft; tot die tijd toont het beheer de installatie-wizard.
const configured = () => db().passkeys.length > 0 || all().some((u) => u.password);

// Een nieuwe gebruiker begint met een willekeurige sessie-epoch: na het herstelcommando en een nieuwe installatie (weer
// met id "owner") of een oude sessiecookie (epoch 0) passen oude cookies dan niet meer. Alleen de gemigreerde eigenaar
// houdt epoch 0, zodat bestaande sessies een update overleven.
function makeUser(id, username, webauthnId) {
  return {
    id, username, createdAt: now(), epoch: crypto.randomInt(1, 2 ** 31),
    webauthnId: webauthnId || crypto.randomBytes(32).toString('base64url'),
    password: null, mfa: null, recovery: [],
  };
}

// Van één beheerder (db.password, db.passkeys, db.userId) naar gebruikers: de bestaande inlog wordt van de eigenaar.
function migrate() {
  const d = db();
  let changed = false;
  if (!Array.isArray(d.users)) { d.users = []; changed = true; }
  if (!Array.isArray(d.invites)) { d.invites = []; changed = true; }
  if (!d.users.length && (d.passkeys.length || d.password)) {
    const first = d.passkeys.map((p) => p.createdAt).filter(Boolean).sort()[0];
    const owner = makeUser(OWNER_ID, DEFAULT_USERNAME, d.userId || undefined);
    owner.createdAt = first || owner.createdAt;
    owner.epoch = 0;
    owner.password = d.password || null;
    d.users.push(owner);
    changed = true;
  }
  // Teruggerold naar een oudere versie en daar een wachtwoord ingesteld? Dan geldt dat voor de eigenaar.
  const owner = d.users.find((u) => u.id === OWNER_ID);
  if (owner && d.password && !owner.password) owner.password = d.password;
  for (const p of d.passkeys) if (!p.userId) { p.userId = OWNER_ID; changed = true; }
  if ('password' in d || 'userId' in d) { delete d.password; delete d.userId; changed = true; }
  if (changed) store.save();
}

// ---------- regels voor naam en wachtwoord ----------
function cleanUsername(v) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (!s || s.length > 40 || /[\u0000-\u001f\u007f]/.test(s)) throw fail('Kies een gebruikersnaam van 1 tot 40 tekens');
  return s;
}

const live = (i) => new Date(i.expiresAt).getTime() > Date.now();

// Bezet door een gebruiker of gereserveerd door een openstaande uitnodiging.
function nameTaken(name, { exceptUser = null, exceptInvite = null } = {}) {
  const k = nameKey(name);
  if (all().some((u) => u.id !== exceptUser && nameKey(u.username) === k)) return true;
  return db().invites.some((i) => i.kind === 'new' && i.id !== exceptInvite && live(i) && i.username && nameKey(i.username) === k);
}

function checkPassword(pw, username = '') {
  if (typeof pw !== 'string' || pw.length < 10 || pw.length > 200) throw fail('Het wachtwoord moet 10 tot 200 tekens lang zijn');
  if (new Set(pw).size < 4) throw fail('Het wachtwoord moet minstens 4 verschillende tekens bevatten');
  if (username.length >= 4 && pw.toLowerCase().includes(username.toLowerCase())) throw fail('Het wachtwoord mag je gebruikersnaam niet bevatten');
}

// Inloggen met naam en wachtwoord. Een onbekende naam kost evenveel tijd als een fout wachtwoord.
let dummyHash = null;
async function checkLogin(username, password) {
  const u = typeof username === 'string' && username.trim() ? byName(username.replace(/\s+/g, ' ').trim()) : null;
  if (!dummyHash) dummyHash = await hashPassword(crypto.randomBytes(16).toString('hex'));
  const ok = await verifyPassword(typeof password === 'string' ? password.slice(0, 200) : '', u?.password || dummyHash);
  return ok && u?.password ? u : null;
}

// Een nieuwe sessie-epoch meldt alle bestaande sessies van deze gebruiker af (op elk apparaat).
const bumpEpoch = (u) => { u.epoch = (u.epoch || 0) + 1; };

function summary(u) {
  return {
    id: u.id, username: u.username, owner: u.id === OWNER_ID, createdAt: u.createdAt,
    passkeys: passkeysOf(u.id).length, password: !!u.password, mfa: !!u.mfa, recoveryLeft: u.mfa ? (u.recovery || []).length : 0,
  };
}

// ---------- tweestapsverificatie (TOTP, RFC 6238, via de module otpauth) ----------
// Het geheim staat versleuteld in db.json (AES-256-GCM). De sleutel komt uit <datamap>/secret.key, dat bij de eerste
// keer MFA instellen wordt aangemaakt; die map (db.json én secret.key) is de eenheid van een back-up.
const secretFile = () => path.join(config.dataDir, 'secret.key');
let sealKey = null;
// create: alleen bij het versleutelen van een nieuw geheim. Ontsleutelen maakt nooit een sleutel aan: een ontbrekend
// bestand (bijvoorbeeld een teruggezette db.json zonder secret.key) betekent "onleesbaar", niet "nieuwe sleutel".
function secretsKey({ create = false } = {}) {
  if (sealKey) return sealKey;
  if (create) {
    try {
      fs.writeFileSync(secretFile(), crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
  } else if (!fs.existsSync(secretFile())) return null;
  const master = fs.readFileSync(secretFile(), 'utf8').trim();
  // Nooit stilletjes een nieuwe sleutel maken: dan zijn alle opgeslagen MFA-geheimen onleesbaar.
  if (master.length < 32) throw fail(`${secretFile()} is leeg of te kort. Zet het bestand uit je back-up terug, of zet MFA uit met het herstelcommando uit de README.`, 500);
  sealKey = crypto.createHash('sha256').update(`doorbell-map:secrets:${master}`).digest();
  return sealKey;
}
function seal(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', secretsKey({ create: true }), iv);
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return ['v1', iv, c.getAuthTag(), ct].map((x) => (typeof x === 'string' ? x : x.toString('base64url'))).join('.');
}
// Een onleesbaar geheim (andere sleutel) is "geen geheim": dan werken alleen nog de herstelcodes.
function unseal(sealed) {
  try {
    const [v, iv, tag, ct] = String(sealed).split('.');
    const key = v === 'v1' ? secretsKey() : null;
    if (!key) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  } catch { return null; }
}

const TOTP_OPTS = { algorithm: 'SHA1', digits: 6, period: 30 };
function newTotp(u, issuer) {
  const secret = new OTPAuth.Secret({ size: 20 });
  const totp = new OTPAuth.TOTP({ ...TOTP_OPTS, issuer, label: u.username, secret });
  return { secret: secret.base32, uri: totp.toString() };
}
// Geeft de tijdstap van een geldige code terug (venster ±1), of null. Een stap die al gebruikt is telt niet (geen replay).
function totpStep(secretB32, code, lastCounter = -1) {
  const token = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(token)) return null;
  const totp = new OTPAuth.TOTP({ ...TOTP_OPTS, secret: OTPAuth.Secret.fromBase32(secretB32) });
  const timestamp = Date.now();
  const delta = totp.validate({ token, timestamp, window: 1 });
  if (delta === null) return null;
  const step = totp.counter({ timestamp }) + delta;
  return step > lastCounter ? step : null;
}

// Herstelcodes: 8 x 16 tekens zonder 0/O/1/I (± 80 bits), één keer getoond, als SHA-256 bewaard en eenmalig bruikbaar.
const RC_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rcNorm = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const rcHash = (s) => crypto.createHash('sha256').update(rcNorm(s)).digest('hex');
function newRecoveryCodes(u) {
  const codes = Array.from({ length: 8 }, () => Array.from({ length: 16 }, () => RC_ALPHABET[crypto.randomInt(RC_ALPHABET.length)]).join('').match(/.{4}/g).join('-'));
  u.recovery = codes.map(rcHash);
  return codes;
}

function enableMfa(u, secretB32, step) {
  u.mfa = { secret: seal(secretB32), lastCounter: step, createdAt: now() };
  return newRecoveryCodes(u);
}
const disableMfa = (u) => { u.mfa = null; u.recovery = []; };

// De tweede stap bij inloggen of bevestigen: eerst de TOTP-code, anders een herstelcode. 'totp', 'recovery' of null.
function verifyMfa(u, code) {
  if (!u.mfa) return null;
  const secret = unseal(u.mfa.secret);
  const step = secret ? totpStep(secret, code, u.mfa.lastCounter ?? -1) : null;
  if (step !== null) { u.mfa.lastCounter = step; store.save(); return 'totp'; }
  if (rcNorm(code).length !== 16) return null;
  const i = (u.recovery || []).indexOf(rcHash(code));
  if (i < 0) return null;
  u.recovery.splice(i, 1);
  store.save();
  return 'recovery';
}

// ---------- installatie ----------
// De eerste inlog maakt de eigenaar. Alleen zolang er nog niemand kan inloggen (configured() is false).
function setupOwner(username, webauthnId) {
  if (configured()) throw fail('Het beheer is al ingesteld', 403);
  const owner = makeUser(OWNER_ID, username, webauthnId);
  db().users = [owner];
  db().invites = [];
  return owner;
}

// ---------- uitnodigingen ----------
const sha256 = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const purgeInvites = () => { db().invites = db().invites.filter(live); };
const inviteUrl = (token) => `${config.origin}/beheer#invite=${token}`;

function createInvite({ kind = 'new', userId = null, username = '', createdBy }) {
  purgeInvites();
  let name = '';
  if (kind === 'new') {
    if (db().invites.length >= MAX_INVITES) throw fail('Er staan te veel uitnodigingen open; trek er eerst een in', 409);
    if (all().length + db().invites.filter((i) => i.kind === 'new').length >= MAX_USERS) throw fail('Het maximale aantal gebruikers is bereikt', 409);
    if (String(username ?? '').trim()) {
      name = cleanUsername(username);
      if (nameTaken(name)) throw fail(NAME_TAKEN, 409);
    }
  } else {
    const u = byId(userId);
    if (!u || u.id === OWNER_ID) throw fail('Gebruiker niet gevonden', 404);
    name = u.username;
    db().invites = db().invites.filter((i) => !(i.kind === 'reset' && i.userId === u.id)); // één reset-link per gebruiker
    if (db().invites.length >= MAX_INVITES) throw fail('Er staan te veel uitnodigingen open; trek er eerst een in', 409);
  }
  const token = crypto.randomBytes(32).toString('base64url');
  const row = {
    id: crypto.randomBytes(8).toString('hex'), tokenHash: sha256(token), kind,
    userId: kind === 'reset' ? userId : null, username: name, createdBy,
    createdAt: now(), expiresAt: new Date(Date.now() + INVITE_TTL).toISOString(),
  };
  db().invites.push(row);
  store.save();
  return { id: row.id, kind, username: name, token, url: inviteUrl(token), expiresAt: row.expiresAt };
}

// Onbekend, verlopen, gebruikt of misvormd: allemaal null (de route antwoordt overal hetzelfde).
function findInvite(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const h = sha256(token);
  const i = db().invites.find((x) => x.tokenHash === h);
  if (!i || !live(i)) return null;
  if (i.kind === 'reset' && !byId(i.userId)) return null;
  return i;
}

function inviteInfo(i) {
  return {
    kind: i.kind,
    username: i.kind === 'reset' ? byId(i.userId).username : i.username,
    invitedBy: byId(i.createdBy)?.username || '',
    expiresAt: i.expiresAt,
  };
}

// De naam waarmee een uitnodiging wordt afgerond (bij een reset altijd de bestaande naam). Gooit bij een ongeldige of bezette naam.
function inviteName(i, requested) {
  if (i.kind === 'reset') return byId(i.userId).username;
  const name = cleanUsername(requested);
  if (nameTaken(name, { exceptInvite: i.id })) throw fail(NAME_TAKEN, 409);
  return name;
}

function clearCredentials(u) {
  u.password = null;
  disableMfa(u);
  db().passkeys = db().passkeys.filter((p) => p.userId !== u.id);
  bumpEpoch(u);
}

// Rondt een uitnodiging af: controleert opnieuw, maakt de gebruiker (new) of wist de oude inlog (reset), en verbruikt de
// uitnodiging. Synchroon aanroepen ná de laatste await, vlak voordat de nieuwe inlog wordt opgeslagen (regel 5: niets
// verandert voordat de gast klaar is).
function acceptInvite(inviteId, username, webauthnId) {
  const i = db().invites.find((x) => x.id === inviteId);
  if (!i || !live(i)) throw fail(INVALID_INVITE, 404);
  let u;
  if (i.kind === 'new') {
    if (nameTaken(username, { exceptInvite: i.id })) throw fail(NAME_TAKEN, 409);
    u = makeUser(crypto.randomBytes(12).toString('base64url'), username, webauthnId);
    all().push(u);
  } else {
    u = byId(i.userId);
    if (!u || u.id === OWNER_ID) throw fail(INVALID_INVITE, 404);
    clearCredentials(u);
  }
  db().invites = db().invites.filter((x) => x !== i);
  return u;
}

function revokeInvite(id) {
  const before = db().invites.length;
  db().invites = db().invites.filter((i) => i.id !== id);
  if (db().invites.length === before) throw fail('Uitnodiging niet gevonden', 404);
  store.save();
}

function listInvites() {
  purgeInvites();
  return db().invites.map(({ id, kind, userId, username, createdAt, expiresAt }) => ({
    id, kind, username: kind === 'reset' ? byId(userId)?.username || username : username, createdAt, expiresAt,
  }));
}

// Verwijdert de gebruiker met alle passkeys en uitnodigingen; de sessies vervallen omdat de gebruiker niet meer bestaat.
function removeUser(id) {
  if (id === OWNER_ID) throw fail('De eigenaar kan niet worden verwijderd');
  if (!byId(id)) throw fail('Gebruiker niet gevonden', 404);
  db().users = all().filter((u) => u.id !== id);
  db().passkeys = db().passkeys.filter((p) => p.userId !== id);
  db().invites = db().invites.filter((i) => i.userId !== id);
  store.save();
}

module.exports = {
  OWNER_ID, DEFAULT_USERNAME, INVITE_TTL, MAX_USERS, MAX_INVITES, INVALID_INVITE, NAME_TAKEN,
  migrate, configured, byId, byName, passkeysOf, hasPasskeys, summary, all,
  cleanUsername, nameTaken, checkPassword, checkLogin, bumpEpoch,
  newTotp, totpStep, enableMfa, disableMfa, verifyMfa, newRecoveryCodes, rcHash,
  setupOwner, createInvite, findInvite, inviteInfo, inviteName, acceptInvite, revokeInvite, listInvites, removeUser,
};
