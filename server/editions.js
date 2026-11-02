'use strict';
// Edities: een bewaarde stand van de huizen (met hun status) van een eerdere keer, met een eigen naam en jaartal.
// De live kaart (wat de voorpagina toont en wat je bewerkt) blijft in db.json; elke editie is een los JSON-bestand
// in data/editions/, zodat db.json klein blijft. Een editie verandert de live kaart nooit.
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
const file = (id) => path.join(dir, `${id}.json`);

const cleanName = (n) => String(n ?? '').replace(/\s+/g, ' ').trim();

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

function ids() {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).filter((i) => ID.test(i));
}

function read(id) {
  if (!ID.test(String(id)) || !fs.existsSync(file(id))) return null;
  return JSON.parse(fs.readFileSync(file(id), 'utf8'));
}

function write(e) {
  const tmp = `${file(e.id)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(e, null, 2));
  fs.renameSync(tmp, file(e.id));
}

// Nieuwste jaartal eerst; binnen een jaar de laatst bewaarde eerst.
const order = (a, b) => b.year - a.year || String(b.createdAt).localeCompare(String(a.createdAt));

function list() {
  return ids().map((id) => {
    const e = read(id);
    return { id, name: e.name, year: e.year, createdAt: e.createdAt, source: e.source, sourceDate: e.sourceDate || null, counts: e.counts || counts(e.houses) };
  }).sort(order);
}

// Bewaart huizen als nieuwe editie. source: 'live' of 'backup' (met de datum van die backup).
function create(meta, houses, { source = 'live', sourceDate = null } = {}) {
  const { name, year } = validMeta(meta);
  if (ids().length >= MAX_EDITIONS) throw new Error(`Er kunnen maximaal ${MAX_EDITIONS} edities bewaard worden; verwijder eerst een oude`);
  const list = JSON.parse(JSON.stringify(houses || [])).map(normalizeHouse);
  if (!list.length) throw new Error('Op deze kaart staan geen huizen; er valt niets te bewaren');
  const id = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const e = { id, name, year, createdAt: new Date().toISOString(), source, sourceDate, counts: counts(list), houses: list };
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

function remove(list) {
  let n = 0;
  for (const id of list) if (ID.test(id) && fs.existsSync(file(id))) { fs.rmSync(file(id)); n++; }
  return n;
}

module.exports = { list, read, create, update, remove, counts, ID, MAX_EDITIONS, MAX_NAME, YEAR_MIN, YEAR_MAX };
