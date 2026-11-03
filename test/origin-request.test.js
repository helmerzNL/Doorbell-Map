// Zonder ORIGIN volgt de app het adres waarop hij wordt geopend: de origin-check, het passkey-domein, de Secure-vlag van de
// sessiecookie en de links in QR-codes en uitnodigingen komen dan uit de aanvraag. Eigen bestand, zodat ORIGIN leeg is bij het laden.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-req-'));
process.env.SETUP_TOKEN = 'test-setup-token-123';
process.env.SESSION_SECRET = 'test-session-secret-123';
delete process.env.ORIGIN;
delete process.env.RP_ID;
const app = require('../server/index.js');
const store = require('../server/store');
const { FakeAuthenticator } = require('./fake-authenticator');

let server, base, host;
test.before(() => new Promise((r) => {
  server = app.listen(0, () => { host = `localhost:${server.address().port}`; base = `http://${host}`; r(); });
}));
test.after(() => server.close());

const PROXY = { 'X-Forwarded-Host': 'map.example.com', 'X-Forwarded-Proto': 'https' };
const call = async (method, p, body, headers = {}) => {
  const r = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = r.headers.get('set-cookie');
  return { status: r.status, body: await r.json().catch(() => ({})), setCookie: set, cookie: set && !set.startsWith('sm_session=;') ? set.split(';')[0] : null };
};
const post = (p, body, headers) => call('POST', p, body ?? {}, headers);
const get = (p, headers) => call('GET', p, undefined, headers);
function fresh() { const d = store.db(); d.users = []; d.passkeys = []; d.invites = []; }

test('zonder ORIGIN: wijzigingen van de eigen host tellen, van een andere host niet', async () => {
  assert.equal((await post('/api/auth/logout', {}, { Origin: base })).status, 200);
  // achter een proxy die X-Forwarded-Proto niet doorgeeft ziet de server http en de browser https: de host telt
  assert.equal((await post('/api/auth/logout', {}, { Origin: `https://${host}` })).status, 200);
  assert.equal((await post('/api/auth/logout', {}, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/auth/logout', {}, { Origin: 'null' })).status, 403);
  assert.equal((await post('/api/auth/logout', {}, { Origin: 'https://map.example.com', ...PROXY })).status, 200);
});

test('zonder ORIGIN: of een passkey kan, hangt af van het adres waarop de app is geopend', async () => {
  fresh();
  assert.equal((await get('/api/auth/status')).body.passkey.available, true); // localhost
  const ip = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/status`).then((r) => r.json());
  assert.equal(ip.passkey.available, false);
  assert.match(ip.passkey.reason, /IP-adres/);
  assert.equal((await get('/api/auth/status', { 'X-Forwarded-Host': 'homeassistant.local:9888' })).body.passkey.available, false);
  assert.equal((await get('/api/auth/status', PROXY)).body.passkey.available, true);
  assert.equal((await get('/api/auth/status', { 'X-Forwarded-Host': 'map.example.com' })).body.passkey.available, false); // geen https
});

test('zonder ORIGIN: een passkey hoort bij de host van de pagina, en inloggen ermee werkt', async () => {
  fresh();
  const viaProxy = await post('/api/auth/register/options', { setupToken: 'test-setup-token-123', username: 'Helmer' }, { Origin: 'https://map.example.com', ...PROXY });
  assert.equal(viaProxy.body.options.rp.id, 'map.example.com');

  const fa = new FakeAuthenticator({ origin: base, rpID: 'localhost' });
  const o = await post('/api/auth/register/options', { setupToken: 'test-setup-token-123', username: 'Helmer', name: 'Telefoon' }, { Origin: base });
  assert.equal(o.body.options.rp.id, 'localhost');
  const v = await post('/api/auth/register/verify', { challengeId: o.body.challengeId, response: fa.register(o.body.options) }, { Origin: base });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.ok(!/;\s*Secure/i.test(v.setCookie), 'geen Secure-cookie op http');

  const lo = await post('/api/auth/login/options', {}, { Origin: base });
  const lv = await post('/api/auth/login/verify', { challengeId: lo.body.challengeId, response: fa.assert(lo.body.options) }, { Origin: base });
  assert.equal(lv.status, 200, JSON.stringify(lv.body));

  // een antwoord voor een ander adres dan waarop de uitdaging is uitgegeven, wordt geweigerd
  const other = new FakeAuthenticator({ origin: 'https://evil.example', rpID: 'localhost' });
  other.credId = fa.credId; other.id = fa.id; other.privateKey = fa.privateKey; other.counter = fa.counter;
  const bo = await post('/api/auth/login/options', {}, { Origin: base });
  const bv = await post('/api/auth/login/verify', { challengeId: bo.body.challengeId, response: other.assert(bo.body.options) }, { Origin: base });
  assert.equal(bv.status, 400);
});

let owner;
test('zonder ORIGIN: installatie met wachtwoord; via https krijgt de cookie Secure, ook zonder X-Forwarded-Proto', async () => {
  fresh();
  const r = await post('/api/auth/setup/password', { setupToken: 'test-setup-token-123', username: 'Helmer', password: 'een-lang-wachtwoord' }, { Origin: `https://${host}` });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.setCookie, /;\s*Secure/i);
  const plain = await post('/api/auth/password-login', { username: 'Helmer', password: 'een-lang-wachtwoord' }, { Origin: base });
  assert.equal(plain.status, 200);
  assert.ok(!/;\s*Secure/i.test(plain.setCookie), 'geen Secure-cookie op http');
  owner = plain.cookie;
});

test('zonder ORIGIN: links in uitnodigingen en QR-codes volgen het adres van het beheer', async () => {
  const inv = await post('/api/admin/users/invites', { username: 'Anna' }, { cookie: owner, Origin: base });
  assert.equal(inv.status, 200, JSON.stringify(inv.body));
  assert.ok(inv.body.url.startsWith(`${base}/beheer#invite=`), inv.body.url);
  const viaProxy = await post('/api/admin/users/invites', { username: 'Bert' }, { cookie: owner, Origin: 'https://map.example.com', ...PROXY });
  assert.ok(viaProxy.body.url.startsWith('https://map.example.com/beheer#invite='), viaProxy.body.url);

  const sq = [[52.02, 5.16], [52.02, 5.161], [52.021, 5.161]];
  const put = await call('PUT', '/api/admin/houses', { houses: [{ id: 'h1', street: 'Dorpsstraat', number: '1', status: 'green', points: sq }] }, { cookie: owner, Origin: base });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const qr = await get('/api/admin/qr', { cookie: owner });
  assert.ok(qr.body[0].url.startsWith(`${base}/?q=`), qr.body[0].url);
  const qrProxy = await get('/api/admin/qr', { cookie: owner, ...PROXY });
  assert.ok(qrProxy.body[0].url.startsWith('https://map.example.com/?q='), qrProxy.body[0].url);
});
