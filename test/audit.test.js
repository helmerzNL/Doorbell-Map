const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-audit-'));
process.env.SETUP_TOKEN = 'test-setup-token-123';
process.env.SESSION_SECRET = 'test-session-secret-123';
const app = require('../server/index.js');
const store = require('../server/store');
const backups = require('../server/backups');
const audit = require('../server/audit');

let server, base;
test.before(() => new Promise((r) => { server = app.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); }); }));
test.after(() => server.close());

const exp = String(Date.now() + 3600e3);
const cookie = `sm_session=${exp}.${crypto.createHmac('sha256', 'test-session-secret-123').update(exp).digest('base64url')}`;
store.db().users.push({ id: 'owner', username: 'beheerder', createdAt: new Date().toISOString(), epoch: 0, webauthnId: 'dGVzdA', password: null, mfa: null, recovery: [] });
const ADMIN = { type: 'admin', id: 'owner', name: 'beheerder' };

const j = (p, o) => fetch(base + p, o);
const send = (method, p, body, c = cookie) => j(p, { method, headers: { 'Content-Type': 'application/json', ...(c ? { cookie: c } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const sq = (d = 0) => [[52.02 + d, 5.16], [52.02 + d, 5.161], [52.021 + d, 5.161]];
const house = (id, number, status, d = 0, extra = {}) => ({ id, street: 'Auditstraat', number, status, note: '', points: sq(d), ...extra });

// De regels van de log (elke regel is een JSON-object), en die van na een bepaald moment.
const lines = () => (fs.existsSync(audit.FILE) ? fs.readFileSync(audit.FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const mark = () => lines().length;
const since = (n) => lines().slice(n);

test('de log staat als JSON Lines in de datamap', () => {
  assert.equal(audit.FILE, path.join(process.env.DATA_DIR, 'audit-log.jsonl'));
});

test('huizen: toevoegen, wijzigen en verwijderen in de layout, met wie het deed; een mislukte poging telt niet', async () => {
  let n = mark();
  assert.equal((await send('PUT', '/api/admin/houses', { houses: [house('h1', '1', 'none'), house('h2', '2', 'green', 0.01)] })).status, 200);
  let got = since(n);
  assert.deepEqual(got.map((e) => [e.category, e.action, e.house.id]), [['house', 'added', 'h1'], ['house', 'added', 'h2']]);
  assert.deepEqual(got[0].actor, ADMIN);
  assert.match(got[0].summary, /^Auditstraat 1: toegevoegd \(niet gemarkeerd\) \(beheerder beheerder\)$/);
  assert.ok(got[0].at && !Number.isNaN(Date.parse(got[0].at)));

  n = mark();
  assert.equal((await send('PUT', '/api/admin/houses', { houses: [house('h1', '1a', 'red', 0, { points: sq(0.001) }), house('h3', '3', 'none', 0.02)] })).status, 200);
  got = since(n);
  const byId = Object.fromEntries(got.map((e) => [e.house.id, e]));
  assert.deepEqual(byId.h1.changes, { status: { from: 'none', to: 'red' }, address: { from: 'Auditstraat 1', to: 'Auditstraat 1a' }, shape: true });
  assert.equal(byId.h2.action, 'removed');
  assert.equal(byId.h3.action, 'added');
  assert.ok(!JSON.stringify(got).includes('52.02')); // geen coördinaten, alleen dát de vorm veranderde
  assert.ok(!got.some((e) => e.category === 'site')); // geen aparte siteregel voor de layout

  n = mark();
  assert.equal((await send('PUT', '/api/admin/houses', { houses: [{ points: [[1, 1]] }] })).status, 400);
  assert.equal((await send('PUT', '/api/admin/houses', { houses: [] }, '')).status, 401);
  assert.equal(since(n).length, 0);
});

test('bewoners: elk voorstel van een apparaat staat erin, zodat te zien is dat het 3x zijn huis aanpaste', async () => {
  assert.equal((await send('PUT', '/api/admin/settings', { residentsEnabled: true, residentsAppOnly: false })).status, 200);
  assert.equal((await send('PUT', '/api/admin/houses', { houses: [house('r1', '10', 'none'), house('r2', '11', 'none', 0.01)] })).status, 200);
  let n = mark();
  const claim = await send('POST', '/api/resident/claim', { houseId: 'r1' }, '');
  assert.equal(claim.status, 200);
  const dev = claim.headers.get('set-cookie').split(';')[0];
  const linked = since(n);
  assert.equal(linked.length, 1);
  assert.equal(linked[0].action, 'device-linked');
  assert.equal(linked[0].actor.type, 'device');
  const rid = linked[0].actor.id;
  assert.match(rid, /^[0-9a-f]{12}$/);
  assert.equal(linked[0].via, 'list');

  n = mark();
  for (const s of ['green', 'red', 'green']) assert.equal((await send('POST', '/api/resident/set', { status: s }, dev)).status, 200);
  assert.equal((await send('POST', '/api/resident/set', { status: 'green' }, dev)).status, 200); // hetzelfde nog eens: geen wijziging
  let got = since(n);
  assert.deepEqual(got.map((e) => [e.action, e.to, e.actor.id]), [['proposed', 'green', rid], ['proposed', 'red', rid], ['proposed', 'green', rid]]);
  assert.ok(got.every((e) => e.category === 'house' && e.house.id === 'r1' && e.from === 'none'));
  assert.equal(lines().filter((e) => e.actor.type === 'device' && e.actor.id === rid && e.action === 'proposed').length, 3);

  // intrekken, opnieuw voorstellen en goedkeuren: de goedkeuring noemt de beheerder én het apparaat, één keer
  n = mark();
  assert.equal((await send('POST', '/api/resident/set', { status: 'none' }, dev)).status, 200);
  assert.equal((await send('POST', '/api/resident/set', { status: 'red' }, dev)).status, 200);
  const pending = (await (await send('GET', '/api/admin/changes')).json()).pending;
  assert.equal((await send('POST', `/api/admin/changes/${pending[0].id}/approve`, {})).status, 200);
  got = since(n);
  assert.deepEqual(got.map((e) => e.action), ['proposal-withdrawn', 'proposed', 'approved']);
  assert.deepEqual(got[2].actor, ADMIN);
  assert.deepEqual([got[2].device, got[2].from, got[2].to], [rid, 'none', 'red']);
  assert.match(got[2].summary, /voorstel goedgekeurd: niet gemarkeerd → rood \(beheerder beheerder, apparaat [0-9a-f]{12}\)$/);

  // afwijzen
  n = mark();
  assert.equal((await send('POST', '/api/resident/set', { status: 'green' }, dev)).status, 200);
  const p2 = (await (await send('GET', '/api/admin/changes')).json()).pending[0];
  assert.equal((await send('POST', `/api/admin/changes/${p2.id}/reject`, {})).status, 200);
  assert.deepEqual(since(n).map((e) => [e.action, e.from, e.to]), [['proposed', 'red', 'green'], ['rejected', 'red', 'green']]);

  // ontkoppelen, blokkeren en de blokkade opheffen
  const dev2 = (await send('POST', '/api/resident/claim', { houseId: 'r2' }, '')).headers.get('set-cookie').split(';')[0];
  assert.ok(dev2);
  const rs = (await (await send('GET', '/api/admin/changes')).json()).residents;
  n = mark();
  assert.equal((await send('DELETE', `/api/admin/residents/${rs.find((r) => r.houseId === 'r1').rid}`)).status, 200);
  assert.equal((await send('POST', `/api/admin/residents/${rs.find((r) => r.houseId === 'r2').rid}/block`, { withIp: true })).status, 200);
  const blockId = (await (await send('GET', '/api/admin/changes')).json()).blocked[0].id;
  assert.equal((await send('DELETE', `/api/admin/blocks/${blockId}`)).status, 200);
  got = since(n);
  assert.deepEqual(got.map((e) => [e.category, e.action, e.house.address]), [['house', 'device-unlinked', 'Auditstraat 10'], ['house', 'device-blocked', 'Auditstraat 11'], ['house', 'device-unblocked', 'Auditstraat 11']]);
  assert.equal(got[0].device, rid);
  assert.equal(got[1].withIp, true);
});

test('site: instellingen met wat er veranderde, de toegangscode zonder waarde; logo, weergave en backups', async () => {
  let n = mark();
  assert.equal((await send('PUT', '/api/admin/settings', { simpleUi: true, siteTitle: 'Audit-wijk', residentsCode: '918273' })).status, 200);
  let got = since(n);
  assert.equal(got.length, 1);
  assert.deepEqual([got[0].category, got[0].action], ['site', 'settings']);
  assert.deepEqual(got[0].actor, ADMIN);
  assert.deepEqual(got[0].changes['settings.simpleUi'], { from: null, to: true });
  assert.deepEqual(got[0].changes['settings.siteTitle'], { from: '', to: 'Audit-wijk' });
  assert.deepEqual(got[0].changes['settings.residentsCode'], { changed: true });
  assert.ok(!fs.readFileSync(audit.FILE, 'utf8').includes('918273'));
  // nog eens hetzelfde opslaan verandert niets en geeft dus geen regel
  n = mark();
  assert.equal((await send('PUT', '/api/admin/settings', { simpleUi: true, siteTitle: 'Audit-wijk' })).status, 200);
  assert.equal(since(n).length, 0);

  n = mark();
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  assert.equal((await j('/api/admin/logo', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', cookie }, body: PNG })).status, 200);
  assert.equal((await send('PUT', '/api/admin/view', { center: [52.02, 5.16], zoom: 17 })).status, 200);
  const { id } = await (await send('POST', '/api/admin/backups', { title: 'Audit' })).json();
  got = since(n);
  assert.deepEqual(got.map((e) => [e.category, e.action]), [['site', 'logo'], ['site', 'view'], ['site', 'backup']]);
  assert.match(got[0].summary, /^Logo opgeslagen \(beheerder beheerder\)$/);
  assert.deepEqual(got[1].changes.view.to.center, [52.02, 5.16]);

  // terugzetten: een siteregel met de backup, en per huis wat er veranderde
  assert.equal((await send('PUT', '/api/admin/houses', { houses: [] })).status, 200);
  n = mark();
  assert.equal((await send('POST', `/api/admin/backups/${id}/restore`, {})).status, 200);
  got = since(n);
  const restored = got.find((e) => e.action === 'backup-restored');
  assert.deepEqual(restored.params, { backup: id });
  assert.ok(got.some((e) => e.category === 'house' && e.action === 'added' && e.via === 'Backup teruggezet'));
  assert.ok(backups.read(id)); // de log zelf zit niet in de backups
  assert.ok(!JSON.stringify(backups.read(id)).includes('audit'));
});

test('edities: huizen van een editie staan erin met de editie erbij', async () => {
  const e = await (await send('POST', '/api/admin/editions', { name: 'Auditeditie', year: 2026 })).json();
  assert.ok(e.id);
  const n = mark();
  const houses = (await (await send('GET', `/api/admin/editions/${e.id}`)).json()).houses;
  houses[0].status = houses[0].status === 'green' ? 'red' : 'green';
  assert.equal((await send('PUT', `/api/admin/editions/${e.id}/houses`, { houses })).status, 200);
  const got = since(n);
  assert.equal(got.length, 1);
  assert.deepEqual([got[0].category, got[0].action, got[0].edition.id], ['house', 'changed', e.id]);
  assert.match(got[0].summary, / in editie Auditeditie 2026: status /);
});

test('inloggegevens: wel dát er iets veranderde, nooit het wachtwoord; geen IP-adressen in de log', async () => {
  const owner = store.db().users.find((u) => u.id === 'owner');
  owner.password = await require('../server/password').hashPassword('het-oude-wachtwoord-11');
  const n = mark();
  const r = await send('PUT', '/api/admin/password', { password: 'een-heel-geheim-wachtwoord-77', confirm: { password: 'het-oude-wachtwoord-11' } });
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  const got = since(n);
  assert.deepEqual(got.map((e) => [e.category, e.action]), [['site', 'account']]);
  const text = fs.readFileSync(audit.FILE, 'utf8');
  assert.ok(!text.includes('een-heel-geheim-wachtwoord-77') && !text.includes('het-oude-wachtwoord-11'));
  assert.ok(!/"ip"|127\.0\.0\.1|::1|::ffff/.test(text));
  assert.ok(!/tokenHash|deviceToken|sm_resident|sm_session/.test(text));
  // elke regel is een eigen JSON-object met tijd, soort, actie, wie en een samenvatting
  for (const e of lines()) {
    assert.ok(['house', 'site'].includes(e.category), JSON.stringify(e));
    assert.ok(e.at && e.action && e.actor?.type && typeof e.summary === 'string', JSON.stringify(e));
  }
});
