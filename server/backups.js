'use strict';
// Backups van layout (huizen + kaartweergave) en teksten (uitleg, appnaam). Eén JSON-bestand per backup.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const store = require('./store');
const { normalizeHouse } = require('./houses');

const dir = path.join(config.dataDir, 'backups');
fs.mkdirSync(dir, { recursive: true });
const MAX_BACKUPS = Number(process.env.MAX_BACKUPS) || 200;

const MAX_TITLE = 40;
const cleanTitle = (t) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);

const ID = /^\d{13}-[0-9a-f]{6}$/;
const file = (id) => path.join(dir, `${id}.json`);

// De inhoud die we veiligstellen.
function snapshotData() {
  const { houses, view, pdfView, settings } = store.db();
  return {
    houses: JSON.parse(JSON.stringify(houses)),
    view: view ? { ...view } : null,
    pdfView: pdfView ? { ...pdfView, center: [...pdfView.center] } : null,
    texts: { labels: { ...(settings?.labels || {}) }, siteTitle: settings?.siteTitle || '', intro: settings?.intro || '', appName: settings?.appName || '', appShortName: settings?.appShortName || '', translations: JSON.parse(JSON.stringify(settings?.translations || {})) },
  };
}

const digest = (data) => crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');

function ids() {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).filter((i) => ID.test(i)).sort();
}

function read(id) {
  if (!ID.test(id) || !fs.existsSync(file(id))) return null;
  return JSON.parse(fs.readFileSync(file(id), 'utf8'));
}

// Maakt een backup van de huidige staat. Slaat over als er niets veranderd is t.o.v. de nieuwste backup
// (tenzij force: een handmatige backup met eigen titel wordt altijd gemaakt).
function create(reason, ok = true, { title = '', force = false } = {}) {
  const data = snapshotData();
  const hash = digest(data);
  const all = ids();
  const last = all.length ? read(all[all.length - 1]) : null;
  if (!force && last && last.hash === hash) return null;
  const id = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const tmp = `${file(id)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ id, createdAt: new Date().toISOString(), reason, title: cleanTitle(title), ok, hash, ...data }, null, 2));
  fs.renameSync(tmp, file(id));
  for (const old of all.slice(0, Math.max(0, all.length + 1 - MAX_BACKUPS))) fs.rmSync(file(old), { force: true });
  return id;
}

// Zet een (door de route gecontroleerde en schoongemaakte) inhoud als nieuwe backup in de lijst.
// Het id komt nooit uit het bestand zelf.
function importData(data, title = '') {
  const id = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const all = ids();
  const tmp = `${file(id)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ id, createdAt: new Date().toISOString(), reason: 'Geüpload', title: cleanTitle(title) || 'Geüpload', ok: true, hash: digest(data), ...data }, null, 2));
  fs.renameSync(tmp, file(id));
  for (const old of all.slice(0, Math.max(0, all.length + 1 - MAX_BACKUPS))) fs.rmSync(file(old), { force: true });
  return id;
}

function list() {
  return ids().reverse().map((id) => {
    const b = read(id);
    return { id, createdAt: b.createdAt, reason: b.reason, title: b.title || '', ok: b.ok !== false, houses: b.houses.length, hasView: !!b.view, textLength: b.texts.intro.length };
  });
}

// Korte titel van een backup instellen of wissen (de inhoud blijft ongewijzigd).
function setTitle(id, title) {
  const b = read(id);
  if (!b) return null;
  b.title = cleanTitle(title);
  const tmp = `${file(id)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(b, null, 2));
  fs.renameSync(tmp, file(id));
  return b.title;
}

function remove(list) {
  let n = 0;
  for (const id of list) if (ID.test(id) && fs.existsSync(file(id))) { fs.rmSync(file(id)); n++; }
  return n;
}

// Zet een backup terug in de database (maakt eerst zelf een backup van de huidige staat).
function restore(id) {
  const b = read(id);
  if (!b) return false;
  create('Voor terugzetten');
  const db = store.db();
  db.houses = b.houses.map(normalizeHouse); // ook oude backups met "label" werken
  db.view = b.view;
  if ('pdfView' in b) db.pdfView = b.pdfView; // oudere backups kennen dit veld nog niet
  db.settings.intro = b.texts.intro;
  if (b.texts.labels) db.settings.labels = b.texts.labels;
  if ('siteTitle' in b.texts) db.settings.siteTitle = b.texts.siteTitle; // oudere backups kennen dit veld nog niet
  db.settings.appName = b.texts.appName;
  db.settings.appShortName = b.texts.appShortName;
  if (b.texts.translations) db.settings.translations = JSON.parse(JSON.stringify(b.texts.translations)); // oudere backups kennen dit veld nog niet
  store.save();
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

module.exports = { create, importData, list, read, remove, setTitle, MAX_TITLE, restore, afterSave, ID };
