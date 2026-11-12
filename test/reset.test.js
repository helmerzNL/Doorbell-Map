const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-reset-'));
process.env.SETUP_TOKEN = 'test-setup-token-123';
process.env.SESSION_SECRET = 'test-session-secret-123';
const app = require('../server/index.js');
const store = require('../server/store');
const backups = require('../server/backups');
const { resetStatuses } = require('../server/houses');

let server, base;
test.before(() => new Promise((r) => { server = app.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); }); }));
test.after(() => server.close());

const exp = String(Date.now() + 3600e3);
const cookie = `sm_session=${exp}.${crypto.createHmac('sha256', 'test-session-secret-123').update(exp).digest('base64url')}`;
store.db().users.push({ id: 'owner', username: 'beheerder', createdAt: new Date().toISOString(), epoch: 0, webauthnId: 'dGVzdA', password: null, mfa: null, recovery: [] });

const send = (method, p, body, c = cookie) => fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(c ? { cookie: c } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const sq = (d = 0) => [[52.02 + d, 5.16], [52.02 + d, 5.161], [52.021 + d, 5.161]];
const house = (id, number, status, d = 0) => ({ id, street: 'Resetstraat', number, status, note: `notitie ${number}`, points: sq(d) });
const statuses = async () => Object.fromEntries((await (await fetch(`${base}/api/map`)).json()).houses.map((h) => [h.id, h.status]));

test('resetStatuses zet alleen groen en rood terug en telt ze', () => {
  const list = [{ status: 'green' }, { status: 'red' }, { status: 'red' }, { status: 'none' }, {}];
  assert.deepEqual(resetStatuses(list), { green: 1, red: 2 });
  assert.deepEqual(list.map((h) => h.status), ['none', 'none', 'none', 'none', undefined]);
  assert.deepEqual(resetStatuses([]), { green: 0, red: 0 });
});

test('resetten vereist een ingelogde beheerder', async () => {
  assert.equal((await send('PUT', '/api/admin/houses', { houses: [house('a', '1', 'green')] })).status, 200);
  assert.equal((await send('POST', '/api/admin/houses/reset', {}, '')).status, 401);
  assert.deepEqual(await statuses(), { a: 'green' });
});

test('zonder gemarkeerde huizen valt er niets te resetten: 409 en niets verandert', async () => {
  assert.equal((await send('PUT', '/api/admin/houses', { houses: [house('a', '1', 'none'), house('b', '2', 'none', 0.01)] })).status, 200);
  const before = backups.list().length;
  const r = await send('POST', '/api/admin/houses/reset', {});
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /niets te resetten/);
  assert.deepEqual(await statuses(), { a: 'none', b: 'none' });
  assert.equal(backups.list().length, before); // ook geen backup erbij: de stand was al bewaard
});

test('alle groene en rode huizen worden niet gemarkeerd; de rest van het huis blijft zoals het was', async () => {
  const houses = [house('g1', '1', 'green'), house('g2', '2', 'green', 0.01), house('r1', '3', 'red', 0.02), house('n1', '4', 'none', 0.03)];
  assert.equal((await send('PUT', '/api/admin/houses', { houses })).status, 200);
  const before = (await (await fetch(`${base}/api/map`)).json()).houses; // zoals de server ze bewaart (coördinaten afgerond)
  const r = await send('POST', '/api/admin/houses/reset', {});
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { reset: { green: 2, red: 1 }, proposals: 0 });
  assert.deepEqual(await statuses(), { g1: 'none', g2: 'none', r1: 'none', n1: 'none' });
  const after = (await (await fetch(`${base}/api/map`)).json()).houses;
  assert.deepEqual(after, before.map((h) => ({ ...h, status: 'none' }))); // alleen de status is anders: adres, notitie en vorm niet
  assert.deepEqual(store.db().houses.map((h) => h.status), ['none', 'none', 'none', 'none']); // ook op schijf
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'db.json'), 'utf8')).houses.map((h) => h.status), ['none', 'none', 'none', 'none']);
  // nog eens: er is niets meer om te resetten
  assert.equal((await send('POST', '/api/admin/houses/reset', {})).status, 409);
});

test('de stand van vóór de reset staat in een backup, en terugzetten maakt de reset ongedaan', async () => {
  assert.equal((await send('PUT', '/api/admin/houses', { houses: [house('u1', '1', 'green'), house('u2', '2', 'red', 0.01)] })).status, 200);
  assert.equal((await send('POST', '/api/admin/houses/reset', {})).status, 200);
  const list = backups.list();
  assert.equal(list[0].reason, 'Kaart gereset'); // de gewone backup na de wijziging
  assert.deepEqual(backups.read(list[0].id).houses.map((h) => h.status), ['none', 'none']);
  // Een backup met de oude stand bestaat altijd: de reden is "Voor het resetten", of de gewone backup na de laatste opslag
  // als die de stand al bevatte (een backup van een ongewijzigde stand wordt niet dubbel gemaakt).
  const pre = list.find((b) => backups.read(b.id).houses.map((h) => h.status).join() === 'green,red');
  assert.ok(pre, 'backup met de stand van vóór de reset');
  assert.deepEqual(await statuses(), { u1: 'none', u2: 'none' });
  assert.equal((await send('POST', `/api/admin/backups/${pre.id}/restore`, {})).status, 200);
  assert.deepEqual(await statuses(), { u1: 'green', u2: 'red' });
});

test('een backup van een stand die nog nergens bewaard is, krijgt de reden "Voor het resetten"', async () => {
  const [a, b] = store.db().houses; // een stand die in geen enkele backup staat, direct in de database gezet
  [a.status, b.status] = ['red', 'green'];
  store.save();
  assert.equal((await send('POST', '/api/admin/houses/reset', {})).status, 200);
  const pre = backups.list().find((x) => x.reason === 'Voor het resetten');
  assert.ok(pre);
  assert.deepEqual(backups.read(pre.id).houses.map((h) => h.status), ['red', 'green']);
});

test('edities blijven zoals ze waren: alleen de live kaart wordt gereset', async () => {
  assert.equal((await send('PUT', '/api/admin/houses', { houses: [house('e1', '1', 'green'), house('e2', '2', 'red', 0.01), house('e3', '3', 'green', 0.02)] })).status, 200);
  const ed = await (await send('POST', '/api/admin/editions', { name: 'Vorige keer', year: 2025 })).json();
  assert.deepEqual(ed.counts, { total: 3, green: 2, red: 1, none: 0 });
  assert.equal((await send('POST', '/api/admin/houses/reset', {})).status, 200);
  assert.deepEqual(await statuses(), { e1: 'none', e2: 'none', e3: 'none' });
  const kept = await (await send('GET', `/api/admin/editions/${ed.id}`)).json();
  assert.deepEqual(kept.houses.map((h) => h.status), ['green', 'red', 'green']);
  assert.deepEqual(kept.counts, { total: 3, green: 2, red: 1, none: 0 });
  assert.equal(kept.updatedAt, null);
});

test('bewoners: de koppeling blijft, openstaande wijzigingen vervallen en de bewoner ziet "niet doorgevoerd"', async () => {
  assert.equal((await send('PUT', '/api/admin/settings', { residentsEnabled: true, residentsAppOnly: false })).status, 200);
  assert.equal((await send('PUT', '/api/admin/houses', { houses: [house('p1', '1', 'green'), house('p2', '2', 'none', 0.01), house('p3', '3', 'none', 0.02)] })).status, 200);
  const dev = async (houseId) => {
    const r = await send('POST', '/api/resident/claim', { houseId }, '');
    assert.equal(r.status, 200);
    return r.headers.get('set-cookie').split(';')[0];
  };
  const d1 = await dev('p1'), d2 = await dev('p2'), d3 = await dev('p3');
  assert.equal((await send('POST', '/api/resident/set', { status: 'red' }, d1)).status, 200); // p1: groen -> rood voorgesteld
  assert.equal((await send('POST', '/api/resident/set', { status: 'green' }, d2)).status, 200); // p2: niet gemarkeerd -> groen voorgesteld
  assert.equal((await (await send('GET', '/api/admin/changes')).json()).pending.length, 2);

  const r = await send('POST', '/api/admin/houses/reset', {});
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { reset: { green: 1, red: 0 }, proposals: 2 });
  const changes = await (await send('GET', '/api/admin/changes')).json();
  assert.deepEqual(changes.pending, []); // een volgende "Alles goedkeuren" markeert dus niets meer
  assert.equal(changes.residents.length, 3); // alle koppelingen blijven
  assert.equal((await (await send('GET', '/api/admin/changes/count')).json()).pending, 0);

  const me1 = await (await send('GET', '/api/resident/me', undefined, d1)).json();
  assert.equal(me1.claim.houseId, 'p1');
  assert.equal(me1.approved, 'none');
  assert.equal(me1.pending, false);
  assert.deepEqual([me1.notice.decision, me1.notice.status], ['rejected', 'red']);
  const me2 = await (await send('GET', '/api/resident/me', undefined, d2)).json();
  assert.deepEqual([me2.pending, me2.notice.decision, me2.notice.status], [false, 'rejected', 'green']);
  const me3 = await (await send('GET', '/api/resident/me', undefined, d3)).json();
  assert.deepEqual([me3.pending, me3.notice], [false, null]); // geen voorstel gehad: geen melding

  // de bewoner kan voor de volgende keer gewoon weer iets voorstellen
  assert.equal((await send('POST', '/api/resident/set', { status: 'green' }, d1)).status, 200);
  assert.equal((await (await send('GET', '/api/admin/changes')).json()).pending.length, 1);
});
