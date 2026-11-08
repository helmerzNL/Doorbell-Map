'use strict';
// Bewoners wijzigen via de geïnstalleerde app de status van hun eigen huis; de beheerder keurt dat goed.
// Per apparaat (cookie) hoort er maximaal één huis bij. Wijzigingen zijn pas zichtbaar na goedkeuring.
const crypto = require('node:crypto');
const express = require('express');
const config = require('./config');
const origin = require('./origin');
const store = require('./store');
const auth = require('./auth');
const backups = require('./backups');
const audit = require('./audit');
const push = require('./push');
const { tr, trIn, t, defaultLang, translations, LANGS } = require('./lang');
const { STATUSES, statusLabels } = require('./houses');

const COOKIE = 'sm_resident';
const MAX_RESIDENTS = 3000;
const MAX_PENDING = 500;
const MAX_MESSAGES = 200, MAX_MESSAGE_LEN = 300;
const statusName = (k) => tr(statusLabels(store.db().settings, defaultLang())[k]).toLowerCase();

const db = () => store.db();
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const houseOf = (id) => db().houses.find((h) => h.id === id);
const titleOf = (h) => [h.street, h.number].filter(Boolean).join(' ') || 'Huis';
// Instellingen zoals de beheerder ze bewaarde (de twee schakelaars onder "Wijzigen van bewoners").
const storedEnabled = () => db().settings?.residentsEnabled !== false;
const storedAppOnly = () => db().settings?.residentsAppOnly === true;
// Planning: staat die aan, dan beslist alleen de datum/tijd. Tot dan kan elke bewoner wijzigen (browser én app),
// daarna staat wijzigen uit. De twee schakelaars worden in die tijd genegeerd (en in het beheer uitgeschakeld).
const untilMs = () => {
  const s = db().settings;
  if (s?.residentsOff !== true) return null;
  const t = Date.parse(s.residentsUntil || '');
  return Number.isFinite(t) ? t : null;
};
const scheduled = () => untilMs() !== null;
// Na de einddatum kan de beheerder nog toestaan dat bewoners hun eigen huis wisselen tussen groen en rood.
const swapAfter = () => db().settings?.residentsSwapAfter === true;
// 'open' = alles mag, 'swap' = alleen eigen huis groen <-> rood, 'closed' = niets
const mode = () => {
  if (scheduled()) return Date.now() < untilMs() ? 'open' : (swapAfter() ? 'swap' : 'closed');
  return storedEnabled() ? 'open' : 'closed';
};
const enabled = () => mode() === 'open';
const appOnly = () => (scheduled() ? false : storedAppOnly());
const DEFAULT_INFO = 'Woon je in de wijk? Dan kun je in deze app zelf de status van jouw huis aanpassen. Tik op "Mijn huis", kies jouw huis en geef aan of het wel of niet is bezocht. Een wijziging wordt pas zichtbaar nadat de beheerder die heeft goedgekeurd.';
const DEFAULT_SHARE_TEXT = 'Hallo! Dit is de persoonlijke link om jouw huis ({adres}) te koppelen in de wijkapp. Open de link op je telefoon: {link}';
// Tekst bij delen via WhatsApp in een taal: de eigen tekst van die taal, anders de standaardtekst in die taal.
const shareText = (l = defaultLang()) => {
  const own = l === 'nl' ? db().settings?.qrShareText : translations(l).qrShareText;
  return typeof own === 'string' && own.trim() ? own : trIn(l, DEFAULT_SHARE_TEXT);
};
const shareTexts = () => Object.fromEntries(LANGS.map((l) => [l, shareText(l)]));
const defaultShareTexts = () => Object.fromEntries(LANGS.map((l) => [l, trIn(l, DEFAULT_SHARE_TEXT)]));
// Infovlak: standaard de Nederlandse tekst (of de standaardtekst); met een taal de eigen tekst van die taal als die er is.
const info = (l = 'nl') => {
  const own = l === 'nl' ? '' : translations(l).residentInfo;
  if (typeof own === 'string' && own.trim()) return own;
  const t = db().settings?.residentInfo;
  return typeof t === 'string' ? t : DEFAULT_INFO;
};

// Verwijdert aanmeldingen en wijzigingen van huizen die niet meer bestaan.
function prune() {
  const d = db();
  const ids = new Set(d.houses.map((h) => h.id));
  d.residents = d.residents.filter((r) => ids.has(r.houseId));
  const rids = new Set(d.residents.map((r) => r.rid));
  d.proposals = d.proposals.filter((p) => rids.has(p.residentId) && ids.has(p.houseId));
  for (const id of Object.keys(d.houseSecrets || {})) if (!ids.has(id)) delete d.houseSecrets[id]; // geheimen van verwijderde huizen
}

// Na een wijziging door de beheerder: beheer wint altijd. Een voorstel dat nu overbodig is verdwijnt,
// de rest krijgt de actuele status als uitgangspunt.
function reconcile() {
  prune();
  const d = db();
  for (const prop of [...d.proposals]) {
    const house = houseOf(prop.houseId);
    if (prop.to === house.status) {
      const rec = d.residents.find((r) => r.rid === prop.residentId);
      if (rec) rec.notice = { decision: 'approved', status: prop.to, at: new Date().toISOString() };
      d.proposals = d.proposals.filter((p) => p !== prop);
    } else {
      prop.from = house.status;
    }
  }
}

function currentResident(req) {
  const token = auth.parseCookies(req.headers.cookie)[COOKIE];
  if (!token || token.length < 20) return null;
  const hash = sha(token);
  const rec = db().residents.find((r) => auth.safeEqual(r.tokenHash, hash));
  return rec && houseOf(rec.houseId) ? rec : null;
}

// ---- geofence: wijzigen alleen als het apparaat (volgens GPS/wifi-locatie) in de wijk is ----
const GEO_DEFAULT_RADIUS = 500, GEO_MIN = 50, GEO_MAX = 5000;
const GEO_MAX_ACC = 200; // een telefoon/tablet moet een GPS-achtige fix hebben (m)
function geoCenter() {
  const d = db();
  const c = d.view?.center;
  if (Array.isArray(c) && c.length === 2 && c.every(Number.isFinite)) return [c[0], c[1]];
  const pts = d.houses.flatMap((h) => h.points || []);
  if (!pts.length) return null;
  return [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
}
const geofence = () => {
  const s = db().settings || {};
  const radius = Math.min(GEO_MAX, Math.max(GEO_MIN, Number(s.residentsGeofenceRadius) || GEO_DEFAULT_RADIUS));
  const center = geoCenter();
  return { on: s.residentsGeofence === true && !!center, radius, center };
};
const distanceM = (a, b) => { // haversine
  const R = 6371000, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b[0] - a[0]), dLng = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
// De locatie komt van het apparaat zelf (kop X-Geo: lat,lng,nauwkeurigheid in m). De server kan die niet
// controleren: het is een gebruiksbeperking tegen "even vanaf de bank", geen harde beveiliging.
function geoCheck(req) {
  const g = geofence();
  if (!g.on) return null;
  // Laptops en desktops (geen GPS) worden niet beperkt: zij melden zich als 'desktop' en hebben ook geen mobiele user-agent.
  if (req.get('X-Geo-Device') === 'desktop' && !/android|iphone|ipad|ipod|mobile/i.test(req.get('User-Agent') || '')) return null;
  const m = /^(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?),(\d{1,6}(?:\.\d+)?)$/.exec(String(req.get('X-Geo') || ''));
  if (!m) return { geofence: 'missing', error: 'Wijzigen kan alleen in de wijk. Sta toegang tot je locatie toe en probeer het opnieuw.' };
  const pos = [Number(m[1]), Number(m[2])], acc = Number(m[3]);
  if (Math.abs(pos[0]) > 90 || Math.abs(pos[1]) > 180) return { geofence: 'missing', error: 'Ongeldige locatie' };
  if (acc > GEO_MAX_ACC) return { geofence: 'inaccurate', error: `Je GPS-locatie is niet nauwkeurig genoeg (ongeveer ${Math.round(acc)} m). Zet GPS aan, ga naar buiten en probeer het opnieuw.` };
  const dist = distanceM(pos, g.center);
  if (dist - acc > g.radius) return { geofence: 'outside', error: `Je lijkt niet in de wijk te zijn (ongeveer ${Math.round(dist / 10) * 10} m van het midden). Wijzigen kan alleen in de wijk.` };
  return null;
}

// ---- QR-code per huis: een geheim dat niet in /api/map staat (de huis-id's zijn openbaar) ----
const secrets = () => (db().houseSecrets ||= {});
const secretOf = (id) => (secrets()[id] ||= crypto.randomBytes(16).toString('base64url'));
const houseOfSecret = (q) => {
  if (typeof q !== 'string' || q.length < 16 || q.length > 64) return null;
  for (const [id, sec] of Object.entries(secrets())) if (auth.safeEqual(sec, q)) return houseOf(id) || null;
  return null;
};
const qrOnly = () => db().settings?.residentsQrOnly === true;
const houseTaken = (id) => db().residents.some((r) => r.houseId === id);

// ---- toegangscode voor apparaten zonder GPS (de code wordt in de buurtapp gedeeld) ----
const CODE_COOKIE = 'sm_code';
const codeSetting = () => String(db().settings?.residentsCode || '');
const codeOn = () => db().settings?.residentsCodeOn === true && /^\d{4,6}$/.test(codeSetting());
// Zonder GPS = desktop/laptop: meldt zich als 'desktop' en heeft geen mobiele user-agent (zelfde regel als bij de geofence).
const isNonGps = (req) => req.get('X-Geo-Device') === 'desktop' && !/android|iphone|ipad|ipod|mobile/i.test(req.get('User-Agent') || '');
// De cookie bevat een hash van de code: een gewijzigde code maakt alle oude cookies ongeldig.
const codeToken = () => crypto.createHmac('sha256', config.sessionSecret).update(`devcode:${codeSetting()}`).digest('base64url');
const codeOk = (req) => {
  if (!codeOn()) return true;
  const c = auth.parseCookies(req.headers.cookie)[CODE_COOKIE];
  return !!c && auth.safeEqual(c, codeToken());
};

function setCodeCookie(req, res) {
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${365 * 24 * 3600}`];
  if (origin.secureCookie(req)) flags.push('Secure');
  res.append('Set-Cookie', `${CODE_COOKIE}=${codeToken()}; ${flags.join('; ')}`);
}

// Geblokkeerde apparaten (cookie/token) en IP-adressen mogen niet meer wijzigen of een huis kiezen.
function isBlocked(req) {
  const list = db().blocked || [];
  if (!list.length) return false;
  const hashes = new Set();
  const cookie = auth.parseCookies(req.headers.cookie)[COOKIE];
  if (cookie) hashes.add(sha(cookie));
  const t = req.body?.token;
  if (typeof t === 'string' && t) hashes.add(sha(t));
  return list.some((b) => (b.tokenHash && hashes.has(b.tokenHash)) || (b.ip && b.ip === req.ip));
}

const proposalOf = (rec) => db().proposals.find((p) => p.residentId === rec.rid);

function view(rec, req) {
  const house = houseOf(rec.houseId);
  const prop = proposalOf(rec);
  return {
    enabled: enabled(),
    mode: mode(),
    codeOk: req ? codeOk(req) : true,
    qrOnly: qrOnly(),
    claim: { houseId: house.id, title: titleOf(house) },
    approved: house.status,
    effective: prop ? prop.to : house.status,
    pending: !!prop,
    notice: rec.notice || null,
  };
}

function setCookie(req, res, token) {
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${365 * 24 * 3600}`];
  if (origin.secureCookie(req)) flags.push('Secure');
  res.append('Set-Cookie', `${COOKIE}=${token}; ${flags.join('; ')}`);
}

// ---- pushmelding aan de beheerder (samengevoegd: hooguit één melding per paar seconden) ----
let timer = null;
// Aantal dingen dat op de beheerder wacht: wijzigingen ter goedkeuring + berichten van bewoners (voor de badges).
const waiting = () => ({ pending: db().proposals.length, messages: (db().messages || []).length });
const badgeTotal = () => { const w = waiting(); return w.pending + w.messages; };

function notifyAdmin() {
  if (timer) return;
  timer = setTimeout(async () => {
    timer = null;
    const { pending, messages } = waiting();
    if (!pending && !messages) return;
    let title = t('Wijziging ter goedkeuring'), body;
    const nChanges = pending === 1 ? t('1 wijziging') : t('{n} wijzigingen', { n: pending });
    const nMessages = messages === 1 ? t('1 bericht') : t('{n} berichten', { n: messages });
    if (pending && messages) body = t('{w} en {m} wachten op je', { w: nChanges, m: nMessages });
    else if (messages) {
      title = t('Bericht van een bewoner');
      const last = db().messages[db().messages.length - 1];
      body = messages === 1 ? `${last.ownTitle || last.scannedTitle || tr('Bewoner')}: ${last.text}`.slice(0, 120) : t('{n} berichten van bewoners', { n: messages });
    } else {
      const first = db().proposals[0];
      const h = houseOf(first.houseId);
      body = pending === 1 && h ? t('{huis}: {status} aangevraagd', { huis: titleOf(h), status: statusName(first.to) }) : t('{n} wijzigingen wachten op goedkeuring', { n: pending });
    }
    try { await push.send({ title, body, url: '/beheer#changes', tag: 'wijzigingen', badge: pending + messages }); }
    catch (err) { console.error('Melding mislukt:', err.message); }
  }, Number(process.env.PUSH_DELAY_MS ?? 5000));
}

// ---------- publiek: voor bewoners ----------
const resident = express.Router();

resident.use((req, res, next) => {
  const m = mode();
  if (m === 'closed') return res.status(403).json({ error: 'Wijzigen door bewoners staat uit', enabled: false });
  // na de einddatum: alleen bestaande koppelingen en alleen wisselen tussen groen en rood
  if (m === 'swap' && !(req.path === '/me' || ['/set', '/restore', '/ack', '/code', '/message', '/qr/lookup'].includes(req.path))) {
    return res.status(403).json({ error: 'Wijzigen is gesloten; je kunt alleen nog je eigen huis wisselen tussen groen en rood', mode: m });
  }
  if (isBlocked(req)) {
    if (req.method === 'GET') return res.json({ enabled: true, claim: null, blocked: true });
    return res.status(403).json({ error: 'Dit apparaat is geblokkeerd door de beheerder', blocked: true });
  }
  if (req.method !== 'GET' && (req.path === '/claim' || req.path === '/set')) {
    const viaQr = req.path === '/claim' && !!houseOfSecret(req.body?.q); // een geldige QR vervangt de toegangscode
    if (codeOn() && isNonGps(req) && !codeOk(req) && !viaQr) {
      return res.status(403).json({ code: 'required', error: 'Voer eerst de toegangscode in (die is gedeeld in de buurtapp).' });
    }
    const bad = geoCheck(req);
    if (bad) return res.status(403).json(bad);
  }
  if (req.method !== 'GET') {
    // Alleen in de geïnstalleerde app: de app meldt zich met X-App-Mode. Dit is een gebruiksbeperking
    // (de browser stuurt de kop niet); de server kan niet bewijzen dat een client echt een app is.
    if (appOnly() && req.path !== '/message' && req.get('X-App-Mode') !== 'standalone') { // een bericht aan de beheerder mag altijd
      return res.status(403).json({ error: 'Wijzigen kan alleen in de geïnstalleerde app', appOnly: true });
    }
    const key = `resident:${req.ip}`;
    if (auth.limiter.blocked(key, 120)) return res.status(429).json({ error: 'Te veel verzoeken, probeer het later opnieuw' });
    auth.limiter.fail(key); // telt elk schrijfverzoek
  }
  next();
});

resident.get('/me', (req, res) => {
  const rec = currentResident(req);
  res.json(rec ? view(rec, req) : { enabled: enabled(), mode: mode(), claim: null, codeOk: codeOk(req), qrOnly: qrOnly() });
});

// Toegangscode voor apparaten zonder GPS: eenmalig invullen, daarna onthoudt dit apparaat het (cookie, 1 jaar).
resident.post('/code', (req, res) => {
  if (!codeOn()) return res.json({ ok: true });
  const key = `code:${req.ip}`;
  if (auth.limiter.blocked(key, 10)) return res.status(429).json({ error: 'Te veel pogingen, probeer het later opnieuw' });
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  if (!auth.safeEqual(code, codeSetting())) { auth.limiter.fail(key); return res.status(403).json({ error: 'Onjuiste code' }); }
  auth.limiter.reset(key);
  setCodeCookie(req, res);
  res.json({ ok: true });
});

// Dit apparaat koppelen aan één huis.
// Controleer een QR-geheim (met begrenzing op foute pogingen per IP).
function lookupQr(req, res) {
  const key = `qr:${req.ip}`;
  if (auth.limiter.blocked(key, 20)) { res.status(429).json({ error: 'Te veel pogingen, probeer het later opnieuw' }); return null; }
  const house = houseOfSecret(req.body?.q);
  if (!house) { auth.limiter.fail(key); res.status(403).json({ error: 'Deze QR-code is ongeldig of vervangen. Vraag de beheerder om een nieuwe.' }); return null; }
  return house;
}

// Voor de bevestiging in de pagina: bij welk huis hoort deze QR?
resident.post('/qr/lookup', (req, res) => {
  const house = lookupQr(req, res);
  if (!house) return;
  res.json({ houseId: house.id, title: titleOf(house), taken: houseTaken(house.id) });
});

// Kort bericht aan de beheerder (bijv. na het scannen van een QR-code met een apparaat dat al gekoppeld is).
resident.post('/message', (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.replace(/\s+/g, ' ').trim() : '';
  if (!text) return res.status(400).json({ error: 'Typ eerst een bericht' });
  if (text.length > MAX_MESSAGE_LEN) return res.status(400).json({ error: `Een bericht mag maximaal ${MAX_MESSAGE_LEN} tekens zijn` });
  const key = `msg:${req.ip}`;
  if (auth.limiter.blocked(key, 5)) return res.status(429).json({ error: 'Je hebt net al een paar berichten gestuurd. Probeer het later opnieuw.' });
  const rec = currentResident(req);
  const scanned = req.body?.q ? houseOfSecret(req.body.q) : null;
  const d = db();
  d.messages = d.messages || [];
  if (d.messages.length >= MAX_MESSAGES) return res.status(503).json({ error: 'Er staan te veel berichten open. Probeer het later opnieuw.' });
  auth.limiter.fail(key); // telt elk bericht
  d.messages.push({ id: crypto.randomBytes(6).toString('hex'), createdAt: new Date().toISOString(), text,
    ownTitle: rec ? titleOf(houseOf(rec.houseId)) : null, scannedTitle: scanned ? titleOf(scanned) : null, ip: req.ip });
  store.save();
  notifyAdmin();
  res.json({ ok: true });
});

// Dit apparaat koppelen aan één huis: met de QR-code van dat huis (of, als dat niet verplicht is, via de kaart).
resident.post('/claim', (req, res) => {
  if (currentResident(req)) return res.status(409).json({ error: 'Dit apparaat is al aan een huis gekoppeld' });
  const viaQr = typeof req.body?.q === 'string' && req.body.q !== '';
  let house;
  if (viaQr) { house = lookupQr(req, res); if (!house) return; }
  else {
    if (qrOnly()) return res.status(403).json({ qr: 'required', error: 'Scan de QR-code uit je brief om jouw huis te kiezen.' });
    house = houseOf(String(req.body?.houseId || ''));
  }
  if (!house) return res.status(404).json({ error: 'Huis niet gevonden' });
  // met QR hoort er één apparaat bij een huis; de beheerder kan een koppeling verwijderen
  if ((viaQr || qrOnly()) && houseTaken(house.id)) return res.status(409).json({ error: 'Dit huis is al aan een ander apparaat gekoppeld. Neem contact op met de beheerder.' });
  if (db().residents.length >= MAX_RESIDENTS) return res.status(503).json({ error: 'Op dit moment zijn er te veel aanmeldingen' });
  const token = crypto.randomBytes(32).toString('base64url');
  const rec = { rid: crypto.randomBytes(6).toString('hex'), tokenHash: sha(token), houseId: house.id, createdAt: new Date().toISOString(), lastActivity: new Date().toISOString(), ip: req.ip, notice: null };
  db().residents.push(rec);
  store.save();
  audit.house(audit.device(rec.rid), 'device-linked', house, { via: viaQr ? 'qr' : 'list' });
  setCookie(req, res, token);
  if (viaQr && codeOn()) setCodeCookie(req, res); // een geldige QR vervangt de toegangscode
  res.json({ ...view(rec, req), deviceToken: token }); // de app bewaart dit ook lokaal, zodat de koppeling een gewiste cookie overleeft
});

// Koppeling herstellen met het lokaal bewaarde token (als de cookie van de app is verdwenen).
resident.post('/restore', (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  if (token.length < 20 || token.length > 100) return res.status(400).json({ error: 'Ongeldig token' });
  const hash = sha(token);
  const rec = db().residents.find((r) => auth.safeEqual(r.tokenHash, hash));
  if (!rec || !houseOf(rec.houseId)) return res.status(404).json({ error: 'Koppeling niet gevonden' });
  setCookie(req, res, token);
  res.json(view(rec, req));
});

// Gewenste status voor het eigen huis voorstellen (de beheerder moet dit nog goedkeuren).
resident.post('/set', (req, res) => {
  const rec = currentResident(req);
  if (!rec) return res.status(401).json({ error: 'Kies eerst jouw huis' });
  const status = req.body?.status;
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Ongeldige status' });
  const house = houseOf(rec.houseId);
  if (mode() === 'swap' && !(status !== 'none' && house.status !== 'none')) {
    return res.status(403).json({ error: 'Na de einddatum kun je alleen nog wisselen tussen groen en rood', mode: 'swap' });
  }
  const d = db();
  const prop = proposalOf(rec);
  let changed = false;
  if (status === house.status) {
    if (prop) { d.proposals = d.proposals.filter((p) => p !== prop); changed = true; }
  } else if (prop) {
    changed = prop.to !== status;
    prop.to = status; prop.from = house.status; prop.updatedAt = new Date().toISOString();
  } else {
    if (d.proposals.length >= MAX_PENDING) return res.status(503).json({ error: 'Er wachten te veel wijzigingen op goedkeuring' });
    d.proposals.push({ id: crypto.randomBytes(6).toString('hex'), residentId: rec.rid, houseId: house.id, from: house.status, to: status, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    changed = true;
  }
  rec.lastActivity = new Date().toISOString();
  rec.ip = req.ip;
  rec.notice = null;
  store.save();
  // elke wijziging van een bewoner, ook als die zijn voorstel weer intrekt: zo is te zien hoe vaak een apparaat iets aanpast
  if (changed) audit.house(audit.device(rec.rid), status === house.status ? 'proposal-withdrawn' : 'proposed', house, { from: house.status, to: status });
  if (changed && status !== house.status) notifyAdmin();
  res.json(view(rec, req));
});

resident.post('/ack', (req, res) => {
  const rec = currentResident(req);
  if (!rec) return res.status(401).json({ error: 'Niet aangemeld' });
  rec.notice = null;
  store.save();
  res.json({ ok: true });
});

// ---------- beheer ----------
const admin = express.Router();

const list = () => {
  prune();
  const d = db();
  const rows = d.proposals.map((p) => {
    const h = houseOf(p.houseId);
    return { id: p.id, rid: p.residentId, houseId: p.houseId, title: titleOf(h), from: p.from, to: p.to, updatedAt: p.updatedAt };
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const residents = d.residents.map((r) => ({ rid: r.rid, houseId: r.houseId, title: titleOf(houseOf(r.houseId)), createdAt: r.createdAt, lastActivity: r.lastActivity, ip: r.ip || null }))
    .sort((a, b) => a.title.localeCompare(b.title, 'nl', { numeric: true, sensitivity: 'base' })); // alfabetisch (straat, dan huisnummer), makkelijk zoeken
  const blocked = (d.blocked || []).map((b) => ({ id: b.id, title: b.title, ip: b.ip || null, at: b.at }))
    .sort((a, b) => String(a.title).localeCompare(String(b.title), 'nl', { numeric: true, sensitivity: 'base' }));
  const messages = (d.messages || []).map((m) => ({ id: m.id, createdAt: m.createdAt, text: m.text, ownTitle: m.ownTitle, scannedTitle: m.scannedTitle })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { messages, qrOnly: qrOnly(), shareTexts: shareTexts(), defaultShareTexts: defaultShareTexts(), enabled: storedEnabled(), appOnly: storedAppOnly(), code: { on: db().settings?.residentsCodeOn === true, code: codeSetting() }, geofence: { on: db().settings?.residentsGeofence === true, radius: geofence().radius, hasCenter: !!geoCenter() }, schedule: { swap: swapAfter(), on: db().settings?.residentsOff === true, until: db().settings?.residentsUntil || null, active: scheduled() }, pending: rows, residents, blocked };
};

admin.get('/changes', (req, res) => res.json(list()));
admin.get('/changes/count', (req, res) => { prune(); const w = waiting(); res.json({ ...w, total: w.pending + w.messages }); });
admin.delete('/messages/:id', (req, res) => {
  const d = db();
  const before = (d.messages || []).length;
  d.messages = (d.messages || []).filter((m) => m.id !== req.params.id);
  store.save();
  res.json({ removed: before - d.messages.length });
});

function decide(prop, approve, req) {
  const d = db();
  const rec = d.residents.find((r) => r.rid === prop.residentId);
  const house = houseOf(prop.houseId);
  if (house) {
    audit.house(req.audit.actor, approve ? 'approved' : 'rejected', house, { from: house.status, to: prop.to, device: prop.residentId });
    req.audit.houseDone.add(house.id); // de statuswijziging staat hier al, met het apparaat erbij
  }
  if (approve && house) house.status = prop.to;
  if (rec) rec.notice = { decision: approve ? 'approved' : 'rejected', status: prop.to, at: new Date().toISOString() };
  d.proposals = d.proposals.filter((p) => p !== prop);
  return house ? { houseId: house.id, status: house.status } : null;
}

admin.post('/changes/approve-all', backups.afterSave('Wijzigingen van bewoners goedgekeurd'), (req, res) => {
  prune();
  const changes = [];
  for (const prop of [...db().proposals]) { const c = decide(prop, true, req); if (c) changes.push(c); }
  store.save();
  res.json({ changes });
});

const decideRoute = (approve) => (req, res) => {
  const prop = db().proposals.find((p) => p.id === req.params.id);
  if (!prop) return res.status(404).json({ error: 'Wijziging niet gevonden (misschien al behandeld)' });
  const change = decide(prop, approve, req);
  store.save();
  res.json({ change });
};
admin.post('/changes/:id/approve', backups.afterSave('Wijziging van bewoner goedgekeurd'), decideRoute(true));
admin.post('/changes/:id/reject', backups.afterSave('Wijziging van bewoner afgewezen'), decideRoute(false));

// Apparaten en blokkades gaan mee in de backups, dus na een wijziging komt er een backup.
admin.delete('/residents/:rid', backups.afterSave('Apparaat ontkoppeld'), (req, res) => {
  const d = db();
  const before = d.residents.length;
  const rec = d.residents.find((r) => r.rid === req.params.rid);
  d.residents = d.residents.filter((r) => r.rid !== req.params.rid);
  d.proposals = d.proposals.filter((p) => p.residentId !== req.params.rid);
  store.save();
  if (rec) audit.house(req.audit.actor, 'device-unlinked', houseOf(rec.houseId) || { id: rec.houseId }, { device: rec.rid });
  res.json({ removed: before - d.residents.length });
});

// Een apparaat blokkeren (en optioneel ook het IP-adres); de koppeling en openstaande wijzigingen verdwijnen.
admin.post('/residents/:rid/block', backups.afterSave('Apparaat geblokkeerd'), (req, res) => {
  const d = db();
  const rec = d.residents.find((r) => r.rid === req.params.rid);
  if (!rec) return res.status(404).json({ error: 'Apparaat niet gevonden' });
  const withIp = req.body?.withIp === true && !!rec.ip;
  d.blocked = d.blocked || [];
  d.blocked.push({ id: crypto.randomBytes(6).toString('hex'), tokenHash: rec.tokenHash, ip: withIp ? rec.ip : null, title: titleOf(houseOf(rec.houseId)), at: new Date().toISOString() });
  d.residents = d.residents.filter((r) => r !== rec);
  d.proposals = d.proposals.filter((p) => p.residentId !== rec.rid);
  store.save();
  audit.house(req.audit.actor, 'device-blocked', houseOf(rec.houseId) || { id: rec.houseId }, { device: rec.rid, withIp }); // zonder het IP-adres zelf
  res.json({ blocked: true, withIp });
});

admin.delete('/blocks/:id', backups.afterSave('Blokkade opgeheven'), (req, res) => {
  const d = db();
  const before = (d.blocked || []).length;
  const block = (d.blocked || []).find((b) => b.id === req.params.id);
  d.blocked = (d.blocked || []).filter((b) => b.id !== req.params.id);
  store.save();
  // een blokkade kent alleen het adres van toen (als titel), niet het huis
  if (block) audit.house(req.audit.actor, 'device-unblocked', { id: null, street: block.title }, { block: block.id });
  res.json({ removed: before - d.blocked.length });
});

// ---- QR-codes (voor het afdrukken en per huis) ----
// De link in de QR-code gebruikt ORIGIN, of anders het adres waarop de beheerder het beheer opent.
const qrItem = (req) => (h) => ({ houseId: h.id, title: titleOf(h), street: h.street || '', number: h.number || '', url: `${origin.pageOrigin(req)}/?q=${secretOf(h.id)}`, taken: houseTaken(h.id) });
admin.get('/qr', (req, res) => { const items = db().houses.map(qrItem(req)); store.save(); res.json(items); });
admin.post('/qr/rotate-all', (req, res) => { db().houseSecrets = {}; const items = db().houses.map(qrItem(req)); store.save(); res.json(items); });
admin.post('/qr/:houseId/rotate', (req, res) => {
  const h = houseOf(req.params.houseId);
  if (!h) return res.status(404).json({ error: 'Huis niet gevonden' });
  delete secrets()[h.id];
  const item = qrItem(req)(h);
  store.save();
  audit.house(req.audit.actor, 'qr-renewed', h);
  res.json(item);
});

// ---- pushmeldingen: apparaten van de beheerder ----
admin.get('/push/key', (req, res) => res.json({ publicKey: push.publicKey() }));
admin.get('/push/devices', (req, res) => res.json(push.devices()));
admin.post('/push/subscribe', (req, res) => {
  try { res.json({ id: push.addDevice(req.body?.subscription, req.body?.label, origin.pageOrigin(req)) }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
admin.delete('/push/devices/:id', (req, res) => res.json({ removed: push.removeDevice(req.params.id) }));
admin.post('/push/test', async (req, res) => {
  const r = await push.send({ title: t('Testmelding'), body: t('Meldingen werken op dit apparaat.'), url: '/beheer#changes', tag: 'test', badge: badgeTotal() });
  res.json(r);
});

module.exports = { resident, admin, prune, reconcile, enabled, mode, geofence, codeOn, qrOnly, MAX_RESIDENTS, GEO_MAX_ACC, GEO_MIN, GEO_MAX, GEO_DEFAULT_RADIUS, appOnly, info, untilMs, DEFAULT_INFO, DEFAULT_SHARE_TEXT, shareText, defaultShareTexts };
