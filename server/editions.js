'use strict';
// Edities: de kaart van een keer (bijvoorbeeld Sint Maarten 2025), met een eigen naam en jaartal en eigen statussen.
// De live kaart (wat de voorpagina toont) staat in db.json; elke editie is een los JSON-bestand in data/editions/.
// Een editie aanmaken of bewerken verandert de live kaart nooit: deze module schrijft alleen in data/editions/.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const { normalizeHouse, STATUSES } = require('./houses');

const dir = path.join(config.dataDir, 'editions');
fs.mkdirSync(dir, { recursive: true });

const MAX_EDITIONS = 100;
const MAX_NAME = 60;
const YEAR_MIN = 1900;
const YEAR_MAX = 2100;
const ID = /^\d{13}-[0-9a-f]{6}$/;
const LIVE = 'live';
const file = (id) => path.join(dir, `${id}.json`);
const newId = () => `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

const cleanName = (n) => String(n ?? '').replace(/\s+/g, ' ').trim();
const label = (e) => (e.name.includes(String(e.year)) ? e.name : `${e.name} ${e.year}`);
const iso = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null);

// { name, year } of een Error met een begrijpelijke melding.
function validMeta({ name, year } = {}) {
  const n = cleanName(name);
  if (!n) throw new Error('Geef de editie een naam');
  if (n.length > MAX_NAME) throw new Error(`De naam mag maximaal ${MAX_NAME} tekens zijn`);
  const y = typeof year === 'string' && /^\s*\d+\s*$/.test(year) ? Number(year) : year;
  if (!Number.isInteger(y) || y < YEAR_MIN || y > YEAR_MAX) throw new Error(`Het jaartal moet tussen ${YEAR_MIN} en ${YEAR_MAX} liggen`);
  return { name: n, year: y };
}

function counts(houses) {
  const c = { total: houses.length, green: 0, red: 0, none: 0 };
  for (const h of houses) c[STATUSES.includes(h.status) ? h.status : 'none']++;
  return c;
}

// Waarvan een editie een kopie is: { id: 'live' of een editie-id, label } (zoals de naam toen was), of null.
function cleanFrom(f) {
  if (!f || typeof f !== 'object') return null;
  const id = f.id === LIVE || ID.test(String(f.id)) ? f.id : null;
  return id ? { id, label: cleanName(f.label).slice(0, MAX_NAME + 5) } : null;
}

function ids() {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).filter((i) => ID.test(i)).sort();
}

function read(id) {
  if (!ID.test(String(id)) || !fs.existsSync(file(id))) return null;
  return JSON.parse(fs.readFileSync(file(id), 'utf8'));
}

function write(e) {
  const tmp = `${file(e.id)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(e));
  fs.renameSync(tmp, file(e.id));
}

// Nieuwste jaartal eerst; binnen een jaar de laatst aangemaakte eerst.
const order = (a, b) => b.year - a.year || String(b.createdAt).localeCompare(String(a.createdAt));

function list() {
  return ids().map((id) => {
    const e = read(id);
    return { id, name: e.name, year: e.year, createdAt: e.createdAt, updatedAt: e.updatedAt || null, copiedFrom: cleanFrom(e.copiedFrom), counts: e.counts || counts(e.houses) };
  }).sort(order);
}

// Alle edities volledig (met huizen), in een vaste volgorde: voor de backups.
const all = () => ids().map(read);

// Nieuwe editie als kopie van de huizen van de live kaart of van een andere editie (from = { id, label }).
function create(meta, houses, from) {
  const { name, year } = validMeta(meta);
  if (ids().length >= MAX_EDITIONS) throw new Error(`Er kunnen maximaal ${MAX_EDITIONS} edities bewaard worden; verwijder eerst een oude`);
  const list = JSON.parse(JSON.stringify(houses || [])).map(normalizeHouse);
  if (!list.length) throw new Error('Op deze kaart staan geen huizen; er valt niets te kopiëren');
  const e = { id: newId(), name, year, createdAt: new Date().toISOString(), updatedAt: null, copiedFrom: cleanFrom(from), counts: counts(list), houses: list };
  write(e);
  return e;
}

// Naam en jaartal wijzigen (de huizen blijven zoals ze waren). null als de editie niet bestaat.
function update(id, meta) {
  const e = read(id);
  if (!e) return null;
  Object.assign(e, validMeta(meta));
  write(e);
  return e;
}

// De huizen van één editie vervangen (de door de route gecontroleerde lijst). null als de editie niet bestaat.
function setHouses(id, houses) {
  const e = read(id);
  if (!e) return null;
  e.houses = houses.map(normalizeHouse);
  e.counts = counts(e.houses);
  e.updatedAt = new Date().toISOString();
  write(e);
  return e;
}

function remove(list) {
  let n = 0;
  for (const id of list) if (ID.test(id) && fs.existsSync(file(id))) { fs.rmSync(file(id)); n++; }
  return n;
}

// Eén editie uit een (geüploade) backup controleren en opschonen; gooit een Error bij ongeldige inhoud.
function sanitize(e, validateHouses) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) throw new Error('Een editie in de backup is ongeldig');
  const { name, year } = validMeta(e);
  const houses = validateHouses(e.houses);
  return { id: ID.test(String(e.id)) ? e.id : newId(), name, year, createdAt: iso(e.createdAt) || new Date().toISOString(), updatedAt: iso(e.updatedAt), copiedFrom: cleanFrom(e.copiedFrom), counts: counts(houses), houses };
}

// Terugzetten uit een backup: daarna staan er precies deze edities (eerst schrijven, dan de rest weghalen).
function replaceAll(list) {
  const keep = new Set();
  for (const raw of list.slice(0, MAX_EDITIONS)) {
    const e = { ...raw, houses: (raw.houses || []).map(normalizeHouse) };
    if (!ID.test(String(e.id)) || keep.has(e.id)) e.id = newId();
    e.counts = counts(e.houses);
    write(e);
    keep.add(e.id);
  }
  for (const id of ids()) if (!keep.has(id)) fs.rmSync(file(id), { force: true });
}

module.exports = { list, all, read, create, update, setHouses, remove, sanitize, replaceAll, counts, label, ID, LIVE, MAX_EDITIONS, MAX_NAME, YEAR_MIN, YEAR_MAX };
