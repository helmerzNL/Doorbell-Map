'use strict';
// Backups van de layout (huizen en kaartweergave), de teksten, de app-instellingen, de logo's, de apparaten van bewoners
// (gekoppeld en geblokkeerd) en alle edities.
// Eén ZIP per backup in DATA_PATH/backups (sint_maarten-backup-<id>.zip): backup.json plus de logo's los onder files/,
// zodat je een logo ook zonder de app uit de ZIP kunt halen. Het formaat volgt App-Guidance
// shared/guidelines/backup-restore.md: een ZIP wordt nooit uitgepakt naar schijf; een onderdeel wordt op naam gelezen,
// met een maximale grootte, en een logo wordt gecontroleerd op zijn sha256 en op de soort afbeelding.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { zipSync, unzipSync, strToU8 } = require('fflate');
const config = require('./config');
const store = require('./store');
const images = require('./images');
const community = require('./community');
const appVersion = require('./version');
const { LANGS } = require('./lang');
const { normalizeHouse, statsShow, STATUSES } = require('./houses');
const editions = require('./editions');

const dir = path.join(config.dataDir, 'backups');
fs.mkdirSync(dir, { recursive: true });
const MAX_BACKUPS = Number(process.env.MAX_BACKUPS) || 200;

const FORMAT = 'doorbell-map-backup';
const FORMAT_VERSION = 2; // 1: zonder app-instellingen, logo's en apparaten (de .json-backups van vóór de ZIP)
const DOC = 'backup.json';
const MAX_DOC = 100 * 1024 * 1024; // backup.json uitgepakt (met veel edities)
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

const MAX_TITLE = 40;
const cleanTitle = (t) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);

const ID = /^\d{13}-[0-9a-f]{6}$/;
const PREFIX = 'sint_maarten-backup-';
const fileName = (id) => `${PREFIX}${id}.zip`;
const file = (id) => path.join(dir, fileName(id));
const newId = () => `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
// Voor het vergelijken met de vorige backup telt het laatste gebruik van een apparaat niet mee: dat verandert bij elk
// gebruik van de app en is geen wijziging die een nieuwe backup waard is.
const digest = (data) => sha256(JSON.stringify(Array.isArray(data.devices) ? { ...data, devices: data.devices.map(({ lastActivity, ...r }) => r) } : data));

// ---------- ZIP ----------

// Eén onderdeel van een ZIP op naam lezen, niet groter dan max; null als het er niet in zit. De naam is alleen een
// sleutel, nooit een pad. fflate pakt een onderdeel uit in een buffer van de opgegeven grootte: een ZIP die over de
// grootte liegt, vraagt dus niet meer geheugen dan max (de inhoud klopt dan niet en valt af bij de controle erna).
function member(zip, name, max) {
  let tooBig = false;
  let out;
  try {
    out = unzipSync(zip, {
      filter: (f) => {
        if (f.name !== name) return false;
        if (f.size > max || f.originalSize > max) { tooBig = true; return false; }
        return true;
      },
    });
  } catch {
    throw new Error('Dit is geen geldig backupbestand (ZIP)');
  }
  if (tooBig) throw new Error('Een bestand in de backup is te groot');
  const u8 = out[name];
  return u8 ? Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength) : null;
}

// backup.json uit een ZIP.
function docOf(zip) {
  const raw = member(zip, DOC, MAX_DOC);
  if (!raw) throw new Error('In de ZIP ontbreekt backup.json');
  let doc;
  try { doc = JSON.parse(raw.toString('utf8')); } catch { throw new Error('backup.json in de ZIP is geen geldige JSON'); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('Dit is geen geldige backup');
  return doc;
}

// De logo's uit een ZIP, gecontroleerd: elk logo uit backup.json moet erin zitten, met de juiste sha256, en een PNG,
// JPEG of WebP zijn. Geeft { logo, logoSmall, favicon } (een Buffer of null), of null als de backup geen logo's kent.
function logosOf(zip, doc) {
  if (doc.logos === undefined) return null;
  const bad = new Error("De logo's in de backup zijn ongeldig");
  if (!doc.logos || typeof doc.logos !== 'object' || Array.isArray(doc.logos)) throw bad;
  const out = {};
  for (const { key } of images.LOGOS) {
    const m = doc.logos[key];
    if (m == null) { out[key] = null; continue; }
    if (typeof m !== 'object' || typeof m.archive_path !== 'string' || !/^[0-9a-f]{64}$/.test(String(m.sha256))) throw bad;
    const buf = member(zip, m.archive_path, images.MAX_IMAGE);
    if (!buf || sha256(buf) !== m.sha256 || !images.detect(buf)) throw new Error('Een logo in de backup ontbreekt of is beschadigd');
    out[key] = buf;
  }
  return out;
}

// Wat backup.json over de logo's zegt: per logo de plek in de ZIP, de sha256 en de grootte.
function logoMeta(files) {
  const meta = {};
  for (const { key, prefix } of images.LOGOS) {
    const buf = files[key];
    meta[key] = buf ? { archive_path: `files/${prefix}.${images.detect(buf)}`, sha256: sha256(buf), size: buf.length } : null;
  }
  return meta;
}

// Schrijft een backup als ZIP, eerst onder een tijdelijke naam (een half bestand komt nooit in de lijst).
// backup.json wordt gecomprimeerd; de afbeeldingen niet, die zijn dat al.
function writeZip(id, doc, files = {}) {
  const entries = { [DOC]: [strToU8(JSON.stringify(doc)), { level: 6 }] };
  for (const { key } of images.LOGOS) if (files[key] && doc.logos?.[key]) entries[doc.logos[key].archive_path] = [files[key], { level: 0 }];
  const tmp = `${file(id)}.tmp`;
  fs.writeFileSync(tmp, zipSync(entries));
  fs.renameSync(tmp, file(id));
}

// ---------- inhoud ----------

// Teksten die naast uitleg, namen en statusnamen in de backup staan (Nederlands; de vertalingen staan in translations).
// Leeg betekent bij deze velden "de standaardtekst"; bij residentInfo staat null voor de standaardtekst.
const EXTRA_TEXTS = ['residentInfo', 'qrShareText', 'communityTitle', 'communityText'];

// App-instellingen die meegaan: de schakelaars en keuzes uit het beheer, zoals ze werken (een standaard die aan staat
// wordt true). De toegangscode voor bewoners gaat niet mee: een backup bevat niets waarmee je ergens binnenkomt, net
// als inloggegevens, QR-geheimen en pushsleutels. Terugzetten laat de code staan die er al is.
const BOOL_SETTINGS = ['residentsEnabled', 'residentsAppOnly', 'residentsOff', 'residentsSwapAfter', 'residentsGeofence', 'residentsQrOnly', 'residentsCodeOn', 'simpleUi', 'locateEnabled', 'communityEnabled', 'communityLooks', 'statsPublic', 'multilingual'];
const DEFAULT_ON = new Set(['residentsEnabled', 'locateEnabled', 'communityLooks']);

function settingsData(s) {
  const out = {};
  for (const k of BOOL_SETTINGS) out[k] = DEFAULT_ON.has(k) ? s[k] !== false : s[k] === true;
  out.residentsUntil = s.residentsUntil || null;
  out.residentsGeofenceRadius = Number.isFinite(s.residentsGeofenceRadius) ? s.residentsGeofenceRadius : null;
  out.statsShow = statsShow(s);
  out.defaultLang = LANGS.includes(s.defaultLang) ? s.defaultLang : 'nl';
  return out;
}

// App-instellingen uit een backup controleren: alleen bekende velden met geldige waarden. undefined als de backup
// geen instellingen bevat (een backup van vóór de ZIP); terugzetten laat de instellingen dan staan.
function cleanSettings(raw) {
  if (raw === undefined) return undefined;
  const bad = new Error('De instellingen in de backup zijn ongeldig');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad;
  const { GEO_MIN, GEO_MAX } = require('./residents'); // pas hier: residents.js gebruikt zelf deze module
  const out = {};
  for (const k of BOOL_SETTINGS) if (k in raw) out[k] = raw[k] === true;
  if ('residentsUntil' in raw) {
    const t = raw.residentsUntil == null ? NaN : Date.parse(raw.residentsUntil);
    if (raw.residentsUntil != null && !Number.isFinite(t)) throw bad;
    out.residentsUntil = Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  if (out.residentsOff && !out.residentsUntil) out.residentsOff = false; // uit zonder einddatum kan niet
  if (raw.residentsGeofenceRadius != null) {
    const r = Number(raw.residentsGeofenceRadius);
    if (!Number.isFinite(r) || r < GEO_MIN || r > GEO_MAX) throw bad;
    out.residentsGeofenceRadius = Math.round(r);
  }
  if (raw.statsShow !== undefined) {
    if (!raw.statsShow || typeof raw.statsShow !== 'object') throw bad;
    out.statsShow = Object.fromEntries(STATUSES.map((k) => [k, raw.statsShow[k] !== false]));
  }
  if ('defaultLang' in raw) {
    if (!LANGS.includes(raw.defaultLang)) throw bad;
    out.defaultLang = raw.defaultLang;
  }
  return out;
}

// Apparaten van bewoners (elk aan één huis gekoppeld) en geblokkeerde apparaten. Van de sleutel van een apparaat staat
// alleen de sha256 erin, zoals in de database: daarmee kom je nergens binnen, maar een apparaat dat zijn sleutel nog
// heeft, blijft na terugzetten gekoppeld (of geblokkeerd). Openstaande wijzigingen en berichten gaan niet mee.
const MAX_BLOCKED = 10000;
const HEX12 = /^[0-9a-f]{12}$/, HEX64 = /^[0-9a-f]{64}$/;

function devicesData(d) {
  return (d.residents || []).map((r) => ({ rid: r.rid, tokenHash: r.tokenHash, houseId: r.houseId, createdAt: r.createdAt, lastActivity: r.lastActivity || r.createdAt, ip: r.ip || null, notice: r.notice || null }));
}
function blockedData(d) {
  return (d.blocked || []).map((b) => ({ id: b.id, tokenHash: b.tokenHash || null, ip: b.ip || null, title: b.title || '', at: b.at }));
}

const iso = (v, bad) => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  if (!Number.isFinite(t)) throw bad;
  return new Date(t).toISOString();
};
const ipOf = (v, bad) => {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || v.length > 64) throw bad;
  return v;
};

function cleanDevices(raw) {
  if (raw === undefined) return undefined;
  const bad = new Error('De apparaten in de backup zijn ongeldig');
  const { MAX_RESIDENTS } = require('./residents'); // pas hier: residents.js gebruikt zelf deze module
  if (!Array.isArray(raw) || raw.length > MAX_RESIDENTS) throw bad;
  const seen = new Set();
  return raw.map((r) => {
    if (!r || typeof r !== 'object' || !HEX12.test(r.rid) || !HEX64.test(r.tokenHash)) throw bad;
    if (typeof r.houseId !== 'string' || !r.houseId || r.houseId.length > 100) throw bad;
    if (seen.has(r.rid) || seen.has(r.tokenHash)) throw bad; // één koppeling per apparaat
    seen.add(r.rid); seen.add(r.tokenHash);
    let notice = null;
    if (r.notice != null) {
      const n = r.notice;
      if (typeof n !== 'object' || !['approved', 'rejected'].includes(n.decision) || !STATUSES.includes(n.status)) throw bad;
      notice = { decision: n.decision, status: n.status, at: iso(n.at, bad) };
    }
    return { rid: r.rid, tokenHash: r.tokenHash, houseId: r.houseId, createdAt: iso(r.createdAt, bad), lastActivity: iso(r.lastActivity ?? r.createdAt, bad), ip: ipOf(r.ip, bad), notice };
  });
}

function cleanBlocked(raw) {
  if (raw === undefined) return undefined;
  const bad = new Error('De geblokkeerde apparaten in de backup zijn ongeldig');
  if (!Array.isArray(raw) || raw.length > MAX_BLOCKED) throw bad;
  return raw.map((b) => {
    if (!b || typeof b !== 'object' || !HEX12.test(b.id)) throw bad;
    const tokenHash = b.tokenHash ?? null;
    if (tokenHash !== null && !HEX64.test(tokenHash)) throw bad;
    const ip = ipOf(b.ip, bad);
    if (!tokenHash && !ip) throw bad; // een blokkade zonder apparaat en zonder IP-adres blokkeert niets
    return { id: b.id, tokenHash, ip, title: String(b.title ?? '').slice(0, 200), at: iso(b.at, bad) };
  });
}

// De delen die een backup van vóór de ZIP niet heeft, gecontroleerd; een deel dat ontbreekt, ontbreekt ook hier
// (terugzetten laat dat deel dan staan). Gooit een Error bij ongeldige inhoud.
function cleanSections(b) {
  const out = {};
  const settings = cleanSettings(b.settings);
  const devices = cleanDevices(b.devices);
  const blocked = cleanBlocked(b.blocked);
  if (settings) out.settings = settings;
  if (devices) out.devices = devices;
  if (blocked) out.blocked = blocked;
  return out;
}

// De huidige logo-bestanden (een ontbrekend of onleesbaar bestand telt als geen logo).
function currentLogos(s) {
  const files = {};
  for (const { key } of images.LOGOS) {
    const name = s[key]?.file ? path.basename(s[key].file) : '';
    let buf = null;
    if (name) { try { buf = fs.readFileSync(path.join(store.uploadDir, name)); } catch { buf = null; } }
    files[key] = buf && images.detect(buf) ? buf : null;
  }
  return files;
}

// De inhoud die we veiligstellen, en de logo-bestanden die erbij horen.
function snapshot() {
  const d = store.db();
  const { houses, view, pdfView } = d;
  const s = d.settings || {};
  const files = currentLogos(s);
  const texts = { labels: { ...(s.labels || {}) }, siteTitle: s.siteTitle || '', intro: s.intro || '', appName: s.appName || '', appShortName: s.appShortName || '', translations: JSON.parse(JSON.stringify(s.translations || {})) };
  for (const f of EXTRA_TEXTS) texts[f] = typeof s[f] === 'string' ? s[f] : f === 'residentInfo' ? null : '';
  const data = {
    houses: JSON.parse(JSON.stringify(houses)),
    view: view ? { ...view } : null,
    pdfView: pdfView ? { ...pdfView, center: [...pdfView.center] } : null,
    texts,
    settings: settingsData(s),
    logos: logoMeta(files),
    devices: devicesData(d),
    blocked: blockedData(d),
    editions: editions.all(), // alle edities, volledig (met huizen)
  };
  return { data, files };
}

// ---------- de lijst ----------

function ids() {
  return fs.readdirSync(dir)
    .filter((f) => f.startsWith(PREFIX) && f.endsWith('.zip'))
    .map((f) => f.slice(PREFIX.length, -4))
    .filter((i) => ID.test(i))
    .sort();
}

const exists = (id) => typeof id === 'string' && ID.test(id) && fs.existsSync(file(id));

// backup.json van een backup (zonder de logo's), of null als die backup er niet is.
function read(id) {
  return exists(id) ? docOf(fs.readFileSync(file(id))) : null;
}

// Map en bestandsnaam van de ZIP, voor het downloaden; null als die backup er niet is.
const zipFile = (id) => (exists(id) ? { dir, name: fileName(id) } : null);

function write(id, { reason, title, ok, hash, data, files }) {
  const doc = { format: FORMAT, format_version: FORMAT_VERSION, app_version: appVersion.version, includes_files: !!data.logos, id, createdAt: new Date().toISOString(), reason, title: cleanTitle(title), ok, hash, ...data };
  writeZip(id, doc, files);
}

// Houdt de nieuwste MAX_BACKUPS (inclusief de zojuist geschreven backup); all is de lijst van vóór het schrijven.
function prune(all) {
  for (const old of all.slice(0, Math.max(0, all.length + 1 - MAX_BACKUPS))) fs.rmSync(file(old), { force: true });
}

// Een onleesbare nieuwste backup mag het maken van nieuwe backups niet blokkeren.
function lastHash(id) {
  try { return read(id)?.hash ?? null; } catch { return null; }
}

// Maakt een backup van de huidige staat. Slaat over als er niets veranderd is t.o.v. de nieuwste backup
// (tenzij force: een handmatige backup met eigen titel wordt altijd gemaakt).
function create(reason, ok = true, { title = '', force = false } = {}) {
  const { data, files } = snapshot();
  const hash = digest(data);
  const all = ids();
  if (!force && all.length && lastHash(all[all.length - 1]) === hash) return null;
  const id = newId();
  write(id, { reason, title, ok, hash, data, files });
  prune(all);
  return id;
}

// Een geüpload bestand: een ZIP (herkend aan de eerste bytes, niet aan de naam) of een oudere .json-backup.
// Geeft { doc, files }: doc moet de route nog controleren; files zijn de gecontroleerde logo's, of null als de backup
// geen logo's bevat (een .json-backup: terugzetten laat de logo's dan staan).
function parseUpload(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw new Error('Dit is geen geldige backup');
  const isZip = buf.subarray(0, 4).equals(ZIP_MAGIC);
  let doc;
  if (isZip) doc = docOf(buf);
  else {
    try { doc = JSON.parse(buf.toString('utf8')); } catch { throw new Error('Dit is geen geldig backupbestand (ZIP of JSON)'); }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('Dit is geen geldige backup');
  }
  if (doc.format !== undefined && doc.format !== FORMAT) throw new Error('Dit is geen backup van deze app');
  if (Number.isInteger(doc.format_version) && doc.format_version > FORMAT_VERSION) {
    throw new Error(`Deze backup is gemaakt met een nieuwere versie van de app (${String(doc.app_version || '?').slice(0, 20)}). Werk de app eerst bij.`);
  }
  return { doc, files: isZip ? logosOf(buf, doc) : null };
}

// Zet een (door de route gecontroleerde en schoongemaakte) inhoud als nieuwe backup in de lijst, met de
// gecontroleerde logo's (of null). Het id komt nooit uit het bestand zelf.
function importData(data, files, title = '') {
  const content = { ...data };
  delete content.logos;
  if (files) content.logos = logoMeta(files);
  const all = ids();
  const id = newId();
  write(id, { reason: 'Geüpload', title: cleanTitle(title) || 'Geüpload', ok: true, hash: digest(content), data: content, files: files || {} });
  prune(all);
  return id;
}

// Samenvatting per backup voor de lijst. Een backup verandert na het schrijven alleen nog van titel, dus de samenvatting
// wordt bewaard tot setTitle of verwijderen; zo hoeft de lijst niet steeds alle (met edities grote) bestanden te lezen.
const summaries = new Map();
function summary(id) {
  if (!summaries.has(id)) {
    let b;
    try { b = read(id); } catch (err) {
      console.error(`Backup ${fileName(id)} is niet te lezen: ${err.message}`); // één kapot bestand mag de lijst niet blokkeren
      summaries.set(id, null);
      return null;
    }
    // edities: null bij backups van vóór de edities (die laten bij terugzetten de edities met rust); idem logo's en apparaten
    const eds = Array.isArray(b.editions) ? b.editions.map((e) => ({ name: e.name, year: e.year, label: editions.label(e), houses: (e.houses || []).length })) : null;
    const logos = b.logos && typeof b.logos === 'object' ? Object.values(b.logos).filter(Boolean).length : null;
    const count = (a) => (Array.isArray(a) ? a.length : null);
    summaries.set(id, { id, createdAt: b.createdAt, reason: b.reason, title: b.title || '', ok: b.ok !== false, houses: b.houses.length, hasView: !!b.view, textLength: b.texts.intro.length, settings: !!b.settings, logos, devices: count(b.devices), blocked: count(b.blocked), editions: eds });
  }
  return summaries.get(id);
}

function list() {
  const all = ids();
  for (const id of summaries.keys()) if (!all.includes(id)) summaries.delete(id);
  return all.reverse().map(summary).filter(Boolean);
}

// Korte titel van een backup instellen of wissen (de inhoud blijft ongewijzigd).
function setTitle(id, title) {
  if (!exists(id)) return null;
  const zip = fs.readFileSync(file(id));
  const doc = docOf(zip);
  doc.title = cleanTitle(title);
  writeZip(id, doc, logosOf(zip, doc) || {});
  summaries.delete(id);
  return doc.title;
}

function remove(list) {
  let n = 0;
  for (const id of list) if (exists(id)) { fs.rmSync(file(id)); n++; }
  return n;
}

// Schrijft de logo's uit een backup naar de uploadmap, onder een nieuwe naam (een logo dat al zo is, blijft staan).
// Geeft de nieuwe instellingen en de oude die vervangen worden; als er iets misgaat, worden de nieuwe bestanden weer
// weggehaald en verandert er niets.
function stageLogos(s, logos) {
  const next = {}, replaced = [], written = [];
  try {
    const cur = currentLogos(s);
    for (const { key, prefix } of images.LOGOS) {
      const buf = logos[key];
      if (cur[key] && buf && sha256(cur[key]) === sha256(buf)) continue; // hetzelfde logo: blijft zoals het is
      if (!buf && !s[key]) continue;
      if (s[key]) replaced.push(s[key]);
      if (!buf) { next[key] = null; continue; }
      const ext = images.detect(buf);
      const name = `${prefix}-${Date.now()}.${ext}`;
      fs.writeFileSync(path.join(store.uploadDir, name), buf);
      written.push(name);
      next[key] = images.setting(key, name, buf, ext);
    }
  } catch (err) {
    for (const name of written) fs.rmSync(path.join(store.uploadDir, name), { force: true });
    throw err;
  }
  return { next, replaced };
}

// Zet een backup terug in de database (maakt eerst zelf een backup van de huidige staat). Geeft false als de backup
// er niet is; gooit een Error als hij niet bruikbaar is, en dan verandert er niets.
function restore(id) {
  if (!exists(id)) return false;
  const zip = fs.readFileSync(file(id));
  const b = docOf(zip);
  // eerst alles controleren, dan pas iets veranderen
  const { settings, devices, blocked } = cleanSections(b);
  const logos = logosOf(zip, b);
  create('Voor terugzetten');
  const db = store.db();
  const staged = logos ? stageLogos(db.settings, logos) : { next: {}, replaced: [] };
  db.houses = b.houses.map(normalizeHouse); // ook oude backups met "label" werken
  db.view = b.view;
  if ('pdfView' in b) db.pdfView = b.pdfView; // oudere backups kennen dit veld nog niet
  db.settings.intro = b.texts.intro;
  if (b.texts.labels) db.settings.labels = b.texts.labels;
  if ('siteTitle' in b.texts) db.settings.siteTitle = b.texts.siteTitle; // oudere backups kennen dit veld nog niet
  db.settings.appName = b.texts.appName;
  db.settings.appShortName = b.texts.appShortName;
  if (b.texts.translations) db.settings.translations = JSON.parse(JSON.stringify(b.texts.translations)); // oudere backups kennen dit veld nog niet
  for (const f of EXTRA_TEXTS) {
    if (!(f in b.texts)) continue; // backups van vóór de ZIP kennen deze velden niet
    if (b.texts[f] === null) delete db.settings[f]; else db.settings[f] = String(b.texts[f]);
  }
  if (settings) {
    const communityWasOn = db.settings.communityEnabled === true;
    Object.assign(db.settings, settings);
    if (settings.residentsCodeOn && !/^\d{4,6}$/.test(String(db.settings.residentsCode || ''))) db.settings.residentsCodeOn = false; // de code zelf gaat niet mee
    if (communityWasOn && db.settings.communityEnabled !== true) community.clear(); // net als bij uitzetten in het beheer
  }
  Object.assign(db.settings, staged.next);
  if (blocked) db.blocked = blocked;
  if (devices) {
    db.residents = devices;
    require('./residents').prune(); // koppelingen met huizen die er niet meer zijn, en wijzigingen van apparaten die er niet meer zijn
  }
  store.save();
  staged.replaced.forEach(images.remove);
  if (Array.isArray(b.editions)) editions.replaceAll(b.editions); // oudere backups hebben geen edities: dan blijven die staan
  create('Teruggezet');
  return true;
}

// Express-middleware: maak na elke opslagpoging (ook een mislukte) een backup.
const afterSave = (reason) => (req, res, next) => {
  res.on('finish', () => {
    try { create(reason, res.statusCode < 400); } catch (err) { console.error('Backup mislukt:', err.message); }
  });
  next();
};

// Eenmalig bij het starten: backups van vóór de ZIP (<id>.json) omzetten naar sint_maarten-backup-<id>.zip, met
// dezelfde inhoud (zonder instellingen, logo's en apparaten: terugzetten laat die dan staan), en een tijdelijk bestand van een
// onderbroken schrijfactie opruimen. Een bestand dat niet te lezen is, blijft staan en komt in de log.
function migrate() {
  for (const f of fs.readdirSync(dir)) {
    const src = path.join(dir, f);
    if (f.endsWith('.tmp')) { fs.rmSync(src, { force: true }); continue; }
    const id = f.endsWith('.json') ? f.slice(0, -5) : '';
    if (!ID.test(id)) continue;
    try {
      if (!fs.existsSync(file(id))) {
        const b = JSON.parse(fs.readFileSync(src, 'utf8'));
        writeZip(id, { format: FORMAT, format_version: 1, includes_files: false, ...b, id }, {});
      }
      fs.rmSync(src);
    } catch (err) {
      console.error(`Backup ${f} kon niet naar ZIP worden omgezet: ${err.message}`);
    }
  }
}
migrate();

module.exports = { create, importData, parseUpload, list, read, zipFile, remove, setTitle, MAX_TITLE, restore, afterSave, ID, cleanSections, EXTRA_TEXTS };
