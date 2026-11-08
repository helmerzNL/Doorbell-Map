'use strict';
// Auditlog: elke wijziging, direct weggeschreven naar DATA_PATH/audit-log.jsonl. Eén JSON-object per regel (JSON Lines):
// zo komt elke wijziging er meteen bij zonder het bestand te herschrijven, en blijft een half geschreven regel beperkt
// tot die ene regel. Elke regel heeft:
//   at        wanneer (ISO-tijd)
//   category  "house" (een huis: status, adres, vorm, voorstellen van bewoners, apparaten bij een huis) of "site" (de rest)
//   action    wat er gebeurde (vast woord, bv. "proposed", "approved", "settings")
//   actor     wie: { type: "admin", id, name } (een beheerder), { type: "device", id } (het apparaat van een bewoner,
//             met zijn vaste, willekeurige id) of { type: "system" }
//   summary   dezelfde wijziging in een korte Nederlandse zin
// en waar het past: house { id, address }, from/to, changes, device (id van het apparaat), edition, params.
// Nooit in de log: IP-adressen, wachtwoorden, codes, sleutels of tokens. De log zit niet in de backups (terugzetten
// verandert de geschiedenis niet) en wordt nooit door de app ingekort.
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const store = require('./store');
const { statusLabels } = require('./houses');

const FILE = path.join(config.dataDir, 'audit-log.jsonl');

function write(entry) {
  try {
    fs.appendFileSync(FILE, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch (err) {
    console.error('Auditlog: schrijven mislukt:', err.message); // de wijziging zelf gaat wel door
  }
}

// ---------- wie ----------
const admin = (user) => (user ? { type: 'admin', id: user.id, name: user.username } : { type: 'system' });
const device = (rid) => ({ type: 'device', id: rid });
const SYSTEM = { type: 'system' };
const who = (actor) => (actor.type === 'admin' ? `beheerder ${actor.name}` : actor.type === 'device' ? `apparaat ${actor.id}` : 'systeem');

// ---------- huizen ----------
const address = (h) => [h?.street, h?.number].filter(Boolean).join(' ') || null;
const houseRef = (h) => ({ id: h?.id ?? null, address: address(h) });
const statusName = (k) => (statusLabels(store.db().settings)[k] || k || '').toLowerCase();
const clip = (s, n = 200) => (String(s ?? '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s ?? ''));

const ACTIONS = {
  added: (e) => `toegevoegd (${statusName(e.changes?.status?.to)})`,
  removed: () => 'verwijderd',
  changed: (e) => {
    const c = e.changes || {};
    const parts = [];
    if (c.status) parts.push(`status ${statusName(c.status.from)} → ${statusName(c.status.to)}`);
    if (c.address) parts.push(`adres ${c.address.from || '–'} → ${c.address.to || '–'}`);
    if (c.note) parts.push('notitie aangepast');
    if (c.shape) parts.push('vorm aangepast');
    return parts.join(', ');
  },
  proposed: (e) => `voorstel ${statusName(e.from)} → ${statusName(e.to)}`,
  'proposal-withdrawn': (e) => `voorstel ingetrokken (blijft ${statusName(e.from)})`,
  approved: (e) => `voorstel goedgekeurd: ${statusName(e.from)} → ${statusName(e.to)}`,
  rejected: (e) => `voorstel afgewezen (${statusName(e.to)}), blijft ${statusName(e.from)}`,
  'device-linked': () => 'apparaat gekoppeld',
  'device-unlinked': () => 'apparaat ontkoppeld',
  'device-blocked': (e) => `apparaat geblokkeerd${e.withIp ? ' (ook het IP-adres)' : ''}`,
  'device-unblocked': () => 'blokkade opgeheven',
  'qr-renewed': () => 'QR-code vernieuwd',
};

// Eén regel over één huis. extra: from/to, changes, device, edition, via, ...
function house(actor, action, h, extra = {}) {
  const e = { category: 'house', action, actor, house: houseRef(h), ...extra };
  const what = ACTIONS[action] ? ACTIONS[action](e) : action;
  const where = e.edition ? ` in editie ${e.edition.label}` : '';
  write({ ...e, summary: `${address(h) || 'Huis'}${where}: ${what} (${who(actor)}${e.device && actor.type !== 'device' ? `, apparaat ${e.device}` : ''})` });
}

// Wat er van een huis in de log komt; de vorm alleen als vergelijking, nooit de coördinaten zelf.
const snap = (houses) => new Map((houses || []).map((h) => [h.id, { id: h.id, street: h.street || '', number: h.number || '', status: h.status, note: h.note || '', shape: JSON.stringify(h.points || []) }]));

// Verschillen tussen een momentopname (snap) en de huizen erna, als regels voor house().
function houseDiff(before, afterHouses) {
  const after = snap(afterHouses);
  const out = [];
  for (const [id, a] of after) {
    const b = before.get(id);
    if (!b) { out.push({ action: 'added', house: a, changes: { status: { to: a.status } } }); continue; }
    const changes = {};
    if (b.status !== a.status) changes.status = { from: b.status, to: a.status };
    if (b.street !== a.street || b.number !== a.number) changes.address = { from: address(b), to: address(a) };
    if (b.note !== a.note) changes.note = { from: clip(b.note), to: clip(a.note) };
    if (b.shape !== a.shape) changes.shape = true;
    if (Object.keys(changes).length) out.push({ action: 'changed', house: a, changes });
  }
  for (const [id, b] of before) if (!after.has(id)) out.push({ action: 'removed', house: b });
  return out;
}

function logHouseDiff(actor, before, afterHouses, extra = {}, skip = new Set()) {
  for (const d of houseDiff(before, afterHouses)) {
    if (skip.has(d.house.id)) continue;
    house(actor, d.action, d.house, { ...(d.changes ? { changes: d.changes } : {}), ...extra });
  }
}

// ---------- de rest van de site ----------
// Instellingen, kaartweergave en PDF-kaartvlak vóór en na een wijziging. De toegangscode voor bewoners staat er alleen
// als "gewijzigd" in, zonder waarde.
const SECRET_SETTINGS = new Set(['residentsCode']);
const siteSnap = () => JSON.parse(JSON.stringify({ settings: store.db().settings || {}, view: store.db().view ?? null, pdfView: store.db().pdfView ?? null }));
const small = (b, a) => {
  const sb = JSON.stringify(b ?? null), sa = JSON.stringify(a ?? null);
  return sb.length + sa.length <= 400 ? { from: b ?? null, to: a ?? null } : { changed: true }; // lange teksten: alleen dát ze veranderden
};
function siteDiff(before, after) {
  const out = {};
  for (const area of ['view', 'pdfView']) if (JSON.stringify(before[area]) !== JSON.stringify(after[area])) out[area] = small(before[area], after[area]);
  for (const k of new Set([...Object.keys(before.settings), ...Object.keys(after.settings)])) {
    const b = before.settings[k], a = after.settings[k];
    if (JSON.stringify(b ?? null) === JSON.stringify(a ?? null)) continue;
    out[`settings.${k}`] = SECRET_SETTINGS.has(k) ? { changed: true } : small(b, a);
  }
  return out;
}

function site(actor, action, label, extra = {}) {
  write({ category: 'site', action, actor, summary: `${label} (${who(actor)})`, ...extra });
}

// Welke beheerroute wat is. house: true = de route gaat over huizen; die geven zelf (of via de vergelijking) regels per
// huis, zonder aparte siteregel. Routes die niets wijzigen (een bevestiging aanvragen, een testmelding) staan op skip.
const P = '/api/admin';
const ROUTES = [
  ['PUT', /^\/houses$/, { house: true }],
  ['POST', /^\/changes\/(approve-all|[^/]+\/(approve|reject))$/, { house: true }],
  ['DELETE', /^\/residents\/[^/]+$/, { house: true }],
  ['POST', /^\/residents\/[^/]+\/block$/, { house: true }],
  ['DELETE', /^\/blocks\/[^/]+$/, { house: true }],
  ['POST', /^\/qr\/(?!rotate-all$)[^/]+\/rotate$/, { house: true }],
  ['PUT', /^\/editions\/[^/]+\/houses$/, { house: true }],
  ['PUT', /^\/settings$/, { action: 'settings', label: 'Instellingen opgeslagen' }],
  ['PUT', /^\/view$/, { action: 'view', label: 'Kaartweergave opgeslagen' }],
  ['DELETE', /^\/view$/, { action: 'view', label: 'Kaartweergave gewist' }],
  ['PUT', /^\/pdf-view$/, { action: 'pdf-view', label: 'PDF-kaartvlak opgeslagen' }],
  ['DELETE', /^\/pdf-view$/, { action: 'pdf-view', label: 'PDF-kaartvlak gewist' }],
  ['POST', /^\/logo$/, { action: 'logo', label: 'Logo opgeslagen' }],
  ['DELETE', /^\/logo$/, { action: 'logo', label: 'Logo verwijderd' }],
  ['POST', /^\/logo-small$/, { action: 'logo', label: 'Klein logo opgeslagen' }],
  ['DELETE', /^\/logo-small$/, { action: 'logo', label: 'Klein logo verwijderd' }],
  ['POST', /^\/favicon$/, { action: 'logo', label: 'Favicon opgeslagen' }],
  ['DELETE', /^\/favicon$/, { action: 'logo', label: 'Favicon verwijderd' }],
  ['POST', /^\/backups$/, { action: 'backup', label: 'Backup gemaakt' }],
  ['POST', /^\/backups\/import$/, { action: 'backup', label: 'Backup geüpload' }],
  ['PUT', /^\/backups\/([^/]+)\/title$/, { action: 'backup', label: 'Titel van backup gewijzigd', params: ['backup'] }],
  ['POST', /^\/backups\/([^/]+)\/restore$/, { action: 'backup-restored', label: 'Backup teruggezet', params: ['backup'] }],
  ['POST', /^\/backups\/delete$/, { action: 'backup', label: 'Backups verwijderd' }],
  ['POST', /^\/editions$/, { action: 'edition', label: 'Editie aangemaakt' }],
  ['POST', /^\/editions\/delete$/, { action: 'edition', label: 'Edities verwijderd' }],
  ['PUT', /^\/editions\/([^/]+)$/, { action: 'edition', label: 'Editie hernoemd', params: ['edition'] }],
  ['PUT', /^\/account\/username$/, { action: 'account', label: 'Eigen gebruikersnaam gewijzigd' }],
  ['PUT', /^\/password$/, { action: 'account', label: 'Eigen wachtwoord ingesteld of gewijzigd' }],
  ['POST', /^\/password\/remove$/, { action: 'account', label: 'Eigen wachtwoord verwijderd' }],
  ['DELETE', /^\/passkeys\/([^/]+)$/, { action: 'account', label: 'Eigen passkey verwijderd' }],
  ['POST', /^\/mfa\/confirm$/, { action: 'account', label: 'MFA aangezet' }],
  ['POST', /^\/mfa\/disable$/, { action: 'account', label: 'MFA uitgezet' }],
  ['POST', /^\/mfa\/recovery$/, { action: 'account', label: 'Nieuwe herstelcodes gemaakt' }],
  ['POST', /^\/users\/invites$/, { action: 'users', label: 'Uitnodiging gemaakt' }],
  ['DELETE', /^\/users\/invites\/([^/]+)$/, { action: 'users', label: 'Uitnodiging ingetrokken' }],
  ['POST', /^\/users\/([^/]+)\/reset$/, { action: 'users', label: 'Nieuwe inloglink gemaakt', params: ['user'] }],
  ['DELETE', /^\/users\/([^/]+)$/, { action: 'users', label: 'Gebruiker verwijderd', params: ['user'] }],
  ['DELETE', /^\/messages\/([^/]+)$/, { action: 'message', label: 'Bericht van een bewoner verwijderd' }],
  ['POST', /^\/qr\/rotate-all$/, { action: 'qr', label: 'Alle QR-codes vernieuwd' }],
  ['POST', /^\/push\/subscribe$/, { action: 'push', label: 'Pushmeldingen aangemeld op een apparaat' }],
  ['DELETE', /^\/push\/devices\/([^/]+)$/, { action: 'push', label: 'Pushapparaat verwijderd' }],
  ['POST', /^\/(confirm\/options|mfa\/start|push\/test)$/, { skip: true }],
];
function routeOf(method, url) {
  const p = url.split('?')[0].replace(/\/+$/, '');
  if (!p.startsWith(P)) return null;
  const rest = p.slice(P.length);
  for (const [m, re, info] of ROUTES) {
    const hit = m === method && re.exec(rest);
    if (hit) return { ...info, values: hit.slice(1) };
  }
  return { action: 'other', label: `${method} ${p}` }; // een nieuwe route zonder naam komt er toch in
}

// Middleware voor het beheer (na de inlogcontrole): legt vóór elke wijziging de huizen en instellingen vast, en
// schrijft na een geslaagde wijziging de regels. Een route die zelf regels schrijft, markeert dat in req.audit.
function adminMiddleware(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const route = routeOf(req.method, req.originalUrl);
  if (!route || route.skip) return next();
  const actor = admin(req.user); // vóór de wijziging: na een nieuwe gebruikersnaam of afmelden is de sessie anders
  const before = { houses: snap(store.db().houses), site: siteSnap() };
  req.audit = { actor, houseDone: new Set() };
  res.on('finish', () => {
    if (res.statusCode >= 400) return;
    try {
      const label = route.label || 'Huizen opgeslagen';
      logHouseDiff(actor, before.houses, store.db().houses, route.house ? {} : { via: label }, req.audit.houseDone);
      if (route.house) return;
      const changes = siteDiff(before.site, siteSnap());
      if (['settings', 'view', 'pdf-view'].includes(route.action) && !Object.keys(changes).length) return; // opgeslagen zonder verschil
      const params = Object.fromEntries((route.params || []).map((k, i) => [k, route.values[i]]).filter(([, v]) => v));
      site(actor, route.action, label, { ...(Object.keys(params).length ? { params } : {}), ...(Object.keys(changes).length ? { changes } : {}) });
    } catch (err) {
      console.error('Auditlog:', err.message);
    }
  });
  next();
}

module.exports = { FILE, write, admin, device, SYSTEM, house, site, snap, logHouseDiff, adminMiddleware };
