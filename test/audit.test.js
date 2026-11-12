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

// ---------- de log lezen in het beheer: GET /api/admin/audit ----------
// Een wachtwoordwijziging (hierboven) verhoogt de epoch van de gebruiker en maakt oudere sessies ongeldig; deze sessie hoort bij de actuele epoch.
const freshCookie = () => {
  const payload = `${Date.now() + 3600e3}.pk.owner.${store.db().users.find((u) => u.id === 'owner').epoch || 0}`;
  return `sm_session=${payload}.${crypto.createHmac('sha256', 'test-session-secret-123').update(payload).digest('base64url')}`;
};
const get = (qs = '', c = freshCookie()) => j(`/api/admin/audit${qs}`, c ? { headers: { cookie: c } } : undefined);
const page = async (qs) => { const r = await get(qs); assert.equal(r.status, 200, await r.clone().text()); return r.json(); };
const noPos = ({ pos, ...e }) => e;
// Alle pagina's achter elkaar, zoals het beheer ze ophaalt met "Oudere tonen".
async function all(qs, limit) {
  const out = [];
  let before = '';
  for (;;) {
    const p = await page(`?limit=${limit}${qs}${before}`);
    out.push(...p.items);
    if (p.next === null) return out;
    before = `&before=${p.next}`;
  }
}

test('lezen: alleen voor ingelogde beheerders', async () => {
  assert.equal((await get('', '')).status, 401);
  assert.equal((await get('')).status, 200);
});

test('lezen: nieuwste eerst, en de pagina\'s samen zijn precies de hele log', async () => {
  const full = lines().reverse();
  assert.ok(full.length > 10, 'de eerdere tests hebben regels geschreven');
  const first = await page('');
  assert.equal(first.items.length, Math.min(50, full.length), 'standaard 50 per pagina');
  assert.deepEqual(first.items.map(noPos), full.slice(0, 50));
  const got = await all('', 7);
  assert.deepEqual(got.map(noPos), full);
  assert.ok(got.every((e, i) => i === 0 || e.pos < got[i - 1].pos), 'posities lopen terug');
  assert.equal((await page('?limit=1')).items.length, 1);
  assert.equal((await page('?limit=100000')).items.length, Math.min(200, full.length), 'maximaal 200 per pagina');
});

test('lezen: filter op soort en op zoektekst', async () => {
  const marker = { id: 'zk', street: 'Zoekstraat', number: '7' };
  audit.house(ADMIN, 'changed', marker, { changes: { note: { from: '', to: 'x' } } });
  audit.house(audit.device('abc123'), 'proposed', marker, { from: 'none', to: 'green' });
  audit.site(ADMIN, 'settings', 'Instellingen opgeslagen');
  const all_ = lines();
  const houses = (await all('&category=house', 9)).map(noPos);
  assert.deepEqual(houses, all_.filter((e) => e.category === 'house').reverse());
  assert.deepEqual((await all('&category=site', 9)).map(noPos), all_.filter((e) => e.category === 'site').reverse());

  const hit = (await all('&q=ZOEKSTRAAT', 9)).map(noPos);
  assert.equal(hit.length, 2);
  assert.ok(hit.every((e) => e.house.id === 'zk'));
  assert.deepEqual((await all('&category=house&q=abc123', 9)).map((e) => e.action), ['proposed'], 'zoeken op het apparaat van een bewoner');
  assert.ok((await all('&q=beheerder', 9)).length >= 3, 'zoeken op de beheerder');
  assert.deepEqual(await page('?q=bestaat-niet-xyz'), { items: [], next: null });
  assert.deepEqual((await all('&category=site&q=zoekstraat', 9)), [], 'filters werken samen');

  assert.equal((await get('?category=alles')).status, 400);
  assert.equal((await get('?before=abc')).status, 400);
  assert.equal((await get('?before=-1')).status, 400);
});

test('lezen: een grote log met tekens van meerdere bytes, over de grenzen van de leesbrokken heen', async () => {
  const sizeBefore = fs.statSync(audit.FILE).size;
  for (let i = 0; i < 600; i++) audit.site(ADMIN, 'settings', `Ünïcödé € 😀 ${i} ${'é€'.repeat(60)}`);
  assert.ok(fs.statSync(audit.FILE).size - sizeBefore > 2 * 64 * 1024, 'meer dan twee brokken');
  const buf = fs.readFileSync(audit.FILE);
  const got = await all('', 200);
  assert.deepEqual(got.map(noPos), lines().reverse(), 'geen regel kwijt, dubbel of beschadigd');
  assert.ok(got.every((e) => buf.subarray(e.pos, e.pos + 7).toString() === '{"at":"'), 'pos is het begin van de regel');
});

test('lezen: een beschadigde regel of een half geschreven laatste regel breekt het lezen niet', async () => {
  const good = lines().reverse();
  const size = fs.statSync(audit.FILE).size;
  try {
    fs.appendFileSync(audit.FILE, 'dit is geen json\n{"at":"2026-');
    assert.deepEqual((await all('', 5)).map(noPos), good);
  } finally { fs.truncateSync(audit.FILE, size); }
});

test('lezen: zonder logbestand een lege lijst', async () => {
  fs.renameSync(audit.FILE, `${audit.FILE}.bak`);
  try { assert.deepEqual(await page(''), { items: [], next: null }); }
  finally { fs.renameSync(`${audit.FILE}.bak`, audit.FILE); }
});
