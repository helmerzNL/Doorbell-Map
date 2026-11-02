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

test('edities: bewaren van de live kaart, met naam en jaartal', async () => {
  await call('PUT', '/api/admin/houses', { houses: [house('h1', '1', 'green'), house('h2', '2', 'red', 0.01), house('h3', '3', 'none', 0.02)] });
  const r = await call('POST', '/api/admin/editions', { name: '  Sint   Maarten ', year: 2025 });
  assert.equal(r.status, 200);
  const e = await r.json();
  assert.equal(e.name, 'Sint Maarten');
  assert.equal(e.year, 2025);
  assert.deepEqual(e.counts, { total: 3, green: 1, red: 1, none: 1 });

  const list = await (await call('GET', '/api/admin/editions')).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].source, 'live');
  assert.equal(list[0].houses, undefined); // de lijst bevat geen huizen, alleen aantallen
  const full = await (await call('GET', `/api/admin/editions/${e.id}`)).json();
  assert.deepEqual(full.houses.map((h) => [h.id, h.status]), [['h1', 'green'], ['h2', 'red'], ['h3', 'none']]);

  // de live kaart verandert daarna, de editie niet
  await call('PUT', '/api/admin/houses', { houses: [house('h1', '1', 'red')] });
  const again = await (await call('GET', `/api/admin/editions/${e.id}`)).json();
  assert.equal(again.houses.length, 3);
  assert.equal(again.houses[0].status, 'green');
  assert.equal((await (await j('/api/map')).json()).houses.length, 1);
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

test('edities: een editie maken van een backup', async () => {
  await call('PUT', '/api/admin/houses', { houses: [house('b1', '10', 'green'), house('b2', '12', 'green', 0.01)] });
  const id = backups.create('test editie', true, { force: true });
  await call('PUT', '/api/admin/houses', { houses: [] });
  // een lege kaart bewaren heeft geen zin
  const empty = await call('POST', '/api/admin/editions', { name: 'Leeg', year: 2024 });
  assert.equal(empty.status, 400);
  assert.match((await empty.json()).error, /geen huizen/);
  const r = await call('POST', '/api/admin/editions', { name: 'Vorig jaar', year: 2024, from: id });
  assert.equal(r.status, 200);
  const e = await r.json();
  assert.deepEqual(e.counts, { total: 2, green: 2, red: 0, none: 0 });
  const item = (await (await call('GET', '/api/admin/editions')).json()).find((x) => x.id === e.id);
  assert.equal(item.source, 'backup');
  assert.ok(item.sourceDate);
  assert.equal((await call('POST', '/api/admin/editions', { name: 'X', year: 2024, from: '1234567890123-abcdef' })).status, 404);
  assert.equal((await call('POST', '/api/admin/editions', { name: 'X', year: 2024, from: '../../db' })).status, 404);
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
