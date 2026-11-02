const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-ed-'));
process.env.SETUP_TOKEN = 'test-setup-token-123';
process.env.SESSION_SECRET = 'test-session-secret-123';
const app = require('../server/index.js');
const backups = require('../server/backups');
const { compare, match, counts } = require('../public/js/compare');

let server, base;
test.before(() => new Promise((r) => { server = app.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); }); }));
test.after(() => server.close());

const exp = String(Date.now() + 3600e3);
const cookie = `sm_session=${exp}.${crypto.createHmac('sha256', 'test-session-secret-123').update(exp).digest('base64url')}`;
const H = (c = cookie) => ({ 'Content-Type': 'application/json', ...(c ? { cookie: c } : {}) });
const j = (p, o) => fetch(base + p, o);
const call = (method, p, body, c) => j(p, { method, headers: H(c), body: body === undefined ? undefined : JSON.stringify(body) });

const sq = (d = 0) => [[52.02 + d, 5.16], [52.02 + d, 5.161], [52.021 + d, 5.161]];
const house = (id, number, status, d = 0) => ({ id, street: 'Teststraat', number, note: '', status, points: sq(d) });

const liveMap = async () => (await (await j('/api/map')).json()).houses;
const backupsH = require('../server/backups');

test('edities: aanmaken als kopie van de live kaart; de live kaart verandert niet', async () => {
  await call('PUT', '/api/admin/houses', { houses: [house('h1', '1', 'green'), house('h2', '2', 'red', 0.01), house('h3', '3', 'none', 0.02)] });
  const before = fs.readFileSync(path.join(process.env.DATA_DIR, 'db.json'), 'utf8');
  const r = await call('POST', '/api/admin/editions', { name: '  Sint   Maarten ', year: 2025 });
  assert.equal(r.status, 200);
  const e = await r.json();
  assert.equal(e.name, 'Sint Maarten');
  assert.equal(e.year, 2025);
  assert.deepEqual(e.counts, { total: 3, green: 1, red: 1, none: 1 });
  assert.equal(fs.readFileSync(path.join(process.env.DATA_DIR, 'db.json'), 'utf8'), before); // live kaart onaangeroerd

  const list = await (await call('GET', '/api/admin/editions')).json();
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].copiedFrom, { id: 'live', label: 'Live' });
  assert.equal(list[0].houses, undefined); // de lijst bevat geen huizen, alleen aantallen
  const full = await (await call('GET', `/api/admin/editions/${e.id}`)).json();
  assert.deepEqual(full.houses.map((h) => [h.id, h.status]), [['h1', 'green'], ['h2', 'red'], ['h3', 'none']]);

  // de live kaart verandert daarna, de editie niet
  await call('PUT', '/api/admin/houses', { houses: [house('h1', '1', 'red')] });
  const again = await (await call('GET', `/api/admin/editions/${e.id}`)).json();
  assert.equal(again.houses.length, 3);
  assert.equal(again.houses[0].status, 'green');
  assert.equal((await liveMap()).length, 1);
});

test('edities: bewerken slaat alleen in die editie op, nooit in de live kaart', async () => {
  const [e] = await (await call('GET', '/api/admin/editions')).json();
  const live = await liveMap();
  const before = fs.readFileSync(path.join(process.env.DATA_DIR, 'db.json'), 'utf8');
  const full = await (await call('GET', `/api/admin/editions/${e.id}`)).json();
  const changed = full.houses.map((h) => ({ ...h, status: h.id === 'h3' ? 'green' : h.status }));
  changed.push(house('h9', '9', 'red', 0.03)); // ook een huis toevoegen kan
  const r = await call('PUT', `/api/admin/editions/${e.id}/houses`, { houses: changed });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).counts, { total: 4, green: 2, red: 2, none: 0 });
  assert.deepEqual(await liveMap(), live);
  assert.equal(fs.readFileSync(path.join(process.env.DATA_DIR, 'db.json'), 'utf8'), before);
  const item = (await (await call('GET', '/api/admin/editions')).json()).find((x) => x.id === e.id);
  assert.deepEqual(item.counts, { total: 4, green: 2, red: 2, none: 0 });
  assert.ok(item.updatedAt);
  // ongeldig of onbekend
  assert.equal((await call('PUT', `/api/admin/editions/${e.id}/houses`, { houses: [{ points: [[1, 1]] }] })).status, 400);
  assert.equal((await call('PUT', `/api/admin/editions/${e.id}/houses`, {})).status, 400);
  assert.equal((await call('PUT', '/api/admin/editions/1234567890123-abcdef/houses', { houses: [] })).status, 404);
  assert.equal((await call('PUT', `/api/admin/editions/${e.id}/houses`, { houses: [] }, '')).status, 401);
});

test('edities: kopie van een andere editie; een backup kan geen bron zijn', async () => {
  const [src] = await (await call('GET', '/api/admin/editions')).json();
  const r = await call('POST', '/api/admin/editions', { name: 'Sint Maarten', year: 2026, from: src.id });
  assert.equal(r.status, 200);
  const e = await r.json();
  assert.deepEqual(e.counts, src.counts);
  const item = (await (await call('GET', '/api/admin/editions')).json()).find((x) => x.id === e.id);
  assert.deepEqual(item.copiedFrom, { id: src.id, label: 'Sint Maarten 2025' });
  // een backup-id (of iets anders) als bron wordt geweigerd en maakt niets aan
  const count = (await (await call('GET', '/api/admin/editions')).json()).length;
  const bid = backupsH.create('test bron', true, { force: true });
  assert.equal((await call('POST', '/api/admin/editions', { name: 'X', year: 2024, from: bid })).status, 404);
  assert.equal((await call('POST', '/api/admin/editions', { name: 'X', year: 2024, from: '../../db' })).status, 404);
  assert.equal((await call('POST', '/api/admin/editions', { name: 'X', year: 2024, from: 12 })).status, 404);
  assert.equal((await (await call('GET', '/api/admin/editions')).json()).length, count);
  // een lege live kaart kopiëren heeft geen zin
  const live = await liveMap();
  await call('PUT', '/api/admin/houses', { houses: [] });
  const empty = await call('POST', '/api/admin/editions', { name: 'Leeg', year: 2024 });
  assert.equal(empty.status, 400);
  assert.match((await empty.json()).error, /geen huizen/);
  await call('PUT', '/api/admin/houses', { houses: live });
});

test('backups: nemen alle edities mee, tonen welke, en zetten ze terug', async () => {
  await new Promise((r) => setTimeout(r, 50));
  const eds = await (await call('GET', '/api/admin/editions')).json();
  const id = backupsH.create('test met edities', true, { force: true });
  const b = backupsH.read(id);
  assert.equal(b.editions.length, eds.length);
  assert.ok(b.editions.every((e) => Array.isArray(e.houses) && e.houses.length));
  const item = (await (await call('GET', '/api/admin/backups')).json()).find((x) => x.id === id);
  assert.deepEqual(item.editions.map((e) => e.label).sort(), eds.map((e) => (e.name.includes(String(e.year)) ? e.name : `${e.name} ${e.year}`)).sort());

  // een editie aanmaken maakt zelf ook een backup (met die editie erin)
  const made = await (await call('POST', '/api/admin/editions', { name: 'Na de backup', year: 2027 })).json();
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(backupsH.read(backupsH.list()[0].id).editions.some((e) => e.id === made.id));

  // terugzetten: precies de edities uit de backup, met hun huizen
  await call('PUT', `/api/admin/editions/${eds[0].id}/houses`, { houses: [house('z', '1', 'red')] });
  assert.equal((await call('POST', `/api/admin/backups/${id}/restore`, {})).status, 200);
  const after = await (await call('GET', '/api/admin/editions')).json();
  assert.deepEqual(after.map((e) => e.id).sort(), eds.map((e) => e.id).sort()); // "Na de backup" is weer weg
  assert.deepEqual(after.find((e) => e.id === eds[0].id).counts, eds[0].counts);

  // een backup van vóór de edities (zonder dat veld) laat de edities met rust
  const old = { houses: b.houses, view: null, texts: b.texts };
  const up = await (await call('POST', '/api/admin/backups/import', old)).json();
  assert.equal((await (await call('GET', '/api/admin/backups')).json()).find((x) => x.id === up.id).editions, null);
  assert.equal((await call('POST', `/api/admin/backups/${up.id}/restore`, {})).status, 200);
  assert.equal((await (await call('GET', '/api/admin/editions')).json()).length, eds.length);
});

test('backups: uploaden met edities controleert die edities', async () => {
  const id = backupsH.list().find((x) => Array.isArray(x.editions) && x.editions.length).id;
  const file = await (await call('GET', `/api/admin/backups/${id}`)).json();
  const ok = await call('POST', '/api/admin/backups/import', file);
  assert.equal(ok.status, 200);
  assert.notEqual((await ok.json()).id, file.id); // het id komt nooit uit het bestand
  const e0 = file.editions[0];
  for (const bad of [{ ...file, editions: 'nee' }, { ...file, editions: [{ ...e0, year: 1 }] }, { ...file, editions: [{ ...e0, name: '' }] }, { ...file, editions: [{ ...e0, houses: [{ points: [[1, 1]] }] }] }, { ...file, editions: Array(101).fill(e0) }]) {
    const r = await call('POST', '/api/admin/backups/import', bad);
    assert.equal(r.status, 400, JSON.stringify(bad.editions).slice(0, 60));
  }
  // een backup met veel edities mag groter zijn dan 2 MB (andere verzoeken niet), en alleen na inloggen
  const ring = (i) => Array.from({ length: 60 }, (_, k) => [52 + i * 1e-4 + Math.cos(k / 10) * 1e-5, 5 + Math.sin(k / 10) * 1e-5]);
  const bigHouses = Array.from({ length: 2000 }, (_, i) => ({ id: `b${i}`, street: 'Lange straat', number: String(i), status: 'green', points: ring(i) }));
  const big = { ...file, editions: [{ ...e0, houses: bigHouses }] };
  assert.ok(JSON.stringify(big).length > 2 * 1024 * 1024);
  assert.equal((await call('POST', '/api/admin/backups/import', big)).status, 200);
  assert.equal((await call('POST', '/api/admin/backups/import', big, '')).status, 401);
  assert.equal((await call('PUT', `/api/admin/editions/${e0.id}/houses`, { houses: bigHouses, pad: 'x'.repeat(2 * 1024 * 1024) })).status, 413);
  // dubbele id's krijgen een eigen id
  const dup = await (await call('POST', '/api/admin/backups/import', { ...file, editions: [e0, e0] })).json();
  const ids = backupsH.read(dup.id).editions.map((e) => e.id);
  assert.equal(new Set(ids).size, 2);
});

test('edities: naam en jaartal zijn verplicht en worden gecontroleerd', async () => {
  for (const bad of [{ year: 2025 }, { name: '   ', year: 2025 }, { name: 'x'.repeat(61), year: 2025 }, { name: 'A' }, { name: 'A', year: 1800 }, { name: 'A', year: 2025.5 }, { name: 'A', year: 'twintig' }]) {
    const r = await call('POST', '/api/admin/editions', bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.ok((await r.json()).error);
  }
  // een jaartal als tekst (uit een invoerveld) is goed
  assert.equal((await call('POST', '/api/admin/editions', { name: 'Tekstjaar', year: '2024' })).status, 200);
});

test('edities: volgorde, naam/jaartal wijzigen en onbekende edities', async () => {
  const list = await (await call('GET', '/api/admin/editions')).json();
  assert.deepEqual(list.map((x) => x.year), [...list.map((x) => x.year)].sort((a, b) => b - a)); // nieuwste jaar eerst
  const id = list[0].id;
  const r = await call('PUT', `/api/admin/editions/${id}`, { name: 'Halloween', year: 2023 });
  assert.equal(r.status, 200);
  const e = await (await call('GET', `/api/admin/editions/${id}`)).json();
  assert.equal(e.name, 'Halloween');
  assert.equal(e.year, 2023);
  assert.ok(e.houses.length > 0); // huizen blijven zoals ze waren
  assert.equal((await call('PUT', `/api/admin/editions/${id}`, { name: '', year: 2023 })).status, 400);
  assert.equal((await call('PUT', '/api/admin/editions/1234567890123-abcdef', { name: 'A', year: 2023 })).status, 404);
  assert.equal((await call('GET', '/api/admin/editions/1234567890123-abcdef')).status, 404);
  assert.equal((await call('GET', '/api/admin/editions/..%2F..%2Fdb')).status, 404);
});

test('edities: alleen met beheersessie, en verwijderen vereist een passkey', async () => {
  const list = await (await call('GET', '/api/admin/editions')).json();
  assert.equal((await call('GET', '/api/admin/editions', undefined, '')).status, 401);
  assert.equal((await call('GET', `/api/admin/editions/${list[0].id}`, undefined, '')).status, 401);
  assert.equal((await call('POST', '/api/admin/editions', { name: 'A', year: 2025 }, '')).status, 401);
  assert.equal((await call('PUT', `/api/admin/editions/${list[0].id}`, { name: 'A', year: 2025 }, '')).status, 401);
  for (const ids of [[], ['../../db'], 'x', [1]]) {
    assert.equal((await call('POST', '/api/admin/editions/delete', { ids })).status, 400, JSON.stringify(ids));
  }
  const noProof = await call('POST', '/api/admin/editions/delete', { ids: [list[0].id] });
  assert.equal(noProof.status, 400);
  assert.equal((await (await call('GET', '/api/admin/editions')).json()).length, list.length);
});

// ---------- vergelijken (public/js/compare.js) ----------
test('vergelijken: koppelen op id, anders op uniek adres', () => {
  const a = [house('x', '1', 'green'), { ...house('old', '2', 'green'), street: 'Teststraat ' }, house('dup1', '5', 'red'), house('dup2', '5', 'red'), house('gone', '9', 'green')];
  const b = [house('x', '1', 'red'), house('new', '2', 'green'), house('dup3', '5', 'green'), house('fresh', '7', 'green')];
  const pairs = match(a, b);
  const key = (p) => `${p.a ? p.a.id : '-'}:${p.b ? p.b.id : '-'}`;
  assert.deepEqual(pairs.map(key).sort(), ['-:dup3', '-:fresh', 'dup1:-', 'dup2:-', 'gone:-', 'old:new', 'x:x'].sort());
  // elk huis precies één keer
  assert.equal(pairs.filter((p) => p.a).length, a.length);
  assert.equal(pairs.filter((p) => p.b).length, b.length);
});

test('vergelijken: wie doet wel en niet mee, en de aantallen', () => {
  const a = [house('1', '1', 'green'), house('2', '2', 'green'), house('3', '3', 'red'), house('4', '4', 'none')];
  const b = [house('1', '1', 'green'), house('2', '2', 'red'), house('3', '3', 'green'), house('5', '5', 'green')];
  const r = compare(a, b);
  assert.deepEqual(r.cats, { both: 1, onlyA: 1, onlyB: 2, neither: 1 });
  assert.deepEqual(r.a, { total: 4, green: 2, red: 1, none: 1 });
  assert.deepEqual(r.b, { total: 4, green: 3, red: 1, none: 0 });
  assert.equal(r.pairs.find((p) => p.b && p.b.id === '5').cat, 'onlyB');
  assert.deepEqual(counts([{ status: 'onzin' }]), { total: 1, green: 0, red: 0, none: 1 });
  assert.deepEqual(compare([], []).cats, { both: 0, onlyA: 0, onlyB: 0, neither: 0 });
});
