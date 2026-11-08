'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const config = require('./config');
const store = require('./store');
const auth = require('./auth');
const users = require('./users');
const account = require('./account');
const backups = require('./backups');
const images = require('./images');
const editions = require('./editions');
const residents = require('./residents');
const community = require('./community');
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
// JSON tot 2 MB; een geüploade backup (met alle edities en de logo's) mag groter zijn en wordt pas ná de inlogcontrole gelezen.
const BACKUP_UPLOAD_LIMIT = '25mb';
const jsonBody = express.json({ limit: '2mb' });
app.use((req, res, next) => (req.path === '/api/admin/backups/import' ? next() : jsonBody(req, res, next)));
app.use(auth.sameOrigin);

const asyncRoute = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error(err);
    res.status(err.status || 400).json({ error: err.message || 'Er ging iets mis' });
  });

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
      communityTitle: t.communityTitle || '', communityText: t.communityText || '',
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
    intro: settings?.intro || '', logo: settings?.logo || null, logoSmall: settings?.logoSmall || null, favicon: settings?.favicon || null,
    multilingual: lang.multilingual(), defaultLang: lang.defaultLang(),
    translations: publicTranslations(),
    appName: settings?.appName || '', appShortName: settings?.appShortName || '',
    residentsEnabled: residents.mode() !== 'closed', // ook 'swap': dan blijft de knop zichtbaar voor wie al een huis heeft
    residentsMode: residents.mode(),
    simpleUi: settings?.simpleUi === true,
    communityEnabled: settings?.communityEnabled === true, // live deelnemers op de kaart (standaard uit)
    communityLooks: community.looksEnabled(), // deelnemers kiezen zelf een kleur en symbool (standaard aan)
    communityTitle: community.title('nl'), communityText: community.text('nl'), // het vlakje "Positie delen met de community?"
    locateEnabled: settings?.locateEnabled !== false, // knop "Mijn locatie" op de kaart (standaard beschikbaar, maar uit tot erop getikt wordt)
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

// Icoontjes van de geïnstalleerde app: het ingestelde favicon als dat vierkant is en minstens 192 px meet, anders de standaardlantaarn.
// (Een upload wordt niet geschaald; daarom staat in het beheer dat 512 x 512 px het best is.)
function manifestIcons() {
  const f = store.db().settings?.favicon;
  if (f?.width && f.width === f.height && f.width >= 192) return [{ src: f.url, sizes: `${f.width}x${f.height}`, type: f.type, purpose: 'any' }];
  return [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ];
}

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
    icons: manifestIcons(),
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
// Inloggen, de installatie-wizard en uitnodigingen staan in account.js.
users.migrate();
app.use('/api/auth', account.pub);
app.use('/api/invites', account.invites);

// ---------- beheer ----------
const admin = express.Router();
admin.use(auth.requireAdmin);
admin.use(account.admin); // eigen inlog (passkeys, wachtwoord, MFA), bevestigen en gebruikersbeheer

const pwError = (res, err) => res.status(err.status || 400).json({ error: err.message });

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

// De backup zoals hij in DATA_PATH/backups staat: een ZIP met backup.json en de logo's.
admin.get('/backups/:id', (req, res) => {
  const z = backups.zipFile(req.params.id);
  if (!z) return res.status(404).json({ error: 'Backup niet gevonden' });
  res.attachment(z.name);
  res.type('application/zip');
  res.sendFile(z.name, { root: z.dir });
});

// Maakt van een geüploade backup een schone inhoud ({houses, view, pdfView, texts, settings, devices, blocked, editions}); gooit een Error bij
// ongeldige inhoud. De logo's controleert backups.parseUpload.
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
  // infovlak, deeltekst en communityvlak (backups van vóór de ZIP hebben ze niet; terugzetten laat ze dan staan)
  for (const f of backups.EXTRA_TEXTS) {
    if (!(f in t)) continue;
    texts[f] = f === 'residentInfo' && t[f] === null ? null : txt(t, f); // null: de standaardtekst van het infovlak
  }
  for (const l of lang.LANGS) {
    const o = t.translations?.[l];
    if (!o || typeof o !== 'object' || l === 'nl') continue;
    texts.translations[l] = { siteTitle: txt(o, 'siteTitle'), appName: txt(o, 'appName'), appShortName: txt(o, 'appShortName'), intro: txt(o, 'intro'), residentInfo: txt(o, 'residentInfo'), qrShareText: txt(o, 'qrShareText'), communityTitle: txt(o, 'communityTitle'), communityText: txt(o, 'communityText'), labels: labelsOf(o.labels) };
  }
  // edities (backups van vóór de edities hebben dit veld niet; terugzetten laat de edities dan met rust)
  let eds;
  if (b.editions !== undefined) {
    if (!Array.isArray(b.editions) || b.editions.length > editions.MAX_EDITIONS) throw new Error('De edities in de backup zijn ongeldig');
    const seen = new Set();
    eds = b.editions.map((e) => {
      const clean = editions.sanitize(e, validateHouses);
      if (seen.has(clean.id)) clean.id = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
      seen.add(clean.id);
      return clean;
    });
  }
  // app-instellingen, apparaten en geblokkeerde apparaten (backups van vóór de ZIP hebben ze niet)
  return { houses, view, pdfView, texts, ...backups.cleanSections(b), ...(eds ? { editions: eds } : {}) };
}

// Een gedownloade backup weer uploaden: komt als nieuwe backup in de lijst; terugzetten blijft een aparte stap.
// Het bestand komt zoals het is (een .zip, of een .json van vóór de ZIP); de eerste bytes bepalen welke soort het is.
admin.post('/backups/import', express.raw({ type: () => true, limit: BACKUP_UPLOAD_LIMIT }), (req, res) => {
  try {
    const { doc, files } = backups.parseUpload(req.body);
    res.json({ id: backups.importData(sanitizeBackup(doc), files, doc.title) });
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
  let done;
  try { done = backups.restore(req.params.id); } catch (err) { return res.status(400).json({ error: err.message }); }
  if (!done) return res.status(404).json({ error: 'Backup niet gevonden' });
  res.json({ ok: true });
});

// Verwijderen vereist bevestiging met een passkey.
admin.post('/backups/delete', asyncRoute(async (req, res) => {
  const idsToDelete = req.body.ids;
  if (!Array.isArray(idsToDelete) || !idsToDelete.length || idsToDelete.length > 500 || !idsToDelete.every((i) => typeof i === 'string' && backups.ID.test(i))) {
    return res.status(400).json({ error: 'Geen geldige backups geselecteerd' });
  }
  try { await account.confirm(req); } catch (err) { return pwError(res, err); }
  res.json({ deleted: backups.remove(idsToDelete) });
}));

// ---------- edities: eerdere keren, met naam en jaartal, om met de live kaart te vergelijken ----------
admin.get('/editions', (req, res) => res.json(editions.list()));

admin.get('/editions/:id', (req, res) => {
  const e = editions.read(req.params.id);
  if (!e) return res.status(404).json({ error: 'Editie niet gevonden' });
  res.json(e);
});

// Nieuwe editie als kopie van de live kaart (from: 'live') of van een andere editie (from: id). De live kaart
// wordt alleen gelezen; een backup kan geen bron zijn.
admin.post('/editions', backups.afterSave('Editie aangemaakt'), (req, res) => {
  const body = req.body || {};
  const from = body.from === undefined || body.from === null || body.from === '' ? editions.LIVE : body.from;
  let houses, label;
  if (from === editions.LIVE) {
    houses = store.db().houses; label = 'Live';
  } else {
    const src = typeof from === 'string' ? editions.read(from) : null;
    if (!src) return res.status(404).json({ error: 'De editie om te kopiëren bestaat niet (meer)' });
    houses = src.houses; label = editions.label(src);
  }
  try {
    const e = editions.create(body, houses, { id: from, label });
    res.json({ id: e.id, name: e.name, year: e.year, counts: e.counts });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// De huizen van één editie opslaan (vanuit het bewerkscherm of de popup). Schrijft alleen in die editie, nooit in de live kaart.
admin.put('/editions/:id/houses', backups.afterSave('Editie opgeslagen'), (req, res) => {
  try {
    const e = editions.setHouses(req.params.id, validateHouses(req.body?.houses));
    if (!e) return res.status(404).json({ error: 'Editie niet gevonden' });
    res.json({ id: e.id, counts: e.counts, houses: e.houses });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

admin.put('/editions/:id', backups.afterSave('Editie hernoemd'), (req, res) => {
  try {
    const e = editions.update(req.params.id, req.body || {});
    if (!e) return res.status(404).json({ error: 'Editie niet gevonden' });
    res.json({ id: e.id, name: e.name, year: e.year });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Verwijderen vereist bevestiging met een passkey (net als bij backups).
admin.post('/editions/delete', backups.afterSave('Edities verwijderd'), asyncRoute(async (req, res) => {
  const idsToDelete = req.body.ids;
  if (!Array.isArray(idsToDelete) || !idsToDelete.length || idsToDelete.length > editions.MAX_EDITIONS || !idsToDelete.every((i) => typeof i === 'string' && editions.ID.test(i))) {
    return res.status(400).json({ error: 'Geen geldige edities geselecteerd' });
  }
  try { await account.confirm(req); } catch (err) { return pwError(res, err); }
  res.json({ deleted: editions.remove(idsToDelete) });
}));

// Het logo (PDF, QR-kaartjes), het kleine logo (kopbalk) en het favicon worden op dezelfde manier bewaard; de laatste twee zijn optioneel.
// Ze gaan mee in de backups, dus na een wijziging komt er een backup (net als bij de andere instellingen).
for (const { route, key, prefix, name } of images.LOGOS) {
  admin.post(route,
    backups.afterSave(`${name} opgeslagen`),
    express.raw({ type: 'application/octet-stream', limit: images.MAX_IMAGE }),
    (req, res) => {
      const buf = req.body;
      const ext = images.detect(buf);
      if (!ext) return res.status(400).json({ error: 'Alleen PNG, JPEG of WebP is toegestaan (max 5 MB)' });
      const db = store.db();
      const old = db.settings[key];
      const file = `${prefix}-${Date.now()}.${ext}`;
      fs.writeFileSync(path.join(store.uploadDir, file), buf);
      db.settings[key] = images.setting(key, file, buf, ext);
      store.save();
      images.remove(old);
      res.json({ [key]: db.settings[key] });
    });

  admin.delete(route, backups.afterSave(`${name} verwijderd`), (req, res) => {
    const db = store.db();
    images.remove(db.settings[key]);
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
  res.json({ residentInfo: residents.info(), residentsOff: s.residentsOff === true, residentsUntil: s.residentsUntil || null, residentsSwapAfter: s.residentsSwapAfter === true, residentsGeofence: s.residentsGeofence === true, simpleUi: s.simpleUi === true, locateEnabled: s.locateEnabled !== false, communityEnabled: s.communityEnabled === true, communityLooks: community.looksEnabled(), communityTitle: s.communityTitle || '', communityText: s.communityText || '', defaultCommunity: community.defaults(), statsPublic: s.statsPublic === true, statsShow: statsShow(s), residentsQrOnly: s.residentsQrOnly === true, residentsCodeOn: s.residentsCodeOn === true, residentsCode: s.residentsCode || '', residentsGeofenceRadius: residents.geofence().radius, multilingual: lang.multilingual(), defaultLang: lang.defaultLang(), qrShareText: s.qrShareText || '', translations: tx, defaultShareTexts: residents.defaultShareTexts(), defaultInfo: residents.DEFAULT_INFO });
});

// Tekstvelden met hun maximale lengte; gelden voor het Nederlands (gewone instellingen) en voor elke vertaling.
const TEXT_RULES = {
  siteTitle: { max: 60, error: 'De naam van de site mag maximaal 60 tekens zijn' },
  appName: { max: 45, error: 'De naam van de app mag maximaal 45 tekens zijn' },
  appShortName: { max: 12, error: 'De korte naam mag maximaal 12 tekens zijn (past onder het icoon)' },
  intro: { max: 5000, multiline: true, error: 'De uitleg mag maximaal 5000 tekens zijn' },
  residentInfo: { max: 1000, multiline: true, error: 'Het infovlak mag maximaal 1000 tekens zijn' },
  qrShareText: { max: 500, multiline: true, error: 'De deeltekst mag maximaal 500 tekens zijn' },
  communityTitle: { max: 80, error: 'De titel van het communityvlak mag maximaal 80 tekens zijn' },
  communityText: { max: 1000, multiline: true, error: 'De tekst van het communityvlak mag maximaal 1000 tekens zijn' },
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
  for (const f of ['intro', 'residentInfo', 'qrShareText', 'communityTitle', 'communityText']) {
    if (!(f in body)) continue;
    const r = cleanText(f, body[f]);
    if (r.error) return res.status(400).json({ error: r.error });
    db.settings[f] = r.value; // qrShareText, communityTitle en communityText: leeg = standaardtekst
  }
  if ('communityLooks' in body) {
    db.settings.communityLooks = body.communityLooks === true;
    // uit: de deelnemers verschijnen meteen als standaardstip (listOthers geeft dan geen kleur of symbool meer mee)
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
  if ('locateEnabled' in body) db.settings.locateEnabled = body.locateEnabled === true;
  if ('communityEnabled' in body) {
    db.settings.communityEnabled = body.communityEnabled === true;
    if (!db.settings.communityEnabled) community.clear(); // uitzetten wist meteen alle posities
  }
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
  // Teksten in andere talen: { en: { siteTitle, appName, appShortName, intro, residentInfo, qrShareText, communityTitle, communityText, labels: { green, red, none } } }
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

admin.get('/community', community.adminList);
admin.use(residents.admin);
app.use('/api/admin', admin);
app.use('/api/resident', residents.resident);
app.use('/api/community', community.router);
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
    const where = config.origin ? `${config.origin}, rpID ${config.rpID}` : 'adres volgt de aanvraag; geen ORIGIN ingesteld';
    console.log(`Doorbell Map draait op poort ${config.port} (${where})`);
    console.log(`Versie ${appVersion.label}`);
    console.log(store.startupReport());
    if (config.setupTokenGenerated && !users.configured()) {
      console.log(`\nINSTALLATIE: er is geen SETUP_TOKEN ingesteld. Tijdelijke installatiecode voor de eerste inlog:\n  ${config.setupToken}\n`);
    }
    if (config.sessionSecretGenerated) {
      console.warn('Let op: SESSION_SECRET niet ingesteld; sessies vervallen bij elke herstart.');
    }
  });
}
