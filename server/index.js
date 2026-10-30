'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const config = require('./config');
const store = require('./store');
const auth = require('./auth');
const { hashPassword, verifyPassword } = require('./password');
const backups = require('./backups');
const residents = require('./residents');
const appVersion = require('./version');
const { normalizeHouse, STATUSES, statusLabels, statsShow } = require('./houses');

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data: blob: https://tile.openstreetmap.org; connect-src 'self' https://nominatim.openstreetmap.org https://tile.openstreetmap.org; worker-src 'self'; manifest-src 'self'; object-src 'self' blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
  });
  next();
});
app.use(express.json({ limit: '2mb' }));
app.use(auth.sameOrigin);

// ---------- challenges (in-memory, kort geldig) ----------
const challenges = new Map();
function putChallenge(data) {
  const id = crypto.randomBytes(16).toString('base64url');
  challenges.set(id, { ...data, exp: Date.now() + 5 * 60 * 1000 });
  return id;
}
function takeChallenge(id) {
  const c = challenges.get(id);
  challenges.delete(id);
  for (const [k, v] of challenges) if (v.exp < Date.now()) challenges.delete(k);
  return c && c.exp > Date.now() ? c : null;
}

const asyncRoute = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error(err);
    res.status(err.status || 400).json({ error: err.message || 'Er ging iets mis' });
  });

function userId() {
  const db = store.db();
  if (!db.userId) { db.userId = crypto.randomBytes(32).toString('base64url'); store.save(); }
  return Buffer.from(db.userId, 'base64url');
}

// ---------- publiek ----------
// Naam van de site: instelling in het beheer, anders SITE_TITLE uit de omgeving.
const lang = require('./lang');
lang.migrate();
const siteTitle = () => lang.text('siteTitle') || config.siteTitle; // in de standaardtaal van de site

// Teksten in andere talen zoals bezoekers ze zien (het infovlak alleen als wijzigen door bewoners aan staat).
function publicTranslations() {
  const out = {};
  for (const l of lang.LANGS) {
    if (l === 'nl') continue;
    const t = lang.translations(l);
    out[l] = {
      siteTitle: t.siteTitle || '', appName: t.appName || '', appShortName: t.appShortName || '', intro: t.intro || '',
      residentInfo: residents.enabled() ? t.residentInfo || '' : '',
      labels: { green: t.labels?.green || '', red: t.labels?.red || '', none: t.labels?.none || '' },
    };
  }
  return out;
}

app.get('/api/map', (req, res) => {
  const { view, pdfView, houses, settings } = store.db();
  res.set('Cache-Control', 'no-cache');
  res.json({
    title: settings?.siteTitle || config.siteTitle, siteTitle: settings?.siteTitle || '', view, pdfView: pdfView || null, houses,
    intro: settings?.intro || '', logo: settings?.logo || null, logoSmall: settings?.logoSmall || null,
    multilingual: lang.multilingual(), defaultLang: lang.defaultLang(),
    translations: publicTranslations(),
    appName: settings?.appName || '', appShortName: settings?.appShortName || '',
    residentsEnabled: residents.mode() !== 'closed', // ook 'swap': dan blijft de knop zichtbaar voor wie al een huis heeft
    residentsMode: residents.mode(),
    simpleUi: settings?.simpleUi === true,
    statsPublic: settings?.statsPublic === true, // overzichtsoverlay ook op de voorpagina
    statsShow: statsShow(settings),
    qrOnly: residents.qrOnly(),
    deviceCode: residents.codeOn(), // alleen of er een code nodig is, nooit de code zelf
    geofence: residents.geofence().on ? { center: residents.geofence().center, radius: residents.geofence().radius } : null,
    residentsAppOnly: residents.appOnly(),
    residentInfo: residents.enabled() ? residents.info() : '', // het infovlak verdwijnt zodra wijzigen uit staat
    labels: statusLabels(settings),
  });
});

app.use('/uploads', express.static(store.uploadDir, { immutable: true, maxAge: '365d', index: false }));

// PWA-manifest met de naam van de site
app.get('/manifest.webmanifest', (req, res) => {
  const name = lang.text('appName') || siteTitle();
  const base = lang.text('appShortName') || (name.length > 12 ? name.slice(0, 12) : name);
  const beta = appVersion.beta;
  res.type('application/manifest+json').json({
    name: beta ? `${name} (beta)` : name,
    short_name: beta ? `${base.slice(0, 9).trim()} β` : base, // onder het icoon: maximaal 12 tekens
    id: beta ? '/?channel=beta' : undefined, // een beta naast de stabiele app installeren kan dan ook
    description: `Kaart van ${name}`,
    lang: lang.defaultLang(),
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#f4f6f4',
    theme_color: '#1f6f4a',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  });
});

// Eigen PWA-manifest voor het beheer: andere naam, icoon en kleur, en alleen het pad /beheer
app.get('/beheer.webmanifest', (req, res) => {
  const name = lang.text('appName') || siteTitle();
  res.type('application/manifest+json').json({
    name: `${name} – Beheer${appVersion.beta ? ' (beta)' : ''}`,
    short_name: appVersion.beta ? 'Beheer β' : 'Beheer',
    description: `Beheer van ${name}`,
    lang: lang.defaultLang(),
    id: '/beheer',
    start_url: '/beheer',
    scope: '/beheer',
    display: 'standalone',
    background_color: '#243456',
    theme_color: '#243456',
    icons: [
      { src: '/icons/admin-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/admin-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/admin-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  });
});

// ---------- auth ----------
app.get('/api/auth/status', (req, res) => {
  const db = store.db();
  const method = auth.sessionMethod(req);
  res.json({ configured: db.passkeys.length > 0, loggedIn: !!method, method, passwordEnabled: !!db.password });
});

app.post('/api/auth/register/options', asyncRoute(async (req, res) => {
  const db = store.db();
  const loggedIn = auth.isLoggedIn(req);
  if (loggedIn && auth.sessionMethod(req) !== 'pk') return res.status(403).json({ error: 'Log in met een passkey om dit te wijzigen' });
  if (!loggedIn) {
    if (db.passkeys.length > 0) return res.status(401).json({ error: 'Niet ingelogd' });
    if (auth.limiter.blocked(req.ip)) return res.status(429).json({ error: 'Te veel pogingen, probeer later opnieuw' });
    if (!auth.safeEqual(req.body.setupToken || '', config.setupToken)) {
      auth.limiter.fail(req.ip);
      return res.status(403).json({ error: 'Onjuiste installatiecode' });
    }
  }
  const name = String(req.body.name || 'Passkey').slice(0, 60);
  const options = await generateRegistrationOptions({
    rpName: siteTitle(),
    rpID: config.rpID,
    userName: 'beheerder',
    userDisplayName: 'Beheerder',
    userID: userId(),
    attestationType: 'none',
    excludeCredentials: db.passkeys.map((p) => ({ id: p.id, transports: p.transports })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
  const challengeId = putChallenge({ challenge: options.challenge, kind: 'register', name, firstSetup: !loggedIn });
  res.json({ challengeId, options });
}));

app.post('/api/auth/register/verify', asyncRoute(async (req, res) => {
  const c = takeChallenge(req.body.challengeId);
  if (!c || c.kind !== 'register') return res.status(400).json({ error: 'Sessie verlopen, begin opnieuw' });
  const db = store.db();
  // Een eerste setup mag alleen lukken zolang er nog geen passkey is.
  if (c.firstSetup && db.passkeys.length > 0) return res.status(403).json({ error: 'Er is al een passkey ingesteld' });
  if (!c.firstSetup && auth.sessionMethod(req) !== 'pk') return res.status(401).json({ error: 'Niet ingelogd met een passkey' });

  const v = await verifyRegistrationResponse({
    response: req.body.response,
    expectedChallenge: c.challenge,
    expectedOrigin: config.origin,
    expectedRPID: config.rpID,
  });
  if (!v.verified) return res.status(400).json({ error: 'Passkey kon niet worden geverifieerd' });
  const { credential } = v.registrationInfo;
  db.passkeys.push({
    id: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter,
    transports: credential.transports || [],
    name: c.name,
    createdAt: new Date().toISOString(),
  });
  store.save();
  auth.limiter.reset(req.ip);
  if (c.firstSetup) auth.startSession(res);
  res.json({ ok: true });
}));

app.post('/api/auth/login/options', asyncRoute(async (req, res) => {
  const db = store.db();
  if (!db.passkeys.length) return res.status(409).json({ error: 'Nog geen passkey ingesteld' });
  if (auth.limiter.blocked(req.ip)) return res.status(429).json({ error: 'Te veel pogingen, probeer later opnieuw' });
  const options = await generateAuthenticationOptions({
    rpID: config.rpID,
    userVerification: 'preferred',
    allowCredentials: db.passkeys.map((p) => ({ id: p.id, transports: p.transports })),
  });
  res.json({ challengeId: putChallenge({ challenge: options.challenge, kind: 'login' }), options });
}));

// Controleert een passkey-antwoord op een eerder uitgegeven uitdaging ("login" of "confirm").
async function verifyAssertion(req, kind) {
  const c = takeChallenge(req.body.challengeId);
  if (!c || c.kind !== kind) throw Object.assign(new Error('Sessie verlopen, begin opnieuw'), { status: 400 });
  const db = store.db();
  const pk = db.passkeys.find((p) => p.id === req.body.response?.id);
  if (!pk) throw Object.assign(new Error('Onbekende passkey'), { status: 400 });
  const v = await verifyAuthenticationResponse({
    response: req.body.response,
    expectedChallenge: c.challenge,
    expectedOrigin: config.origin,
    expectedRPID: config.rpID,
    requireUserVerification: true,
    credential: { id: pk.id, publicKey: Buffer.from(pk.publicKey, 'base64url'), counter: pk.counter, transports: pk.transports },
  });
  if (!v.verified) throw Object.assign(new Error('Passkey kon niet worden geverifieerd'), { status: 400 });
  pk.counter = v.authenticationInfo.newCounter;
  pk.lastUsed = new Date().toISOString();
  store.save();
}

app.post('/api/auth/login/verify', asyncRoute(async (req, res) => {
  if (auth.limiter.blocked(req.ip)) return res.status(429).json({ error: 'Te veel pogingen, probeer later opnieuw' });
  try {
    await verifyAssertion(req, 'login');
  } catch (err) {
    auth.limiter.fail(req.ip);
    throw err;
  }
  auth.limiter.reset(req.ip);
  auth.startSession(res, 'pk');
  res.json({ ok: true });
}));

// Inloggen met wachtwoord (alleen als dat in het beheer is ingesteld).
const PW_GLOBAL = '*password';
app.post('/api/auth/password-login', asyncRoute(async (req, res) => {
  const db = store.db();
  if (auth.limiter.blocked(req.ip) || auth.limiter.blocked(PW_GLOBAL, 30)) {
    return res.status(429).json({ error: 'Te veel pogingen, probeer later opnieuw' });
  }
  const password = typeof req.body.password === 'string' ? req.body.password.slice(0, 200) : '';
  // Ook zonder ingesteld wachtwoord rekenen we, zodat de responstijd niets verklapt.
  const stored = db.password || await hashPassword('x');
  const ok = await verifyPassword(password, stored);
  if (!db.password || !ok) {
    auth.limiter.fail(req.ip);
    auth.limiter.fail(PW_GLOBAL);
    return res.status(401).json({ error: 'Onjuist wachtwoord' });
  }
  auth.limiter.reset(req.ip);
  auth.startSession(res, 'pw');
  res.json({ ok: true });
}));

app.post('/api/auth/logout', (req, res) => { auth.endSession(res); res.json({ ok: true }); });

// ---------- beheer ----------
const admin = express.Router();
admin.use(auth.requireAdmin);

const pwError = (res, err) => res.status(err.status || 400).json({ error: err.message });

// Wachtwoord instellen of verwijderen moet met een passkey worden bevestigd.
admin.post('/password/options', auth.requirePasskeySession, asyncRoute(async (req, res) => {
  const db = store.db();
  const options = await generateAuthenticationOptions({
    rpID: config.rpID,
    userVerification: 'required',
    allowCredentials: db.passkeys.map((p) => ({ id: p.id, transports: p.transports })),
  });
  res.json({ challengeId: putChallenge({ challenge: options.challenge, kind: 'confirm' }), options });
}));

admin.put('/password', auth.requirePasskeySession, asyncRoute(async (req, res) => {
  const password = req.body.password;
  if (typeof password !== 'string' || password.length < 10 || password.length > 200) {
    return res.status(400).json({ error: 'Het wachtwoord moet 10 tot 200 tekens lang zijn' });
  }
  try { await verifyAssertion(req, 'confirm'); } catch (err) { return pwError(res, err); }
  store.db().password = await hashPassword(password);
  store.save();
  res.json({ ok: true });
}));

admin.post('/password/remove', auth.requirePasskeySession, asyncRoute(async (req, res) => {
  try { await verifyAssertion(req, 'confirm'); } catch (err) { return pwError(res, err); }
  store.db().password = null;
  store.save();
  res.json({ ok: true });
}));

// Algemene bevestiging met een passkey (voor o.a. het verwijderen van backups).
admin.post('/confirm/options', asyncRoute(async (req, res) => {
  const options = await generateAuthenticationOptions({
    rpID: config.rpID,
    userVerification: 'required',
    allowCredentials: store.db().passkeys.map((p) => ({ id: p.id, transports: p.transports })),
  });
  res.json({ challengeId: putChallenge({ challenge: options.challenge, kind: 'confirm' }), options });
}));

admin.get('/info', (req, res) => {
  const { version, build, buildFull, label, channel } = appVersion;
  res.json({ version, build, buildFull, label, channel });
});

// Publieke versie- en kanaalinfo ("beta" of "stable").
app.get('/api/version', (req, res) => {
  const { version, build, channel } = appVersion;
  res.set('Cache-Control', 'no-cache').json({ version, build, channel });
});

admin.get('/backups', (req, res) => res.json(backups.list()));

admin.get('/backups/:id', (req, res) => {
  const b = backups.read(req.params.id);
  if (!b) return res.status(404).json({ error: 'Backup niet gevonden' });
  res.set('Content-Disposition', `attachment; filename="backup-${b.id}.json"`);
  res.json(b);
});

// Maakt van een geüploade backup een schone inhoud ({houses, view, pdfView, texts}); gooit een Error bij ongeldige inhoud.
function sanitizeBackup(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('Dit is geen geldige backup');
  const houses = validateHouses(b.houses);
  let view = null;
  if (b.view) {
    const v = b.view;
    const okZoom = (z) => Number.isFinite(z) && z >= 1 && z <= 19;
    if (!validLatLng(v.center) || !okZoom(v.zoom) || !okZoom(v.minZoom ?? 1) || !okZoom(v.maxZoom ?? 19)) throw new Error('De kaartweergave in de backup is ongeldig');
    view = { center: v.center.map((n) => Math.round(n * 1e6) / 1e6), zoom: v.zoom, minZoom: v.minZoom ?? 1, maxZoom: v.maxZoom ?? 19, showNumbers: v.showNumbers === true };
  }
  let pdfView = null;
  if (b.pdfView) {
    if (!validLatLng(b.pdfView.center) || !Number.isInteger(b.pdfView.zoom) || b.pdfView.zoom < 1 || b.pdfView.zoom > 19) throw new Error('Het PDF-kaartvlak in de backup is ongeldig');
    pdfView = { center: b.pdfView.center.map((n) => Math.round(n * 1e6) / 1e6), zoom: b.pdfView.zoom };
  }
  const t = b.texts;
  if (!t || typeof t !== 'object') throw new Error('De teksten in de backup ontbreken');
  const txt = (o, f) => { const r = cleanText(f, o?.[f]); if (r.error) throw new Error(r.error); return r.value; };
  const labelsOf = (o) => {
    const out = {};
    for (const k of ['green', 'red', 'none']) out[k] = String(o?.[k] ?? '').trim().slice(0, 24);
    return out;
  };
  const texts = { labels: labelsOf(t.labels), siteTitle: txt(t, 'siteTitle'), intro: txt(t, 'intro'), appName: txt(t, 'appName'), appShortName: txt(t, 'appShortName'), translations: {} };
  for (const l of lang.LANGS) {
    const o = t.translations?.[l];
    if (!o || typeof o !== 'object' || l === 'nl') continue;
    texts.translations[l] = { siteTitle: txt(o, 'siteTitle'), appName: txt(o, 'appName'), appShortName: txt(o, 'appShortName'), intro: txt(o, 'intro'), residentInfo: txt(o, 'residentInfo'), qrShareText: txt(o, 'qrShareText'), labels: labelsOf(o.labels) };
  }
  return { houses, view, pdfView, texts };
}

// Een gedownloade backup (.json) weer uploaden: komt als nieuwe backup in de lijst; terugzetten blijft een aparte stap.
admin.post('/backups/import', (req, res) => {
  try {
    const data = sanitizeBackup(req.body);
    res.json({ id: backups.importData(data, req.body.title) });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Ongeldige backup' });
  }
});

// Handmatig een backup maken, met een korte titel (bijv. "Alles" of "Alleen layout").
admin.post('/backups', (req, res) => {
  const id = backups.create('Handmatig', true, { title: req.body?.title, force: true });
  res.json({ id });
});

admin.put('/backups/:id/title', (req, res) => {
  if (typeof req.body?.title !== 'string') return res.status(400).json({ error: 'Titel ontbreekt' });
  const title = backups.setTitle(req.params.id, req.body.title);
  if (title === null) return res.status(404).json({ error: 'Backup niet gevonden' });
  res.json({ title });
});

admin.post('/backups/:id/restore', (req, res) => {
  if (!backups.restore(req.params.id)) return res.status(404).json({ error: 'Backup niet gevonden' });
  res.json({ ok: true });
});

// Verwijderen vereist bevestiging met een passkey.
admin.post('/backups/delete', asyncRoute(async (req, res) => {
  const idsToDelete = req.body.ids;
  if (!Array.isArray(idsToDelete) || !idsToDelete.length || idsToDelete.length > 500 || !idsToDelete.every((i) => typeof i === 'string' && backups.ID.test(i))) {
    return res.status(400).json({ error: 'Geen geldige backups geselecteerd' });
  }
  try { await verifyAssertion(req, 'confirm'); } catch (err) { return pwError(res, err); }
  res.json({ deleted: backups.remove(idsToDelete) });
}));

admin.get('/passkeys', (req, res) => {
  res.json(store.db().passkeys.map(({ id, name, createdAt, lastUsed }) => ({ id, name, createdAt, lastUsed })));
});

admin.delete('/passkeys/:id', auth.requirePasskeySession, (req, res) => {
  const db = store.db();
  if (db.passkeys.length <= 1) return res.status(400).json({ error: 'Je kunt de laatste passkey niet verwijderen' });
  db.passkeys = db.passkeys.filter((p) => p.id !== req.params.id);
  store.save();
  res.json({ ok: true });
});

const IMAGE_TYPES = [
  { ext: 'png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'webp', test: (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' },
];

const removeLogoFile = (logo) => {
  if (logo?.file) fs.rm(path.join(store.uploadDir, path.basename(logo.file)), () => {});
};

// Het logo (PDF, QR-kaartjes) en het kleine logo (kopbalk) worden op dezelfde manier bewaard; het kleine logo is optioneel.
for (const [route, key, prefix] of [['/logo', 'logo', 'logo'], ['/logo-small', 'logoSmall', 'logo-small']]) {
  admin.post(route,
    express.raw({ type: 'application/octet-stream', limit: '5mb' }),
    (req, res) => {
      const buf = req.body;
      const type = Buffer.isBuffer(buf) && IMAGE_TYPES.find((t) => t.test(buf));
      if (!type) return res.status(400).json({ error: 'Alleen PNG, JPEG of WebP is toegestaan (max 5 MB)' });
      const db = store.db();
      const old = db.settings[key];
      const file = `${prefix}-${Date.now()}.${type.ext}`;
      fs.writeFileSync(path.join(store.uploadDir, file), buf);
      db.settings[key] = { file, url: `/uploads/${file}` };
      store.save();
      removeLogoFile(old);
      res.json({ [key]: db.settings[key] });
    });

  admin.delete(route, (req, res) => {
    const db = store.db();
    removeLogoFile(db.settings[key]);
    db.settings[key] = null;
    store.save();
    res.json({ ok: true });
  });
}

// Instellingen zoals bewaard (voor het beheerscherm); /api/map geeft de actuele, effectieve waarden.
admin.get('/settings', (req, res) => {
  const s = store.db().settings;
  const tx = {};
  for (const l of lang.LANGS) {
    if (l === 'nl') continue;
    const t = lang.translations(l);
    tx[l] = Object.fromEntries([...lang.TEXT_FIELDS.map((f) => [f, t[f] || '']), ['labels', { green: t.labels?.green || '', red: t.labels?.red || '', none: t.labels?.none || '' }]]);
  }
  res.json({ residentInfo: residents.info(), residentsOff: s.residentsOff === true, residentsUntil: s.residentsUntil || null, residentsSwapAfter: s.residentsSwapAfter === true, residentsGeofence: s.residentsGeofence === true, simpleUi: s.simpleUi === true, statsPublic: s.statsPublic === true, statsShow: statsShow(s), residentsQrOnly: s.residentsQrOnly === true, residentsCodeOn: s.residentsCodeOn === true, residentsCode: s.residentsCode || '', residentsGeofenceRadius: residents.geofence().radius, multilingual: lang.multilingual(), defaultLang: lang.defaultLang(), qrShareText: s.qrShareText || '', translations: tx, defaultShareTexts: residents.defaultShareTexts(), defaultInfo: residents.DEFAULT_INFO });
});

// Tekstvelden met hun maximale lengte; gelden voor het Nederlands (gewone instellingen) en voor elke vertaling.
const TEXT_RULES = {
  siteTitle: { max: 60, error: 'De naam van de site mag maximaal 60 tekens zijn' },
  appName: { max: 45, error: 'De naam van de app mag maximaal 45 tekens zijn' },
  appShortName: { max: 12, error: 'De korte naam mag maximaal 12 tekens zijn (past onder het icoon)' },
  intro: { max: 5000, multiline: true, error: 'De uitleg mag maximaal 5000 tekens zijn' },
  residentInfo: { max: 1000, multiline: true, error: 'Het infovlak mag maximaal 1000 tekens zijn' },
  qrShareText: { max: 500, multiline: true, error: 'De deeltekst mag maximaal 500 tekens zijn' },
};
// { value } of { error }
function cleanText(field, raw) {
  const r = TEXT_RULES[field];
  let v = String(raw ?? '');
  v = (r.multiline ? v.replace(/\r\n?/g, '\n') : v).trim();
  return v.length > r.max ? { error: r.error } : { value: v };
}

admin.put('/settings', backups.afterSave('Teksten/instellingen opgeslagen'), (req, res) => {
  const body = req.body || {};
  const db = store.db();
  for (const f of ['intro', 'residentInfo', 'qrShareText']) {
    if (!(f in body)) continue;
    const r = cleanText(f, body[f]);
    if (r.error) return res.status(400).json({ error: r.error });
    db.settings[f] = r.value; // qrShareText leeg = standaardtekst
  }
  if ('multilingual' in body) db.settings.multilingual = body.multilingual === true;
  if ('defaultLang' in body) {
    if (!lang.LANGS.includes(body.defaultLang)) return res.status(400).json({ error: 'Onbekende taal' });
    db.settings.defaultLang = body.defaultLang;
  }
  if ('residentsOff' in body || 'residentsUntil' in body) {
    const off = 'residentsOff' in body ? body.residentsOff === true : db.settings.residentsOff === true;
    const rawUntil = 'residentsUntil' in body ? body.residentsUntil : db.settings.residentsUntil;
    const t = Date.parse(rawUntil || '');
    if (off && !Number.isFinite(t)) return res.status(400).json({ error: 'Kies eerst een geldige datum en tijd' });
    db.settings.residentsOff = off;
    db.settings.residentsUntil = Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  if ('residentsGeofenceRadius' in body) {
    const r = Number(body.residentsGeofenceRadius);
    if (!Number.isFinite(r) || r < residents.GEO_MIN || r > residents.GEO_MAX) return res.status(400).json({ error: `De straal moet tussen ${residents.GEO_MIN} en ${residents.GEO_MAX} meter liggen` });
    db.settings.residentsGeofenceRadius = Math.round(r);
  }
  if ('residentsGeofence' in body) {
    const on = body.residentsGeofence === true;
    if (on && !residents.geofence().center && !db.houses.length) return res.status(400).json({ error: 'Stel eerst de kaartweergave in of teken huizen: daaruit volgt het midden van de wijk' });
    db.settings.residentsGeofence = on;
  }
  if ('residentsQrOnly' in body) db.settings.residentsQrOnly = body.residentsQrOnly === true;
  if ('residentsCode' in body) {
    const code = String(body.residentsCode ?? '').trim();
    if (code && !/^\d{4,6}$/.test(code)) return res.status(400).json({ error: 'De code moet uit 4 tot 6 cijfers bestaan' });
    db.settings.residentsCode = code;
    if (!code) db.settings.residentsCodeOn = false;
  }
  if ('residentsCodeOn' in body) {
    const on = body.residentsCodeOn === true;
    if (on && !/^\d{4,6}$/.test(String(db.settings.residentsCode || ''))) return res.status(400).json({ error: 'Stel eerst een code van 4 tot 6 cijfers in' });
    db.settings.residentsCodeOn = on;
  }
  if ('simpleUi' in body) db.settings.simpleUi = body.simpleUi === true;
  if ('statsPublic' in body) db.settings.statsPublic = body.statsPublic === true;
  if (body.statsShow && typeof body.statsShow === 'object') {
    const next = statsShow(db.settings);
    for (const k of STATUSES) if (k in body.statsShow) next[k] = body.statsShow[k] === true;
    db.settings.statsShow = next;
  }
  if ('residentsSwapAfter' in body) db.settings.residentsSwapAfter = body.residentsSwapAfter === true;
  if ('residentsEnabled' in body) db.settings.residentsEnabled = body.residentsEnabled === true;
  if ('residentsAppOnly' in body) db.settings.residentsAppOnly = body.residentsAppOnly === true;
  if (body.labels && typeof body.labels === 'object') {
    const next = { ...statusLabels(db.settings) };
    for (const k of STATUSES) {
      if (k in body.labels) {
        const v = String(body.labels[k] ?? '').trim();
        if (v.length > 24) return res.status(400).json({ error: 'Een naam mag maximaal 24 tekens zijn' });
        next[k] = v || statusLabels(null)[k]; // leeg = standaardnaam
      }
    }
    db.settings.labels = next;
  }
  for (const f of ['siteTitle', 'appName', 'appShortName']) {
    if (!(f in body)) continue;
    const r = cleanText(f, body[f]);
    if (r.error) return res.status(400).json({ error: r.error });
    db.settings[f] = r.value;
  }
  // Teksten in andere talen: { en: { siteTitle, appName, appShortName, intro, residentInfo, qrShareText, labels: { green, red, none } } }
  if (body.translations !== undefined) {
    if (!body.translations || typeof body.translations !== 'object') return res.status(400).json({ error: 'Ongeldige vertalingen' });
    const next = JSON.parse(JSON.stringify(db.settings.translations || {}));
    for (const [l, vals] of Object.entries(body.translations)) {
      if (!lang.LANGS.includes(l) || l === 'nl' || !vals || typeof vals !== 'object') return res.status(400).json({ error: 'Onbekende taal' });
      const cur = (next[l] = next[l] || {});
      for (const f of lang.TEXT_FIELDS) {
        if (!(f in vals)) continue;
        const r = cleanText(f, vals[f]);
        if (r.error) return res.status(400).json({ error: r.error });
        cur[f] = r.value; // leeg = valt terug op het Nederlands
      }
      if (vals.labels && typeof vals.labels === 'object') {
        cur.labels = cur.labels || {};
        for (const k of STATUSES) {
          if (!(k in vals.labels)) continue;
          const v = String(vals.labels[k] ?? '').trim();
          if (v.length > 24) return res.status(400).json({ error: 'Een naam mag maximaal 24 tekens zijn' });
          cur.labels[k] = v;
        }
      }
    }
    db.settings.translations = next;
  }
  store.save();
  res.json({ labels: statusLabels(db.settings), statsPublic: db.settings.statsPublic === true, statsShow: statsShow(db.settings), residentsEnabled: db.settings.residentsEnabled !== false, residentsAppOnly: db.settings.residentsAppOnly === true, intro: db.settings.intro, siteTitle: db.settings.siteTitle, appName: db.settings.appName, appShortName: db.settings.appShortName });
});

admin.put('/view', backups.afterSave('Kaartweergave opgeslagen'), (req, res) => {
  const { center, zoom } = req.body || {};
  const minZoom = req.body?.minZoom ?? 1;
  const maxZoom = req.body?.maxZoom ?? 19;
  const okZoom = (z) => Number.isFinite(z) && z >= 1 && z <= 19;
  if (!validLatLng(center) || !okZoom(zoom) || !okZoom(minZoom) || !okZoom(maxZoom)) {
    return res.status(400).json({ error: 'Ongeldige kaartweergave (zoom moet tussen 1 en 19 liggen)' });
  }
  if (minZoom > maxZoom) return res.status(400).json({ error: 'Minimale zoom mag niet groter zijn dan de maximale zoom' });
  if (zoom < minZoom || zoom > maxZoom) return res.status(400).json({ error: 'De startzoom moet tussen de minimale en maximale zoom liggen' });
  const db = store.db();
  db.view = {
    center: center.map((n) => Math.round(n * 1e6) / 1e6),
    zoom: Math.round(zoom * 100) / 100,
    minZoom: Math.round(minZoom * 100) / 100,
    maxZoom: Math.round(maxZoom * 100) / 100,
    showNumbers: req.body?.showNumbers === true, // huisnummers standaard tonen voor bezoekers
  };
  store.save();
  res.json({ view: db.view });
});

// Weergave wissen: de site toont dan automatisch alle huizen.
admin.delete('/view', backups.afterSave('Kaartweergave gewist'), (req, res) => {
  store.db().view = null;
  store.save();
  res.json({ view: null });
});

// Kaartvlak van de PDF: midden + (geheel) zoomniveau. Zonder vlak toont de PDF automatisch alle huizen.
admin.put('/pdf-view', backups.afterSave('PDF-kaartvlak opgeslagen'), (req, res) => {
  const { center, zoom } = req.body || {};
  if (!validLatLng(center) || !Number.isInteger(zoom) || zoom < 1 || zoom > 19) {
    return res.status(400).json({ error: 'Ongeldig PDF-kaartvlak (zoom is een geheel getal van 1 tot 19)' });
  }
  const db = store.db();
  db.pdfView = { center: center.map((n) => Math.round(n * 1e6) / 1e6), zoom };
  store.save();
  res.json({ pdfView: db.pdfView });
});

admin.delete('/pdf-view', backups.afterSave('PDF-kaartvlak gewist'), (req, res) => {
  store.db().pdfView = null;
  store.save();
  res.json({ pdfView: null });
});

const validLatLng = (p) =>
  Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) && Math.abs(p[0]) <= 85.06 && Math.abs(p[1]) <= 180;

const clean = (s, n) => String(s ?? '').trim().slice(0, n);

function validateHouses(list) {
  if (!Array.isArray(list) || list.length > 2000) throw new Error('Ongeldige lijst met huizen');
  return list.map((h) => {
    if (!Array.isArray(h.points) || h.points.length < 3 || h.points.length > 200) throw new Error('Een huis heeft minimaal 3 punten nodig');
    const points = h.points.map((p) => {
      if (!validLatLng(p)) throw new Error('Ongeldig punt');
      return p.map((n) => Math.round(n * 1e7) / 1e7);
    });
    return normalizeHouse({ ...h, points });
  });
}

admin.put('/houses', backups.afterSave('Layout opgeslagen'), (req, res) => {
  try {
    const db = store.db();
    db.houses = validateHouses(req.body.houses);
    residents.reconcile();
    store.save();
    res.json({ houses: db.houses });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

admin.use(residents.admin);
app.use('/api/admin', admin);
app.use('/api/resident', residents.resident);
app.use('/api', (req, res) => res.status(404).json({ error: 'Niet gevonden' }));

// ---------- statische bestanden ----------
const pub = path.join(__dirname, '..', 'public');
const nm = (...p) => path.join(__dirname, '..', 'node_modules', ...p);
const vendorFile = (file) => (req, res) => res
  .set('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache')
  .sendFile(file, { cacheControl: false });
app.get('/vendor/webauthn.js', vendorFile(nm('@simplewebauthn', 'browser', 'dist', 'bundle', 'index.umd.min.js')));
app.get('/vendor/jspdf.js', vendorFile(nm('jspdf', 'dist', 'jspdf.umd.min.js')));
app.get('/vendor/qrcode.js', vendorFile(nm('qrcode-generator', 'dist', 'qrcode.js')));
app.use('/vendor/leaflet', express.static(nm('leaflet', 'dist'), {
  index: false,
  setHeaders: (res, file) => res.set('Cache-Control', res.req.query.v && /\.(js|css)$/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache'),
}));
// Elke build heeft een eigen versie-tag; die zit in de URL's van scripts en stijlen (cache-busting),
// zodat browsers, de service worker en een eventuele proxy/CDN nooit een oude JS bij nieuwe HTML serven.
const buildTag = `${appVersion.version}-${appVersion.build}`.replace(/[^\w.-]/g, '');
const noCache = { 'Cache-Control': 'no-cache' };
const page = (file) => (req, res) => {
  // De taalinstelling staat in de pagina zelf (meta), zodat de pagina meteen in de juiste taal verschijnt.
  const l = lang.defaultLang();
  const html = fs.readFileSync(file, 'utf8').replaceAll('{{v}}', buildTag)
    .replace('<html lang="nl">', `<html lang="${l}">`)
    .replace('</title>', `</title>\n<meta name="sm-lang" content="${l}"${lang.multilingual() ? ' data-multi="1"' : ''}>\n<meta name="sm-channel" content="${appVersion.channel}">`);
  res.set({ ...noCache, 'Content-Type': 'text/html; charset=utf-8' }).send(html);
};
app.get(['/', '/index.html'], page(path.join(pub, 'index.html')));
app.get(['/beheer', '/beheer/', '/admin/'], page(path.join(pub, 'admin', 'index.html')));

// De service worker krijgt de buildversie in zijn cachenaam, zodat een nieuwe build de oude caches opruimt.
app.get('/sw.js', (req, res) => {
  const src = fs.readFileSync(path.join(pub, 'sw.js'), 'utf8').replace(/const VERSION = '[^']*';/, `const VERSION = '${buildTag}';`);
  res.set({ ...noCache, 'Content-Type': 'application/javascript; charset=utf-8' }).send(src);
});
app.use(express.static(pub, {
  extensions: ['html'],
  index: false,
  // Met ?v=<build> is een bestand onveranderlijk voor die build; zonder versie altijd hercontroleren.
  setHeaders: (res, file) => {
    if (res.req.query.v && /\.(js|css)$/.test(file)) res.set('Cache-Control', 'public, max-age=31536000, immutable');
    else res.set(noCache);
  },
}));

module.exports = app;

if (require.main === module) {
  app.listen(config.port, () => {
    console.log(`Doorbell Map draait op poort ${config.port} (${config.origin}, rpID ${config.rpID})`);
    console.log(`Versie ${appVersion.label}`);
    if (config.setupTokenGenerated && !store.db().passkeys.length) {
      console.log(`\nINSTALLATIE: er is geen SETUP_TOKEN ingesteld. Tijdelijke code voor de eerste passkey:\n  ${config.setupToken}\n`);
    }
    if (config.sessionSecretGenerated) {
      console.warn('Let op: SESSION_SECRET niet ingesteld; sessies vervallen bij elke herstart.');
    }
  });
}
