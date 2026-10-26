const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-'));
process.env.SETUP_TOKEN = 'test-setup-token-123';
process.env.SESSION_SECRET = 'test-session-secret-123';
const app = require('../server/index.js');

let server, base;
test.before(() => new Promise((r) => { server = app.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); }); }));
test.after(() => server.close());

const j = (p, o) => fetch(base + p, o);

test('publieke kaart is leeg maar bereikbaar', async () => {
  const r = await j('/api/map');
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).houses, []);
});

test('beheer-API vereist login', async () => {
  for (const [m, p] of [['PUT', '/api/admin/houses'], ['PUT', '/api/admin/view'], ['GET', '/api/admin/passkeys']]) {
    assert.equal((await j(p, { method: m, headers: { 'Content-Type': 'application/json' }, body: m === 'GET' ? undefined : '{}' })).status, 401, p);
  }
});

test('eerste passkey vereist juiste installatiecode', async () => {
  const bad = await j('/api/auth/register/options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ setupToken: 'nope' }) });
  assert.equal(bad.status, 403);
  const ok = await j('/api/auth/register/options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ setupToken: 'test-setup-token-123' }) });
  assert.equal(ok.status, 200);
  assert.ok((await ok.json()).options.challenge);
});

test('vreemde origin wordt geweigerd', async () => {
  const r = await j('/api/auth/logout', { method: 'POST', headers: { Origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
});

const crypto = require('node:crypto');
const exp = String(Date.now() + 3600e3);
const cookie = `sm_session=${exp}.${crypto.createHmac('sha256', 'test-session-secret-123').update(exp).digest('base64url')}`;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

test('uitleg opslaan en publiek tonen', async () => {
  const put = await j('/api/admin/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ intro: 'Hallo\r\n\r\nwijk ' }) });
  assert.equal(put.status, 200);
  assert.equal((await (await j('/api/map')).json()).intro, 'Hallo\n\nwijk');
  const tooLong = await j('/api/admin/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ intro: 'x'.repeat(5001) }) });
  assert.equal(tooLong.status, 400);
});

test('logo upload controleert inhoud en kan verwijderd worden', async () => {
  const bad = await j('/api/admin/logo', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', cookie }, body: Buffer.from('<svg onload=alert(1)>') });
  assert.equal(bad.status, 400);
  const ok = await j('/api/admin/logo', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', cookie }, body: PNG });
  assert.equal(ok.status, 200);
  const { logo } = await ok.json();
  assert.match(logo.url, /^\/uploads\/logo-\d+\.png$/);
  assert.equal((await j(logo.url)).status, 200);
  assert.equal((await (await j('/api/map')).json()).logo.url, logo.url);
  assert.equal((await j('/api/admin/logo', { method: 'DELETE', headers: { cookie } })).status, 200);
  assert.equal((await (await j('/api/map')).json()).logo, null);
});

test('manifest en service worker zijn beschikbaar', async () => {
  const m = await (await j('/manifest.webmanifest')).json();
  assert.equal(m.display, 'standalone');
  assert.ok(m.icons.some((i) => i.sizes === '512x512'));
  const sw = await j('/sw.js');
  assert.equal(sw.status, 200);
  assert.equal(sw.headers.get('cache-control'), 'no-cache');
});

const store = require('../server/store');
const { hashPassword } = require('../server/password');
const sessionCookie = (method) => {
  const e = String(Date.now() + 3600e3);
  return `sm_session=${e}.${method}.${crypto.createHmac('sha256', 'test-session-secret-123').update(`${e}.${method}`).digest('base64url')}`;
};
const jsonH = (c) => ({ 'Content-Type': 'application/json', ...(c ? { cookie: c } : {}) });

test('appnaam komt in het manifest en wordt gevalideerd', async () => {
  const put = (body) => j('/api/admin/settings', { method: 'PUT', headers: jsonH(cookie), body: JSON.stringify(body) });
  assert.equal((await put({ appName: 'Wijk Sint Maarten', appShortName: 'Sint Maarten' })).status, 200);
  const m = await (await j('/manifest.webmanifest')).json();
  assert.equal(m.name, 'Wijk Sint Maarten');
  assert.equal(m.short_name, 'Sint Maarten');
  assert.equal((await put({ appShortName: 'veel te lange korte naam' })).status, 400);
  assert.equal((await put({ appName: '' , appShortName: '' })).status, 200);
  assert.equal((await (await j('/manifest.webmanifest')).json()).name, 'Onze wijk');
});

test('wachtwoord: inloggen, beperkingen en bevestiging met passkey', async () => {
  // zonder ingesteld wachtwoord kan niemand inloggen
  assert.equal((await j('/api/auth/password-login', { method: 'POST', headers: jsonH(), body: JSON.stringify({ password: 'iets-geheims-123' }) })).status, 401);
  // instellen zonder passkey-bevestiging mislukt
  const noProof = await j('/api/admin/password', { method: 'PUT', headers: jsonH(cookie), body: JSON.stringify({ password: 'een-lang-wachtwoord' }) });
  assert.equal(noProof.status, 400);
  const short = await j('/api/admin/password', { method: 'PUT', headers: jsonH(cookie), body: JSON.stringify({ password: 'kort' }) });
  assert.equal(short.status, 400);
  assert.equal((await j('/api/admin/password', { method: 'PUT', headers: jsonH(), body: '{}' })).status, 401);

  store.db().password = await hashPassword('een-lang-wachtwoord');
  const bad = await j('/api/auth/password-login', { method: 'POST', headers: jsonH(), body: JSON.stringify({ password: 'fout-wachtwoord-1' }) });
  assert.equal(bad.status, 401);
  const ok = await j('/api/auth/password-login', { method: 'POST', headers: jsonH(), body: JSON.stringify({ password: 'een-lang-wachtwoord' }) });
  assert.equal(ok.status, 200);
  const set = ok.headers.get('set-cookie').split(';')[0];
  const st = await (await j('/api/auth/status', { headers: { cookie: set } })).json();
  assert.deepEqual([st.loggedIn, st.method, st.passwordEnabled], [true, 'pw', true]);

  // met een wachtwoord-sessie mag je kaartgegevens beheren, maar geen passkeys/wachtwoord
  assert.equal((await j('/api/admin/passkeys', { headers: { cookie: set } })).status, 200);
  assert.equal((await j('/api/admin/password/options', { method: 'POST', headers: jsonH(set), body: '{}' })).status, 403);
  assert.equal((await j('/api/admin/passkeys/x', { method: 'DELETE', headers: { cookie: set } })).status, 403);
  assert.equal((await j('/api/auth/register/options', { method: 'POST', headers: jsonH(set), body: '{}' })).status, 403);
  // met een passkey-sessie krijg je wel uitdaging voor bevestiging
  const opts = await j('/api/admin/password/options', { method: 'POST', headers: jsonH(sessionCookie('pk')), body: '{}' });
  assert.equal(opts.status, 200);
  assert.ok((await opts.json()).options.challenge);
  store.db().password = null;
});

test('PDF-kaartvlak instellen, valideren, wissen en terugzetten uit backup', async () => {
  const h = { 'Content-Type': 'application/json', cookie };
  assert.equal((await (await j('/api/map')).json()).pdfView, null);
  const ok = await j('/api/admin/pdf-view', { method: 'PUT', headers: h, body: JSON.stringify({ center: [52.02, 5.16], zoom: 17 }) });
  assert.equal(ok.status, 200);
  assert.deepEqual((await (await j('/api/map')).json()).pdfView, { center: [52.02, 5.16], zoom: 17 });
  for (const bad of [{ zoom: 17.5 }, { zoom: 25 }, { zoom: 0 }, { center: [200, 5] }, { center: 'x' }]) {
    const r = await j('/api/admin/pdf-view', { method: 'PUT', headers: h, body: JSON.stringify({ center: [52.02, 5.16], zoom: 17, ...bad }) });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal((await j('/api/admin/pdf-view', { method: 'PUT', body: JSON.stringify({ center: [52, 5], zoom: 17 }), headers: { 'Content-Type': 'application/json' } })).status, 401);
  const id = backups.create('test pdf-vlak', true, { force: true });
  assert.equal((await j('/api/admin/pdf-view', { method: 'DELETE', headers: { cookie } })).status, 200);
  assert.equal((await (await j('/api/map')).json()).pdfView, null);
  assert.ok(backups.restore(id));
  assert.deepEqual((await (await j('/api/map')).json()).pdfView, { center: [52.02, 5.16], zoom: 17 });
  await j('/api/admin/pdf-view', { method: 'DELETE', headers: { cookie } });
});

test('kaartweergave instellen, valideren en wissen', async () => {
  const h = { 'Content-Type': 'application/json', cookie };
  const ok = await j('/api/admin/view', { method: 'PUT', headers: h, body: JSON.stringify({ center: [52.02, 5.16], zoom: 17.5, minZoom: 14, maxZoom: 19 }) });
  assert.equal(ok.status, 200);
  assert.deepEqual((await (await j('/api/map')).json()).view, { center: [52.02, 5.16], zoom: 17.5, minZoom: 14, maxZoom: 19, showNumbers: false });
  for (const bad of [{ zoom: 25 }, { minZoom: 18, maxZoom: 15 }, { zoom: 10, minZoom: 14 }, { center: [200, 5] }]) {
    const r = await j('/api/admin/view', { method: 'PUT', headers: h, body: JSON.stringify({ center: [52.02, 5.16], zoom: 17, ...bad }) });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal((await j('/api/admin/view', { method: 'DELETE', headers: { cookie } })).status, 200);
  assert.equal((await (await j('/api/map')).json()).view, null);
});

const backups = require('../server/backups');
const H = [{ id: 'a1', label: '1', status: 'green', note: '', points: [[52, 5], [52.001, 5], [52.001, 5.001]] }];

test('na elke opslagpoging komt er een backup (layout + teksten)', async () => {
  const before = backups.list().length;
  const putHouses = (houses) => j('/api/admin/houses', { method: 'PUT', headers: jsonH(cookie), body: JSON.stringify({ houses }) });
  assert.equal((await putHouses(H)).status, 200);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(backups.list().length, before + 1);
  const latest = backups.read(backups.list()[0].id);
  assert.equal(latest.houses.length, 1);
  assert.equal(latest.reason, 'Layout opgeslagen');
  assert.ok('intro' in latest.texts && 'appName' in latest.texts);

  // identieke staat -> geen dubbele backup; mislukte poging verandert niets
  assert.equal((await putHouses(H)).status, 200);
  assert.equal((await putHouses([{ points: [[1, 1]] }])).status, 400);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(backups.list().length, before + 1);

  // tekstwijziging -> nieuwe backup
  await j('/api/admin/settings', { method: 'PUT', headers: jsonH(cookie), body: JSON.stringify({ intro: 'Nieuwe uitleg' }) });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(backups.list().length, before + 2);
});

test('backups: korte titel instellen en handmatig backup maken', async () => {
  const before = backups.list().length;
  // handmatig, ook als er niets veranderd is, met een titel (opgeschoond en beperkt tot 40 tekens)
  const r = await (await j('/api/admin/backups', { method: 'POST', headers: jsonH(cookie), body: JSON.stringify({ title: `  Alleen   layout ${'x'.repeat(60)}` }) })).json();
  assert.equal(backups.list().length, before + 1);
  const item = backups.list().find((b) => b.id === r.id);
  assert.equal(item.title.length, 40);
  assert.match(item.title, /^Alleen layout x+$/);
  assert.equal(item.reason, 'Handmatig');
  // titel wijzigen en wissen
  const put = (id, title) => j(`/api/admin/backups/${id}/title`, { method: 'PUT', headers: jsonH(cookie), body: JSON.stringify({ title }) });
  assert.equal((await (await put(r.id, 'Alles')).json()).title, 'Alles');
  assert.equal(backups.list().find((b) => b.id === r.id).title, 'Alles');
  assert.equal(backups.read(r.id).houses.length, backups.list().find((b) => b.id === r.id).houses); // inhoud ongewijzigd
  assert.equal((await (await put(r.id, '')).json()).title, '');
  assert.equal((await put('1234567890123-abcdef', 'x')).status, 404);
  assert.equal((await j(`/api/admin/backups/${r.id}/title`, { method: 'PUT', headers: jsonH(cookie), body: '{}' })).status, 400);
  // alleen met beheersessie
  assert.equal((await j('/api/admin/backups', { method: 'POST', headers: jsonH(), body: '{}' })).status, 401);
  assert.equal((await j(`/api/admin/backups/${r.id}/title`, { method: 'PUT', headers: jsonH(), body: '{"title":"x"}' })).status, 401);
});

test('backups: lijst, terugzetten en verwijderen vereist passkey-bevestiging', async () => {
  assert.equal((await j('/api/admin/backups')).status, 401);
  const list = await (await j('/api/admin/backups', { headers: { cookie } })).json();
  const oldest = list[list.length - 1];
  // terugzetten: layout van die backup terug, en eerst een backup van de huidige staat
  await j('/api/admin/houses', { method: 'PUT', headers: jsonH(cookie), body: JSON.stringify({ houses: [] }) });
  const target = list.find((b) => b.houses === 1 && b.reason === 'Layout opgeslagen');
  const r = await j(`/api/admin/backups/${target.id}/restore`, { method: 'POST', headers: jsonH(cookie), body: '{}' });
  assert.equal(r.status, 200);
  assert.equal((await (await j('/api/map')).json()).houses.length, 1);
  assert.equal((await j('/api/admin/backups/onzin/restore', { method: 'POST', headers: jsonH(cookie), body: '{}' })).status, 404);

  // verwijderen zonder geldige passkey-bevestiging mislukt en laat alles intact
  const n = backups.list().length;
  const del = await j('/api/admin/backups/delete', { method: 'POST', headers: jsonH(cookie), body: JSON.stringify({ ids: [oldest.id] }) });
  assert.equal(del.status, 400);
  const badIds = await j('/api/admin/backups/delete', { method: 'POST', headers: jsonH(cookie), body: JSON.stringify({ ids: ['../../etc/passwd'] }) });
  assert.equal(badIds.status, 400);
  assert.equal(backups.list().length, n);
  assert.equal((await j('/api/admin/backups/delete', { method: 'POST', headers: jsonH(), body: '{}' })).status, 401);
  assert.ok(backups.read(oldest.id));
});

const { execFileSync } = require('node:child_process');

test('versie-info is alleen voor beheerders en toont versie en build', async () => {
  assert.equal((await j('/api/admin/info')).status, 401);
  const info = await (await j('/api/admin/info', { headers: { cookie } })).json();
  assert.ok(info.version && info.build && info.label.includes(info.build));
  assert.match(info.label, /^(v\d+\.\d+\.\d+|dev) \(.+\)$/);
});

test('service worker krijgt de buildversie in zijn cachenaam', async () => {
  const sw = await (await j('/sw.js')).text();
  assert.match(sw, /const VERSION = '[\w.-]+';/);
  assert.doesNotMatch(sw, /const VERSION = 'v1';/);
});

test('tools/next-version.sh telt per build 0.0.1 op, beginnend bij 0.1.0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ver-'));
  fs.mkdirSync(path.join(dir, 'tools'));
  fs.copyFileSync(path.join(__dirname, '..', 'tools', 'next-version.sh'), path.join(dir, 'tools', 'next-version.sh'));
  fs.chmodSync(path.join(dir, 'tools', 'next-version.sh'), 0o755);
  fs.writeFileSync(path.join(dir, 'VERSION'), '0.1\n');
  const run = (...a) => execFileSync(a[0], a.slice(1), { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
  run('git', 'init', '-q');
  run('git', 'commit', '-q', '--allow-empty', '-m', 'x');
  assert.equal(run('sh', 'tools/next-version.sh'), '0.1.0');
  run('git', 'tag', 'v0.1.0');
  assert.equal(run('sh', 'tools/next-version.sh'), '0.1.1');
  run('git', 'tag', 'v0.1.1'); run('git', 'tag', 'v0.1.9'); run('git', 'tag', 'v0.1.10'); run('git', 'tag', 'v0.2.5'); run('git', 'tag', 'v0.1.foo');
  assert.equal(run('sh', 'tools/next-version.sh'), '0.1.11'); // numeriek sorteren, andere minor/rommel negeren
});

test('cache-busting: HTML verwijst naar versie-URLs en JS/CSS cachet per build', async () => {
  for (const url of ['/', '/beheer']) {
    const r = await j(url);
    const html = await r.text();
    assert.equal(r.headers.get('cache-control'), 'no-cache', url);
    assert.doesNotMatch(html, /\{\{v\}\}/);
    const scripts = [...html.matchAll(/(?:src|href)="(\/(?:js|admin|css|vendor)\/[^"]+\.(?:js|css))\?v=([\w.-]+)"/g)];
    assert.ok(scripts.length >= 3, url);
    // elk lokaal script/stijl in de HTML heeft een versie
    assert.doesNotMatch(html, /(?:src|href)="\/(?:js|admin|css)\/[^"?]+\.(?:js|css)"/);
  }
  const versioned = await j('/admin/admin.js?v=1.2.3');
  assert.equal(versioned.status, 200);
  assert.match(versioned.headers.get('cache-control'), /immutable/);
  const plain = await j('/admin/admin.js');
  assert.equal(plain.headers.get('cache-control'), 'no-cache');
  const vendor = await j('/vendor/jspdf.js?v=1');
  assert.match(vendor.headers.get('cache-control'), /immutable/);
});

test('huizen hebben straat en huisnummer; oude "label" wordt huisnummer', async () => {
  const pts = [[52, 5], [52.001, 5], [52.001, 5.001]];
  const put = (houses) => j('/api/admin/houses', { method: 'PUT', headers: jsonH(cookie), body: JSON.stringify({ houses }) });
  const r = await put([
    { id: 'n1', street: '  Loerikseweg ', number: '12a', status: 'green', points: pts },
    { id: 'n2', label: '7', status: 'red', points: pts }, // oud formaat
    { id: 'n3', street: 'X'.repeat(300), number: '9'.repeat(50), status: 'bogus', points: pts },
  ]);
  assert.equal(r.status, 200);
  const { houses } = await r.json();
  assert.deepEqual([houses[0].street, houses[0].number, 'label' in houses[0]], ['Loerikseweg', '12a', false]);
  assert.deepEqual([houses[1].street, houses[1].number], ['', '7']);
  assert.equal(houses[2].street.length, 100);
  assert.equal(houses[2].number.length, 20);
  assert.equal(houses[2].status, 'none');
  const map = await (await j('/api/map')).json();
  assert.equal(map.houses[0].number, '12a');
});

test('kaartweergave bewaart de standaardkeuze voor huisnummers', async () => {
  const put = (extra) => j('/api/admin/view', { method: 'PUT', headers: jsonH(cookie), body: JSON.stringify({ center: [52, 5], zoom: 17, ...extra }) });
  assert.equal((await put({ showNumbers: true })).status, 200);
  assert.equal((await (await j('/api/map')).json()).view.showNumbers, true);
  assert.equal((await put({})).status, 200);
  assert.equal((await (await j('/api/map')).json()).view.showNumbers, false);
});

test('naam van de site is instelbaar en komt in site, manifest en backups', async () => {
  const put = (body) => j('/api/admin/settings', { method: 'PUT', headers: jsonH(cookie), body: JSON.stringify(body) });
  assert.equal((await put({ siteTitle: '  Wijk Sint Maarten ' })).status, 200);
  const map = await (await j('/api/map')).json();
  assert.equal(map.title, 'Wijk Sint Maarten');
  assert.equal(map.siteTitle, 'Wijk Sint Maarten');
  assert.equal((await (await j('/manifest.webmanifest')).json()).name, 'Wijk Sint Maarten');
  assert.equal((await put({ siteTitle: 'x'.repeat(61) })).status, 400);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(backups.read(backups.list()[0].id).texts.siteTitle, 'Wijk Sint Maarten');
  assert.equal((await put({ siteTitle: '' })).status, 200);
  assert.equal((await (await j('/api/map')).json()).title, 'Onze wijk'); // terug naar SITE_TITLE
});

// ---------- bewoners en pushmeldingen ----------
const push = require('../server/push');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ptsR = [[52, 5], [52.001, 5], [52.001, 5.001]];
const res = (path, opts = {}) => j(`/api/resident${path}`, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
const post = (path, body, cookieHeader) => res(path, { method: 'POST', body: JSON.stringify(body || {}), headers: cookieHeader ? { cookie: cookieHeader } : {} });
const adminReq = (path, method = 'GET', body) => j(`/api/admin${path}`, { method, headers: jsonH(cookie), body: body ? JSON.stringify(body) : undefined });

test('bewoners: 1 huis per apparaat, wijziging pas zichtbaar na goedkeuring', async () => {
  process.env.PUSH_DELAY_MS = '10';
  const sent = [];
  push._setSender({ sendNotification: async (sub, payload) => { sent.push({ sub, payload: JSON.parse(payload) }); } });
  await adminReq('/settings', 'PUT', { residentsEnabled: true });
  await adminReq('/houses', 'PUT', { houses: [
    { id: 'h1', street: 'Dorpsstraat', number: '1', status: 'none', points: ptsR },
    { id: 'h2', street: 'Dorpsstraat', number: '2', status: 'red', points: ptsR },
  ] });
  await adminReq('/push/subscribe', 'POST', { label: 'Telefoon', subscription: { endpoint: 'https://push.example/abc', keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) } } });

  // zonder koppeling kan niets
  assert.equal((await res('/me')).status, 200);
  assert.equal((await (await res('/me')).json()).claim, null);
  assert.equal((await post('/set', { status: 'green' })).status, 401);

  // koppelen: cookie is HttpOnly, 1 jaar, alleen voor één huis
  const claim = await post('/claim', { houseId: 'h1' });
  assert.equal(claim.status, 200);
  const setC = claim.headers.get('set-cookie');
  assert.match(setC, /sm_resident=[\w-]{40,}/);
  assert.match(setC, /HttpOnly/);
  assert.match(setC, /Max-Age=31536000/);
  const c1 = setC.split(';')[0];
  assert.equal((await post('/claim', { houseId: 'h2' }, c1)).status, 409);
  assert.equal((await post('/claim', { houseId: 'nope' })).status, 404);

  // wijzigen: nog niet zichtbaar voor anderen
  const s1 = await (await post('/set', { status: 'green' }, c1)).json();
  assert.deepEqual([s1.effective, s1.approved, s1.pending], ['green', 'none', true]);
  assert.equal((await (await j('/api/map')).json()).houses.find((h) => h.id === 'h1').status, 'none');
  assert.equal((await post('/set', { status: 'blauw' }, c1)).status, 400);
  const ch = await (await adminReq('/changes')).json();
  assert.equal(ch.pending.length, 1);
  assert.deepEqual([ch.pending[0].title, ch.pending[0].from, ch.pending[0].to], ['Dorpsstraat 1', 'none', 'green']);
  assert.equal((await (await adminReq('/changes/count')).json()).pending, 1);

  // pushmelding naar de beheerder (samengevoegd)
  await wait(80);
  assert.equal(sent.length, 1);
  assert.match(sent[0].payload.body, /Dorpsstraat 1: groen aangevraagd/);
  assert.equal(sent[0].payload.url, '/beheer#changes');

  // terug naar de goedgekeurde status haalt het voorstel weg
  assert.equal((await (await post('/set', { status: 'none' }, c1)).json()).pending, false);
  assert.equal((await (await adminReq('/changes/count')).json()).pending, 0);

  // opnieuw voorstellen en goedkeuren
  await post('/set', { status: 'red' }, c1);
  const pend = (await (await adminReq('/changes')).json()).pending[0];
  const ap = await (await adminReq(`/changes/${pend.id}/approve`, 'POST')).json();
  assert.deepEqual(ap.change, { houseId: 'h1', status: 'red' });
  assert.equal((await (await j('/api/map')).json()).houses.find((h) => h.id === 'h1').status, 'red');
  const me = await (await res('/me', { headers: { cookie: c1 } })).json();
  assert.deepEqual([me.approved, me.effective, me.pending, me.notice.decision], ['red', 'red', false, 'approved']);
  assert.equal((await post('/ack', {}, c1)).status, 200);
  assert.equal((await (await res('/me', { headers: { cookie: c1 } })).json()).notice, null);

  // afwijzen
  await post('/set', { status: 'green' }, c1);
  const p2 = (await (await adminReq('/changes')).json()).pending[0];
  await adminReq(`/changes/${p2.id}/reject`, 'POST');
  const me2 = await (await res('/me', { headers: { cookie: c1 } })).json();
  assert.deepEqual([me2.effective, me2.notice.decision], ['red', 'rejected']);
  assert.equal((await adminReq(`/changes/${p2.id}/approve`, 'POST')).status, 404);

  // een tweede apparaat heeft een eigen koppeling; alles goedkeuren
  const c2 = (await post('/claim', { houseId: 'h2' })).headers.get('set-cookie').split(';')[0];
  await post('/set', { status: 'green' }, c2);
  await post('/set', { status: 'green' }, c1);
  const all = await (await adminReq('/changes/approve-all', 'POST')).json();
  assert.equal(all.changes.length, 2);
  const houses = (await (await j('/api/map')).json()).houses;
  assert.deepEqual(houses.map((h) => h.status), ['green', 'green']);

  // koppelingen beheren en opruimen bij verwijderde huizen
  const rs = (await (await adminReq('/changes')).json()).residents;
  assert.equal(rs.length, 2);
  await adminReq(`/residents/${rs[1].rid}`, 'DELETE');
  assert.equal((await (await res('/me', { headers: { cookie: c2 } })).json()).claim, null);
  await adminReq('/houses', 'PUT', { houses: [{ id: 'h2', street: 'Dorpsstraat', number: '2', status: 'green', points: ptsR }] });
  assert.equal((await (await res('/me', { headers: { cookie: c1 } })).json()).claim, null);
});

test('bewoners: apparaat en IP blokkeren', async () => {
  await adminReq('/settings', 'PUT', { residentsEnabled: true, residentsAppOnly: false });
  await adminReq('/houses', 'PUT', { houses: [
    { id: 'h1', street: 'Dorpsstraat', number: '1', status: 'none', points: ptsR },
    { id: 'h2', street: 'Dorpsstraat', number: '2', status: 'none', points: ptsR },
  ] });
  for (const r of (await (await adminReq('/changes')).json()).residents) await adminReq(`/residents/${r.rid}`, 'DELETE');
  const c1 = (await post('/claim', { houseId: 'h1' })).headers.get('set-cookie').split(';')[0];
  await post('/set', { status: 'green' }, c1);
  const ch = await (await adminReq('/changes')).json();
  assert.equal(ch.pending.length, 1);
  assert.ok(ch.residents[0].ip);
  assert.equal((await adminReq('/residents/nope/block', 'POST', {})).status, 404);

  // alleen het apparaat blokkeren
  assert.equal((await adminReq(`/residents/${ch.pending[0].rid}/block`, 'POST', {})).status, 200);
  const after = await (await adminReq('/changes')).json();
  assert.deepEqual([after.pending.length, after.residents.length, after.blocked.length, after.blocked[0].ip], [0, 0, 1, null]);
  const blocked = await post('/set', { status: 'red' }, c1);
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).blocked, true);
  assert.equal((await (await res('/me', { headers: { cookie: c1 } })).json()).blocked, true);
  // een ander apparaat (ander token/cookie, zelfde IP) kan nog gewoon
  assert.equal((await post('/claim', { houseId: 'h2' })).status, 200);

  // ook het IP blokkeren
  const r2 = (await (await adminReq('/changes')).json()).residents[0];
  await adminReq(`/residents/${r2.rid}/block`, 'POST', { withIp: true });
  assert.equal((await post('/claim', { houseId: 'h1' })).status, 403);

  // deblokkeren
  for (const b of (await (await adminReq('/changes')).json()).blocked) assert.equal((await adminReq(`/blocks/${b.id}`, 'DELETE')).status, 200);
  assert.equal((await post('/claim', { houseId: 'h1' })).status, 200);
  for (const r of (await (await adminReq('/changes')).json()).residents) await adminReq(`/residents/${r.rid}`, 'DELETE');
  for (const [m, p] of [['POST', '/residents/x/block'], ['DELETE', '/blocks/x']]) assert.equal((await j(`/api/admin${p}`, { method: m, headers: jsonH() })).status, 401, p);
});

test('beheer kan de status altijd aanpassen, ook als een bewoner iets voorstelde', async () => {
  await adminReq('/settings', 'PUT', { residentsEnabled: true, residentsAppOnly: false });
  const mk = (st) => [{ id: 'h1', street: 'Dorpsstraat', number: '1', status: st, points: ptsR }];
  await adminReq('/houses', 'PUT', { houses: mk('none') });
  for (const r of (await (await adminReq('/changes')).json()).residents) await adminReq(`/residents/${r.rid}`, 'DELETE');
  const c = (await post('/claim', { houseId: 'h1' })).headers.get('set-cookie').split(';')[0];
  await post('/set', { status: 'green' }, c);

  // beheer kiest rood terwijl groen wacht: het voorstel blijft, met de nieuwe uitgangsstatus
  assert.equal((await adminReq('/houses', 'PUT', { houses: mk('red') })).status, 200);
  assert.equal((await (await j('/api/map')).json()).houses[0].status, 'red');
  const p = (await (await adminReq('/changes')).json()).pending;
  assert.deepEqual([p.length, p[0].from, p[0].to], [1, 'red', 'green']);

  // beheer kiest precies wat de bewoner wilde: voorstel is overbodig en verdwijnt
  await adminReq('/houses', 'PUT', { houses: mk('green') });
  assert.equal((await (await adminReq('/changes')).json()).pending.length, 0);
  const me = await (await res('/me', { headers: { cookie: c } })).json();
  assert.deepEqual([me.approved, me.pending], ['green', false]);

  // en terug naar niet gemarkeerd kan altijd
  await adminReq('/houses', 'PUT', { houses: mk('none') });
  assert.equal((await (await j('/api/map')).json()).houses[0].status, 'none');
  for (const r of (await (await adminReq('/changes')).json()).residents) await adminReq(`/residents/${r.rid}`, 'DELETE');
});

test('wijzigen plannen op datum/tijd en infovlak', async () => {
  await adminReq('/settings', 'PUT', { residentsEnabled: true, residentsAppOnly: true, residentsOff: false });
  const map = async () => (await j('/api/map')).json();
  // standaardtekst in het infovlak zolang wijzigen aan staat
  let m = await map();
  assert.equal(m.residentsEnabled, true);
  assert.match(m.residentInfo, /eigen huis|jouw huis/);
  assert.equal((await adminReq('/settings')).status, 200);

  // aanzetten zonder (geldige) datum mag niet
  assert.equal((await adminReq('/settings', 'PUT', { residentsOff: true, residentsUntil: 'nee' })).status, 400);

  // gepland in de toekomst: aan (ook zonder app), schakelaars worden genegeerd
  const future = new Date(Date.now() + 3600e3).toISOString();
  assert.equal((await adminReq('/settings', 'PUT', { residentsOff: true, residentsUntil: future })).status, 200);
  m = await map();
  assert.deepEqual([m.residentsEnabled, m.residentsAppOnly], [true, false]);
  const ch = await (await adminReq('/changes')).json();
  assert.deepEqual([ch.schedule.on, ch.schedule.until, ch.appOnly], [true, future, true]);

  // eigen tekst in het infovlak
  await adminReq('/settings', 'PUT', { residentInfo: 'Pas zelf je huis aan!' });
  assert.equal((await map()).residentInfo, 'Pas zelf je huis aan!');
  assert.equal((await adminReq('/settings', 'PUT', { residentInfo: 'x'.repeat(1001) })).status, 400);

  // verlopen: wijzigen uit, infovlak weg, server weigert
  await adminReq('/settings', 'PUT', { residentsUntil: new Date(Date.now() - 1000).toISOString() });
  m = await map();
  assert.deepEqual([m.residentsEnabled, m.residentInfo], [false, '']);
  assert.equal((await post('/claim', { houseId: 'h1' })).status, 403);

  // planning uit: de eigen schakelaars gelden weer
  await adminReq('/settings', 'PUT', { residentsOff: false });
  m = await map();
  assert.deepEqual([m.residentsEnabled, m.residentsAppOnly, m.residentInfo], [true, true, 'Pas zelf je huis aan!']);
  await adminReq('/settings', 'PUT', { residentsAppOnly: false, residentInfo: '' });
  assert.equal((await map()).residentInfo, '');
  assert.equal((await j('/api/admin/settings', { headers: jsonH() })).status, 401);
});

test('na de einddatum: alleen eigen huis groen <-> rood (met schakelaar)', async () => {
  const mkh = (id, st) => ({ id, street: 'Dorpsstraat', number: id.slice(1), status: st, points: ptsR });
  await adminReq('/settings', 'PUT', { residentsEnabled: true, residentsAppOnly: false, residentsOff: false, residentsSwapAfter: false });
  await adminReq('/houses', 'PUT', { houses: [mkh('h1', 'green'), mkh('h2', 'none'), mkh('h3', 'red')] });
  for (const r of (await (await adminReq('/changes')).json()).residents) await adminReq(`/residents/${r.rid}`, 'DELETE');
  const c1 = (await post('/claim', { houseId: 'h1' })).headers.get('set-cookie').split(';')[0];
  const c2 = (await post('/claim', { houseId: 'h2' })).headers.get('set-cookie').split(';')[0];
  const map = async () => (await j('/api/map')).json();

  // einddatum verstreken, schakelaar uit: alles dicht
  await adminReq('/settings', 'PUT', { residentsOff: true, residentsUntil: new Date(Date.now() - 1000).toISOString() });
  let m = await map();
  assert.deepEqual([m.residentsEnabled, m.residentsMode], [false, 'closed']);
  assert.equal((await post('/set', { status: 'red' }, c1)).status, 403);

  // schakelaar aan: wisselen mag voor een bestaand huis dat groen/rood is
  assert.equal((await adminReq('/settings', 'PUT', { residentsSwapAfter: true })).status, 200);
  m = await map();
  assert.deepEqual([m.residentsEnabled, m.residentsMode, m.residentInfo], [true, 'swap', '']);
  assert.equal((await (await res('/me', { headers: { cookie: c1 } })).json()).mode, 'swap');
  const ok = await post('/set', { status: 'red' }, c1);
  assert.equal(ok.status, 200);
  assert.deepEqual([(await ok.json()).pending], [true]); // nog steeds ter goedkeuring
  assert.equal((await post('/set', { status: 'none' }, c1)).status, 403); // niet naar "niet gemarkeerd"
  assert.equal((await post('/set', { status: 'green' }, c1)).status, 200); // terug = voorstel vervalt
  assert.equal((await post('/set', { status: 'green' }, c2)).status, 403); // huis zonder status blijft dicht
  // geen nieuw huis kiezen, niet herkoppelen
  assert.equal((await post('/claim', { houseId: 'h3' })).status, 403);
  assert.equal((await post('/claim', { houseId: 'h3' }, c1)).status, 403);

  // schakelaar uit: weer helemaal dicht; planning uit: weer open
  await adminReq('/settings', 'PUT', { residentsSwapAfter: false });
  assert.equal((await post('/set', { status: 'red' }, c1)).status, 403);
  await adminReq('/settings', 'PUT', { residentsOff: false });
  assert.equal((await map()).residentsMode, 'open');
  assert.equal((await post('/set', { status: 'red' }, c1)).status, 200);
  assert.equal((await (await adminReq('/settings')).json()).residentsSwapAfter, false);
  for (const r of (await (await adminReq('/changes')).json()).residents) await adminReq(`/residents/${r.rid}`, 'DELETE');
});

test('geofence: wijzigen alleen in de wijk (schakelaar in het beheer)', async () => {
  await adminReq('/settings', 'PUT', { residentsEnabled: true, residentsAppOnly: false, residentsOff: false, residentsSwapAfter: false, residentsGeofence: false });
  await adminReq('/houses', 'PUT', { houses: [{ id: 'h1', street: 'Dorpsstraat', number: '1', status: 'none', points: ptsR }] });
  await adminReq('/view', 'DELETE'); // geen vaste weergave: midden = midden van de huizen
  for (const r of (await (await adminReq('/changes')).json()).residents) await adminReq(`/residents/${r.rid}`, 'DELETE');
  const geo = (lat, lng, acc) => ({ 'X-Geo': `${lat},${lng},${acc}`, 'X-Geo-Device': 'gps' });
  const postG = (path, body, h = {}, c) => j(`/api/resident${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(c ? { cookie: c } : {}), ...h }, body: JSON.stringify(body || {}) });
  const center = [52.000333, 5.000333];

  // uit: gewoon mogelijk zonder locatie, en de kaart meldt geen geofence
  assert.equal((await (await j('/api/map')).json()).geofence, null);
  const c = (await post('/claim', { houseId: 'h1' })).headers.get('set-cookie').split(';')[0];

  // aan: de kaart kent midden en straal; zonder locatie geweigerd
  assert.equal((await adminReq('/settings', 'PUT', { residentsGeofence: true, residentsGeofenceRadius: 500 })).status, 200);
  const m = await (await j('/api/map')).json();
  assert.equal(m.geofence.radius, 500);
  assert.ok(Math.abs(m.geofence.center[0] - center[0]) < 0.001);
  let r = await postG('/set', { status: 'green' }, {}, c);
  assert.equal(r.status, 403);
  assert.equal((await r.json()).geofence, 'missing');
  assert.equal((await postG('/set', { status: 'green' }, { 'X-Geo': 'onzin' }, c)).status, 403);

  // in de wijk mag, ver weg niet (een vage fix telt maximaal 500 m mee)
  assert.equal((await postG('/set', { status: 'green' }, geo(52.0005, 5.0005, 20), c)).status, 200);
  r = await postG('/set', { status: 'red' }, geo(52.05, 5.05, 20), c); // ~6 km
  assert.equal(r.status, 403);
  assert.equal((await r.json()).geofence, 'outside');
  // alleen GPS-nauwkeurigheid (<= 200 m) en alleen GPS-apparaten (geen desktop)
  r = await postG('/set', { status: 'red' }, geo(52.0005, 5.0005, 800), c);
  assert.equal(r.status, 403);
  assert.equal((await r.json()).geofence, 'inaccurate');
  // desktops/laptops (geen GPS) worden niet beperkt, ook ver van de wijk; een mobiele user-agent telt niet als desktop
  assert.equal((await postG('/set', { status: 'red' }, { 'X-Geo-Device': 'desktop', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0' }, c)).status, 200);
  r = await postG('/set', { status: 'green' }, { 'X-Geo-Device': 'desktop', 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) Mobile Safari/537.36' }, c);
  assert.equal(r.status, 403);
  assert.equal((await r.json()).geofence, 'missing');
  assert.equal((await postG('/set', { status: 'red' }, { 'X-Geo': '52.0005,5.0005,20' }, c)).status, 200); // zonder apparaatkop telt de locatie gewoon
  assert.equal((await postG('/set', { status: 'red' }, geo(52.0045, 5.0045, 150), c)).status, 200); // net buiten, maar binnen de nauwkeurigheid
  assert.equal((await postG('/claim', { houseId: 'h1' }, geo(52.05, 5.05, 10))).status, 403); // ook huis kiezen

  // lezen blijft altijd kunnen; straal valideren; weer uit
  assert.equal((await res('/me', { headers: { cookie: c } })).status, 200);
  assert.equal((await adminReq('/settings', 'PUT', { residentsGeofenceRadius: 5 })).status, 400);
  assert.equal((await adminReq('/settings', 'PUT', { residentsGeofenceRadius: 99999 })).status, 400);
  assert.equal((await (await adminReq('/settings')).json()).residentsGeofence, true);
  await adminReq('/settings', 'PUT', { residentsGeofence: false });
  assert.equal((await post('/set', { status: 'none' }, c)).status, 200);
  assert.equal((await j('/api/admin/settings', { method: 'PUT', headers: jsonH(), body: '{"residentsGeofence":true}' })).status, 401);
  for (const rr of (await (await adminReq('/changes')).json()).residents) await adminReq(`/residents/${rr.rid}`, 'DELETE');
});

test('eenvoudige weergave: instelling in het beheer, zichtbaar op de kaart', async () => {
  assert.equal((await (await j('/api/map')).json()).simpleUi, false);
  assert.equal((await adminReq('/settings', 'PUT', { simpleUi: true })).status, 200);
  assert.equal((await (await j('/api/map')).json()).simpleUi, true);
  assert.equal((await (await adminReq('/settings')).json()).simpleUi, true);
  assert.equal((await j('/api/admin/settings', { method: 'PUT', headers: jsonH(), body: '{"simpleUi":false}' })).status, 401);
  await adminReq('/settings', 'PUT', { simpleUi: false });
  assert.equal((await (await j('/api/map')).json()).simpleUi, false);
});

test('toegangscode voor apparaten zonder GPS (schakelaar en code in het beheer)', async () => {
  await adminReq('/settings', 'PUT', { residentsEnabled: true, residentsAppOnly: false, residentsOff: false, residentsSwapAfter: false, residentsGeofence: false, residentsCodeOn: false });
  await adminReq('/houses', 'PUT', { houses: [{ id: 'h1', street: 'Dorpsstraat', number: '1', status: 'none', points: ptsR }] });
  for (const r of (await (await adminReq('/changes')).json()).residents) await adminReq(`/residents/${r.rid}`, 'DELETE');
  const WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0';
  const AND = 'Mozilla/5.0 (Linux; Android 14) Mobile Safari/537.36';
  const rq = (path, body, { cookie: ck, ua = WIN, dev = 'desktop' } = {}) => j(`/api/resident${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': ua, ...(dev ? { 'X-Geo-Device': dev } : {}), ...(ck ? { cookie: ck } : {}) }, body: JSON.stringify(body || {}) });

  // standaard: geen code nodig, de kaart meldt dat ook
  assert.equal((await (await j('/api/map')).json()).deviceCode, false);
  const ck1 = (await rq('/claim', { houseId: 'h1' })).headers.get('set-cookie').split(';')[0];

  // validatie in het beheer: eerst een geldige code, dan pas aan
  assert.equal((await adminReq('/settings', 'PUT', { residentsCodeOn: true })).status, 400);
  assert.equal((await adminReq('/settings', 'PUT', { residentsCode: '12' })).status, 400);
  assert.equal((await adminReq('/settings', 'PUT', { residentsCode: '12a456' })).status, 400);
  assert.equal((await adminReq('/settings', 'PUT', { residentsCode: '4821', residentsCodeOn: true })).status, 200);
  const st = await (await adminReq('/settings')).json();
  assert.deepEqual([st.residentsCodeOn, st.residentsCode], [true, '4821']);
  const m = await (await j('/api/map')).json();
  assert.equal(m.deviceCode, true);
  assert.ok(!JSON.stringify(m).includes('4821')); // de code staat nooit in de publieke kaartgegevens

  // desktop zonder code: geweigerd; /me meldt dat de code ontbreekt
  let r = await rq('/set', { status: 'green' }, { cookie: ck1 });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).code, 'required');
  assert.equal((await (await res('/me', { headers: { cookie: ck1 } })).json()).codeOk, false);
  // een telefoon (GPS) hoeft geen code in te vullen
  assert.equal((await rq('/set', { status: 'green' }, { cookie: ck1, ua: AND, dev: 'gps' })).status, 200);

  // verkeerde en juiste code
  r = await rq('/code', { code: '0000' });
  assert.equal(r.status, 403);
  r = await rq('/code', { code: '4821' }, { cookie: ck1 });
  assert.equal(r.status, 200);
  const codeCookie = r.headers.get('set-cookie').split(';')[0];
  assert.match(r.headers.get('set-cookie'), /sm_code=.+HttpOnly/);
  const both = `${ck1}; ${codeCookie}`;
  assert.equal((await rq('/set', { status: 'red' }, { cookie: both })).status, 200);
  assert.equal((await (await res('/me', { headers: { cookie: both } })).json()).codeOk, true);

  // code wijzigen maakt de oude cookie ongeldig; code uitzetten laat iedereen toe
  await adminReq('/settings', 'PUT', { residentsCode: '555555' });
  assert.equal((await rq('/set', { status: 'green' }, { cookie: both })).status, 403);
  await adminReq('/settings', 'PUT', { residentsCodeOn: false });
  assert.equal((await rq('/set', { status: 'green' }, { cookie: ck1 })).status, 200);
  assert.equal((await rq('/code', { code: 'x' })).status, 200); // uit: niets te doen

  // alleen met beheersessie
  assert.equal((await j('/api/admin/settings', { method: 'PUT', headers: jsonH(), body: '{"residentsCode":"1234"}' })).status, 401);
  await adminReq('/settings', 'PUT', { residentsCode: '' });
  for (const rr of (await (await adminReq('/changes')).json()).residents) await adminReq(`/residents/${rr.rid}`, 'DELETE');
});

test('beheer heeft een eigen PWA-manifest, icoon en favicon', async () => {
  const m = await (await j('/beheer.webmanifest')).json();
  assert.deepEqual([m.start_url, m.scope, m.short_name, m.display], ['/beheer', '/beheer', 'Beheer', 'standalone']);
  assert.match(m.name, /Beheer$/);
  assert.ok(m.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'));
  for (const i of m.icons) assert.equal((await j(i.src)).status, 200, i.src); // de iconen bestaan echt
  const html = await (await j('/beheer')).text();
  assert.match(html, /rel="manifest" href="\/beheer\.webmanifest"/);
  assert.match(html, /rel="icon"[^>]*admin-favicon-32\.png/);
  assert.match(html, /rel="apple-touch-icon" href="\/icons\/admin-apple-touch-icon\.png"/);
  assert.equal((await j('/icons/admin-favicon-32.png')).status, 200);
  assert.equal((await j('/icons/admin-apple-touch-icon.png')).status, 200);
  // de publieke site houdt zijn eigen manifest en icoon
  const pub = await (await j('/manifest.webmanifest')).json();
  assert.equal(pub.start_url, '/');
});

test('Meertaligheid: standaard uit en Nederlands; instelbaar; taal staat in de pagina en in /api/map', async () => {
  const m0 = await (await j('/api/map')).json();
  assert.equal(m0.multilingual, false);
  assert.equal(m0.defaultLang, 'nl');
  const page0 = await (await j('/')).text();
  assert.match(page0, /<html lang="nl">/);
  assert.match(page0, /<meta name="sm-lang" content="nl">/);
  assert.equal((await adminReq('/settings', 'PUT', { defaultLang: 'fr' })).status, 400);
  assert.equal((await adminReq('/settings', 'PUT', { multilingual: true, defaultLang: 'en', translations: { en: { intro: 'Welcome', residentInfo: 'Hello residents', siteTitle: 'Our street' } } })).status, 200);
  const m1 = await (await j('/api/map')).json();
  assert.equal(m1.multilingual, true);
  assert.equal(m1.defaultLang, 'en');
  assert.equal(m1.translations.en.intro, 'Welcome');
  assert.equal(m1.translations.en.siteTitle, 'Our street');
  const page1 = await (await j('/beheer')).text();
  assert.match(page1, /<html lang="en">/);
  assert.match(page1, /<meta name="sm-lang" content="en" data-multi="1">/);
  const man = await (await j('/manifest.webmanifest')).json();
  assert.equal(man.lang, 'en');
  assert.equal(man.name, 'Our street'); // de naam in de standaardtaal
  const st = await (await adminReq('/settings')).json();
  assert.deepEqual([st.multilingual, st.defaultLang, st.translations.en.intro, st.translations.en.residentInfo], [true, 'en', 'Welcome', 'Hello residents']);
  assert.equal((await adminReq('/settings', 'PUT', { translations: { en: { intro: 'x'.repeat(5001) } } })).status, 400);
  assert.equal((await adminReq('/settings', 'PUT', { translations: { fr: { intro: 'x' } } })).status, 400);
  assert.equal((await adminReq('/settings', 'PUT', { translations: { nl: { intro: 'x' } } })).status, 400);
  assert.equal((await adminReq('/settings', 'PUT', { translations: { en: { labels: { green: 'x'.repeat(25) } } } })).status, 400);
  assert.equal((await adminReq('/settings', 'PUT', { translations: 'x' })).status, 400);
  // alleen opgegeven velden veranderen; een lege vertaling valt terug op het Nederlands
  assert.equal((await adminReq('/settings', 'PUT', { intro: 'Welkom', translations: { en: { labels: { green: 'Agreed' }, intro: '' } } })).status, 200);
  const m2 = await (await j('/api/map')).json();
  assert.equal(m2.intro, 'Welkom');
  assert.equal(m2.translations.en.intro, '');
  assert.equal(m2.translations.en.siteTitle, 'Our street');
  assert.equal(m2.translations.en.labels.green, 'Agreed');
  assert.equal(m2.labels.green, 'Groen');
  // terug naar de standaard
  assert.equal((await adminReq('/settings', 'PUT', { multilingual: false, defaultLang: 'nl', intro: '', translations: { en: { siteTitle: '', labels: { green: '' }, residentInfo: '' } } })).status, 200);
  assert.equal((await (await j('/api/map')).json()).defaultLang, 'nl');
});

test('Teksten van een vertaling gaan mee in een backup en worden teruggezet', async () => {
  const backups = require('../server/backups');
  assert.equal((await adminReq('/settings', 'PUT', { translations: { en: { intro: 'English intro' } } })).status, 200);
  const id = backups.create('test', true, { force: true });
  assert.equal(backups.read(id).texts.translations.en.intro, 'English intro');
  assert.equal((await adminReq('/settings', 'PUT', { translations: { en: { intro: 'Changed' } } })).status, 200);
  assert.ok(backups.restore(id));
  assert.equal((await (await j('/api/map')).json()).translations.en.intro, 'English intro');
  assert.equal((await adminReq('/settings', 'PUT', { translations: { en: { intro: '' } } })).status, 200);
});

test('Oude losse velden introEn/residentInfoEn worden gemigreerd naar translations.en', () => {
  const store = require('../server/store');
  const lang = require('../server/lang');
  const s = store.db().settings;
  s.introEn = 'Old intro'; s.residentInfoEn = 'Old info';
  lang.migrate();
  assert.equal(s.translations.en.intro, 'Old intro');
  assert.equal(s.translations.en.residentInfo, 'Old info');
  assert.ok(!('introEn' in s) && !('residentInfoEn' in s));
  s.translations.en.intro = ''; s.translations.en.residentInfo = '';
});

test('Tekst bij delen via WhatsApp is instelbaar per taal (standaard, opslaan, te lang, leeg = standaard)', async () => {
  const get = async () => (await (await adminReq('/changes')).json());
  const d0 = await get();
  assert.match(d0.shareTexts.nl, /\{adres\}.*\{link\}/);
  assert.equal(d0.shareTexts.nl, d0.defaultShareTexts.nl);
  assert.match(d0.defaultShareTexts.en, /\{adres\}.*\{link\}/);
  assert.notEqual(d0.defaultShareTexts.en, d0.defaultShareTexts.nl); // Engelse standaardtekst
  assert.equal((await adminReq('/settings', 'PUT', { qrShareText: 'Hoi, jouw huis {adres}: {link}', translations: { en: { qrShareText: 'Hi, your house {adres}: {link}' } } })).status, 200);
  const d1 = await get();
  assert.equal(d1.shareTexts.nl, 'Hoi, jouw huis {adres}: {link}');
  assert.equal(d1.shareTexts.en, 'Hi, your house {adres}: {link}');
  assert.equal((await adminReq('/settings', 'PUT', { qrShareText: 'x'.repeat(501) })).status, 400);
  assert.equal((await adminReq('/settings', 'PUT', { translations: { en: { qrShareText: 'x'.repeat(501) } } })).status, 400);
  assert.equal((await get()).shareTexts.nl, 'Hoi, jouw huis {adres}: {link}');
  assert.equal((await adminReq('/settings', 'PUT', { qrShareText: '  ', translations: { en: { qrShareText: '' } } })).status, 200);
  const d2 = await get();
  assert.equal(d2.shareTexts.nl, d0.defaultShareTexts.nl);
  assert.equal(d2.shareTexts.en, d0.defaultShareTexts.en);
});

test('QR-code per huis: alleen via QR koppelen (schakelaar), een apparaat per huis, vernieuwen', async () => {
  const mkh = (id) => ({ id, street: 'Dorpsstraat', number: id.slice(1), status: 'none', points: ptsR });
  await adminReq('/settings', 'PUT', { residentsEnabled: true, residentsAppOnly: false, residentsOff: false, residentsGeofence: false, residentsCodeOn: false, residentsQrOnly: false });
  await adminReq('/houses', 'PUT', { houses: [mkh('h1'), mkh('h2')] });
  for (const r of (await (await adminReq('/changes')).json()).residents) await adminReq(`/residents/${r.rid}`, 'DELETE');
  const WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0';
  const rq = (path, body, { cookie: ck, dev = 'desktop' } = {}) => j(`/api/resident${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': WIN, ...(dev ? { 'X-Geo-Device': dev } : {}), ...(ck ? { cookie: ck } : {}) }, body: JSON.stringify(body || {}) });

  // admin: QR-lijst met een geheim per huis; geheimen staan nooit in de publieke kaartgegevens
  const list = await (await adminReq('/qr')).json();
  assert.deepEqual(list.map((i) => i.houseId).sort(), ['h1', 'h2']);
  const q1 = new URL(list.find((i) => i.houseId === 'h1').url).searchParams.get('q');
  const q2 = new URL(list.find((i) => i.houseId === 'h2').url).searchParams.get('q');
  assert.ok(q1.length >= 16 && q1 !== q2);
  assert.ok(!JSON.stringify(await (await j('/api/map')).json()).includes(q1));
  assert.equal((await adminReq('/qr')).status, 200);
  for (const [m, p] of [['GET', '/qr'], ['POST', '/qr/rotate-all'], ['POST', '/qr/h1/rotate']]) assert.equal((await j(`/api/admin${p}`, { method: m, headers: jsonH(), body: m === 'POST' ? '{}' : undefined })).status, 401, p);

  // lookup: juiste en foute QR
  assert.equal((await (await rq('/qr/lookup', { q: q1 })).json()).title, 'Dorpsstraat 1');
  assert.equal((await rq('/qr/lookup', { q: 'x'.repeat(24) })).status, 403);

  // schakelaar uit: de kaart (houseId) werkt nog; QR werkt ook
  assert.equal((await (await j('/api/map')).json()).qrOnly, false);
  const viaMap = await rq('/claim', { houseId: 'h2' });
  assert.equal(viaMap.status, 200);
  const cMap = viaMap.headers.get('set-cookie').split(';')[0];
  for (const r of (await (await adminReq('/changes')).json()).residents) await adminReq(`/residents/${r.rid}`, 'DELETE');

  // schakelaar aan: houseId-only wordt geweigerd, QR werkt
  assert.equal((await adminReq('/settings', 'PUT', { residentsQrOnly: true })).status, 200);
  assert.equal((await (await j('/api/map')).json()).qrOnly, true);
  assert.equal((await (await adminReq('/settings')).json()).residentsQrOnly, true);
  let r = await rq('/claim', { houseId: 'h1' });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).qr, 'required');
  r = await rq('/claim', { q: q1 });
  assert.equal(r.status, 200);
  const c1 = r.headers.get('set-cookie').split(';')[0];
  assert.equal((await r.json()).claim.houseId, 'h1');

  // een apparaat per huis: een tweede apparaat met dezelfde QR wordt geweigerd; ander huis kan wel
  r = await rq('/claim', { q: q1 });
  assert.equal(r.status, 409);
  assert.equal((await (await rq('/qr/lookup', { q: q1 })).json()).taken, true);
  assert.equal((await rq('/claim', { q: q2 })).status, 200);
  for (const rr of (await (await adminReq('/changes')).json()).residents) await adminReq(`/residents/${rr.rid}`, 'DELETE');

  // QR vervangt de toegangscode (desktop): zonder QR geen /set zonder code, met QR wel
  await adminReq('/settings', 'PUT', { residentsCode: '4821', residentsCodeOn: true });
  r = await rq('/claim', { q: q1 });
  assert.equal(r.status, 200);
  const cks = r.headers.getSetCookie().map((x) => x.split(';')[0]).join('; ');
  assert.match(cks, /sm_code=/);
  assert.equal((await rq('/set', { status: 'green' }, { cookie: cks })).status, 200);
  await adminReq('/settings', 'PUT', { residentsCodeOn: false, residentsCode: '' });
  for (const rr of (await (await adminReq('/changes')).json()).residents) await adminReq(`/residents/${rr.rid}`, 'DELETE');

  // vernieuwen: de oude QR werkt niet meer, de nieuwe wel
  const rot = await (await adminReq('/qr/h1/rotate', 'POST', {})).json();
  const q1b = new URL(rot.url).searchParams.get('q');
  assert.notEqual(q1b, q1);
  assert.equal((await rq('/claim', { q: q1 })).status, 403);
  assert.equal((await rq('/claim', { q: q1b })).status, 200);
  assert.equal((await adminReq('/qr/nope/rotate', 'POST', {})).status, 404);
  await adminReq('/qr/rotate-all', 'POST', {});
  assert.equal((await rq('/qr/lookup', { q: q1b })).status, 403);

  // geheimen van verwijderde huizen worden opgeruimd
  await adminReq('/houses', 'PUT', { houses: [mkh('h2')] });
  assert.deepEqual((await (await adminReq('/qr')).json()).map((i) => i.houseId), ['h2']);

  // lezen/uit: opruimen
  await adminReq('/settings', 'PUT', { residentsQrOnly: false });
  for (const rr of (await (await adminReq('/changes')).json()).residents) await adminReq(`/residents/${rr.rid}`, 'DELETE');
  void cMap; void c1;
});

test('bericht aan de beheerder: versturen, beperken, badge-tellers en pushmelding met badge', async () => {
  await adminReq('/settings', 'PUT', { residentsEnabled: true, residentsAppOnly: false, residentsOff: false, residentsGeofence: false, residentsCodeOn: false, residentsQrOnly: false });
  await adminReq('/houses', 'PUT', { houses: [{ id: 'h1', street: 'Dorpsstraat', number: '1', status: 'none', points: ptsR }, { id: 'h2', street: 'Dorpsstraat', number: '2', status: 'none', points: ptsR }] });
  for (const r of (await (await adminReq('/changes')).json()).residents) await adminReq(`/residents/${r.rid}`, 'DELETE');
  for (const m of (await (await adminReq('/changes')).json()).messages) await adminReq(`/messages/${m.id}`, 'DELETE');
  const sent = [];
  push._setSender({ sendNotification: async (sub, payload) => { sent.push(JSON.parse(payload)); } });
  await adminReq('/push/subscribe', 'POST', { label: 'Telefoon', subscription: { endpoint: 'https://push.example/msg', keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) } } });
  const q2 = new URL((await (await adminReq('/qr')).json()).find((i) => i.houseId === 'h2').url).searchParams.get('q');
  const c1 = (await post('/claim', { houseId: 'h1' })).headers.get('set-cookie').split(';')[0];
  const msg = (body, ck) => res('/message', { method: 'POST', headers: ck ? { cookie: ck } : {}, body: JSON.stringify(body) });

  // validatie
  assert.equal((await msg({ text: '   ' })).status, 400);
  assert.equal((await msg({ text: 'x'.repeat(301) })).status, 400);
  assert.equal((await adminReq('/changes/count').then((r) => r.json())).total, 0);

  // een gekoppeld apparaat scant de QR van een ander huis en stuurt een bericht
  assert.equal((await msg({ text: 'Mijn  buurman   woont hier nu.', q: q2 }, c1)).status, 200);
  const list = await (await adminReq('/changes')).json();
  assert.equal(list.messages.length, 1);
  assert.deepEqual([list.messages[0].text, list.messages[0].ownTitle, list.messages[0].scannedTitle], ['Mijn buurman woont hier nu.', 'Dorpsstraat 1', 'Dorpsstraat 2']);
  assert.equal(list.messages[0].ip, undefined); // het IP-adres gaat niet naar de browser van de beheerder

  // tellers voor de badges: wijzigingen + berichten
  await post('/set', { status: 'green' }, c1);
  assert.deepEqual(await (await adminReq('/changes/count')).json(), { pending: 1, messages: 1, total: 2 });
  await wait(120);
  const last = sent[sent.length - 1];
  assert.equal(last.badge, 2);
  assert.match(last.body, /1 wijziging en 1 bericht/);

  // alleen een bericht: eigen titel en tekst in de melding
  await adminReq('/changes/approve-all', 'POST');
  await msg({ text: 'Tweede bericht' }, c1);
  await wait(120);
  assert.equal(sent[sent.length - 1].title, 'Bericht van een bewoner');
  assert.equal(sent[sent.length - 1].badge, 2);

  // beperking per IP (5 per kwartier), ook na het einde van wijzigen mag het nog (swap), maar niet als alles dicht is
  for (let i = 0; i < 3; i++) assert.equal((await msg({ text: `Bericht ${i}` })).status, 200);
  assert.equal((await msg({ text: 'Te veel' })).status, 429);

  // beheer: verwijderen en rechten
  const after = await (await adminReq('/changes')).json();
  for (const m of after.messages) assert.equal((await adminReq(`/messages/${m.id}`, 'DELETE')).status, 200);
  assert.equal((await (await adminReq('/changes/count')).json()).messages, 0);
  assert.equal((await j('/api/admin/messages/x', { method: 'DELETE', headers: jsonH() })).status, 401);
  for (const rr of (await (await adminReq('/changes')).json()).residents) await adminReq(`/residents/${rr.rid}`, 'DELETE');
});

test('gekoppelde apparaten staan alfabetisch (straat, dan huisnummer, numeriek)', async () => {
  await adminReq('/settings', 'PUT', { residentsEnabled: true, residentsAppOnly: false, residentsOff: false, residentsGeofence: false, residentsCodeOn: false, residentsQrOnly: false });
  const mk = (id, street, number) => ({ id, street, number, status: 'none', points: ptsR });
  await adminReq('/houses', 'PUT', { houses: [mk('a', 'Loerikseweg', '10'), mk('b', 'Dorpsstraat', '9'), mk('c', 'Loerikseweg', '2'), mk('d', 'Dorpsstraat', '10'), mk('e', 'beukenlaan', '1')] });
  for (const r of (await (await adminReq('/changes')).json()).residents) await adminReq(`/residents/${r.rid}`, 'DELETE');
  for (const id of ['a', 'b', 'c', 'd', 'e']) await post('/claim', { houseId: id }); // in willekeurige volgorde gekoppeld
  const titles = (await (await adminReq('/changes')).json()).residents.map((r) => r.title);
  assert.deepEqual(titles, ['beukenlaan 1', 'Dorpsstraat 9', 'Dorpsstraat 10', 'Loerikseweg 2', 'Loerikseweg 10']);
  for (const r of (await (await adminReq('/changes')).json()).residents) await adminReq(`/residents/${r.rid}`, 'DELETE');
});

test('bewoners: uitschakelen, beheerrechten en push-registratie', async () => {
  for (const [m, p] of [['GET', '/changes'], ['POST', '/changes/approve-all'], ['DELETE', '/residents/x'], ['GET', '/push/key'], ['POST', '/push/test']]) {
    assert.equal((await j(`/api/admin${p}`, { method: m, headers: jsonH() })).status, 401, p);
  }
  const key = await (await adminReq('/push/key')).json();
  assert.ok(key.publicKey.length > 60);
  assert.equal((await adminReq('/push/subscribe', 'POST', { subscription: { endpoint: 'http://onveilig', keys: {} } })).status, 400);
  // verlopen registraties (410) worden opgeruimd
  push._setSender({ sendNotification: async () => { throw Object.assign(new Error('gone'), { statusCode: 410 }); } });
  const r = await (await adminReq('/push/test', 'POST')).json();
  assert.equal(r.removed >= 1, true);
  assert.equal((await (await adminReq('/push/devices')).json()).length, 0);

  await adminReq('/settings', 'PUT', { residentsEnabled: false });
  assert.equal((await res('/me')).status, 403);
  assert.equal((await post('/claim', { houseId: 'h2' })).status, 403);
  assert.equal((await (await j('/api/map')).json()).residentsEnabled, false);
  await adminReq('/settings', 'PUT', { residentsEnabled: true });
});

test('namen van de statussen zijn instelbaar (met terugval op de standaard)', async () => {
  const put = (labels) => j('/api/admin/settings', { method: 'PUT', headers: jsonH(cookie), body: JSON.stringify({ labels }) });
  assert.deepEqual((await (await j('/api/map')).json()).labels, { green: 'Groen', red: 'Rood', none: 'Niet gemarkeerd' });
  const r = await put({ green: ' Akkoord ', red: 'Nog niet bezocht', none: '' });
  assert.equal(r.status, 200);
  assert.deepEqual((await (await j('/api/map')).json()).labels, { green: 'Akkoord', red: 'Nog niet bezocht', none: 'Niet gemarkeerd' });
  assert.equal((await put({ green: 'x'.repeat(25) })).status, 400);
  await wait(50);
  assert.equal(backups.read(backups.list()[0].id).texts.labels.green, 'Akkoord');
  assert.equal((await put({ green: '', red: '' })).status, 200); // leeg = standaard
  assert.equal((await (await j('/api/map')).json()).labels.red, 'Rood');
});

test('pushmelding gebruikt de ingestelde statusnaam', async () => {
  process.env.PUSH_DELAY_MS = '10';
  const sent = [];
  push._setSender({ sendNotification: async (sub, payload) => { sent.push(JSON.parse(payload)); } });
  await adminReq('/settings', 'PUT', { labels: { green: 'Akkoord' }, residentsEnabled: true });
  await adminReq('/houses', 'PUT', { houses: [{ id: 'q1', street: 'Test', number: '1', status: 'none', points: ptsR }] });
  await adminReq('/push/subscribe', 'POST', { label: 'T', subscription: { endpoint: 'https://push.example/zzz', keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) } } });
  const c = (await post('/claim', { houseId: 'q1' })).headers.get('set-cookie').split(';')[0];
  await post('/set', { status: 'green' }, c);
  await wait(80);
  assert.match(sent[0].body, /akkoord aangevraagd/);
  await adminReq('/settings', 'PUT', { labels: { green: '' } });
});

test('koppeling van een bewoner is te herstellen met het lokaal bewaarde token', async () => {
  await adminReq('/settings', 'PUT', { residentsEnabled: true });
  await adminReq('/houses', 'PUT', { houses: [{ id: 'r1', street: 'S', number: '1', status: 'none', points: ptsR }] });
  const claim = await post('/claim', { houseId: 'r1' });
  const body = await claim.json();
  assert.ok(body.deviceToken && body.deviceToken.length > 30);
  assert.equal((await post('/restore', { token: 'x'.repeat(40) })).status, 404);
  assert.equal((await post('/restore', { token: 'kort' })).status, 400);
  const back = await post('/restore', { token: body.deviceToken });
  assert.equal(back.status, 200);
  const cookieAgain = back.headers.get('set-cookie').split(';')[0];
  assert.equal((await (await res('/me', { headers: { cookie: cookieAgain } })).json()).claim.houseId, 'r1');
});

test('"alleen in de geïnstalleerde app": wijzigen vereist de app-kop, lezen niet', async () => {
  await adminReq('/settings', 'PUT', { residentsEnabled: true, residentsAppOnly: false });
  await adminReq('/houses', 'PUT', { houses: [{ id: 'a1', street: 'S', number: '1', status: 'none', points: ptsR }] });
  assert.equal((await (await j('/api/map')).json()).residentsAppOnly, false);
  assert.equal((await adminReq('/settings', 'PUT', { residentsAppOnly: true })).status, 200);
  assert.equal((await (await j('/api/map')).json()).residentsAppOnly, true);
  assert.equal((await (await adminReq('/changes')).json()).appOnly, true);

  // browser (zonder kop): wijzigen geweigerd, status lezen mag
  const noApp = await post('/claim', { houseId: 'a1' });
  assert.equal(noApp.status, 403);
  assert.equal((await noApp.json()).appOnly, true);
  assert.equal((await res('/me')).status, 200);

  // app (met kop): werkt
  const app = await j('/api/resident/claim', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Mode': 'standalone' }, body: JSON.stringify({ houseId: 'a1' }) });
  assert.equal(app.status, 200);
  const c = app.headers.get('set-cookie').split(';')[0];
  const noHeader = await post('/set', { status: 'green' }, c);
  assert.equal(noHeader.status, 403);
  const withHeader = await j('/api/resident/set', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Mode': 'standalone', cookie: c }, body: JSON.stringify({ status: 'green' }) });
  assert.equal(withHeader.status, 200);

  await adminReq('/settings', 'PUT', { residentsAppOnly: false });
  assert.equal((await post('/set', { status: 'none' }, c)).status, 200); // weer open voor de browser
});
