// Zonder ORIGIN: de app volgt het adres van de aanvraag, en de eerste beheerder kan met instelcode + wachtwoord worden ingesteld
// (voor een adres zonder https, waar passkeys niet werken). Eigen bestand, zodat de database leeg begint.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-pw-'));
process.env.SETUP_TOKEN = 'test-setup-token-123';
process.env.SESSION_SECRET = 'test-session-secret-123';
delete process.env.ORIGIN;
delete process.env.RP_ID;
const app = require('../server/index.js');
const store = require('../server/store');
const backups = require('../server/backups');

let server, base, host;
test.before(() => new Promise((r) => {
  server = app.listen(0, () => { host = `localhost:${server.address().port}`; base = `http://${host}`; r(); });
}));
test.after(() => server.close());

const j = (p, o = {}) => fetch(base + p, o);
const post = (p, body, headers = {}) => j(p, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: JSON.stringify(body) });
const put = (p, body, headers = {}) => j(p, { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: JSON.stringify(body) });
const cookieOf = (res) => res.headers.get('set-cookie').split(';')[0];
const status = async (cookie) => (await j('/api/auth/status', { headers: cookie ? { cookie } : {} })).json();
const PW = 'een-lang-wachtwoord';

test('zonder ORIGIN: wijzigingen van de eigen host tellen, van een andere host niet', async () => {
  assert.equal((await post('/api/auth/logout', {}, { Origin: base })).status, 200);
  // achter een proxy die X-Forwarded-Proto niet doorgeeft ziet de server http, de browser https: de host telt
  assert.equal((await post('/api/auth/logout', {}, { Origin: `https://${host}` })).status, 200);
  assert.equal((await post('/api/auth/logout', {}, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/auth/logout', {}, { Origin: 'null' })).status, 403);
  // achter een proxy telt de doorgegeven host
  const proxied = { Origin: 'https://map.example.com', 'X-Forwarded-Host': 'map.example.com', 'X-Forwarded-Proto': 'https' };
  assert.equal((await post('/api/auth/logout', {}, proxied)).status, 200);
});

test('zonder ORIGIN: passkeys horen bij de host waarop de pagina is geopend', async () => {
  const local = await (await post('/api/auth/register/options', { setupToken: 'test-setup-token-123' })).json();
  assert.equal(local.options.rp.id, 'localhost');
  const proxied = { Origin: 'https://map.example.com', 'X-Forwarded-Host': 'map.example.com', 'X-Forwarded-Proto': 'https' };
  const viaProxy = await (await post('/api/auth/register/options', { setupToken: 'test-setup-token-123' }, proxied)).json();
  assert.equal(viaProxy.options.rp.id, 'map.example.com');
});

test('eerste installatie met wachtwoord: instelcode en lengte worden gecontroleerd', async () => {
  assert.deepEqual([(await status()).configured, (await status()).passkeys], [false, 0]);
  assert.equal((await post('/api/auth/setup-password', { setupToken: 'nope', password: PW })).status, 403);
  assert.equal((await post('/api/auth/setup-password', { setupToken: 'test-setup-token-123', password: 'kort' })).status, 400);
  assert.equal((await post('/api/auth/setup-password', { setupToken: 'test-setup-token-123' })).status, 400);
  assert.equal(store.db().password, null);
});

let session;
test('eerste installatie met wachtwoord: logt in en werkt maar één keer', async () => {
  const ok = await post('/api/auth/setup-password', { setupToken: 'test-setup-token-123', password: PW });
  assert.equal(ok.status, 200);
  assert.ok(!/;\s*Secure/i.test(ok.headers.get('set-cookie')), 'geen Secure-cookie op http');
  session = cookieOf(ok);
  const st = await status(session);
  assert.deepEqual([st.configured, st.loggedIn, st.method, st.passwordEnabled, st.passkeys, st.fullSession], [true, true, 'pw', true, 0, true]);

  // de installatiecode werkt daarna niet meer, ook niet voor een passkey
  assert.equal((await post('/api/auth/setup-password', { setupToken: 'test-setup-token-123', password: 'nog-een-wachtwoord' })).status, 409);
  assert.equal((await post('/api/auth/register/options', { setupToken: 'test-setup-token-123' })).status, 401);
  // de beheerder kan wel zelf een eerste passkey toevoegen
  assert.equal((await post('/api/auth/register/options', { name: 'Telefoon' }, { cookie: session })).status, 200);
});

test('via https krijgt de sessiecookie Secure, ook als de proxy het schema niet doorgeeft', async () => {
  const r = await post('/api/auth/password-login', { password: PW }, { Origin: `https://${host}` });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie'), /;\s*Secure/i);
});

test('alleen wachtwoord: wijzigen vraagt het huidige wachtwoord, verwijderen kan niet', async () => {
  const change = (body) => put('/api/admin/password', body, { cookie: session });
  assert.equal((await change({ password: 'nieuw-wachtwoord-1' })).status, 400);
  assert.equal((await change({ password: 'nieuw-wachtwoord-1', currentPassword: 'fout-wachtwoord' })).status, 400);
  assert.equal((await change({ password: 'kort', currentPassword: PW })).status, 400);
  assert.equal((await change({ password: 'nieuw-wachtwoord-1', currentPassword: PW })).status, 200);
  assert.equal((await post('/api/auth/password-login', { password: PW })).status, 401);
  assert.equal((await post('/api/auth/password-login', { password: 'nieuw-wachtwoord-1' })).status, 200);
  assert.equal((await change({ password: PW, currentPassword: 'nieuw-wachtwoord-1' })).status, 200);

  const remove = await post('/api/admin/password/remove', {}, { cookie: session });
  assert.equal(remove.status, 400);
  assert.ok(store.db().password);
});

test('alleen wachtwoord: backups verwijderen bevestig je met het wachtwoord', async () => {
  const sq = [[52.02, 5.16], [52.02, 5.161], [52.021, 5.161]];
  assert.equal((await put('/api/admin/houses', { houses: [{ id: 'h1', street: 'Dorpsstraat', number: '1', status: 'green', points: sq }] }, { cookie: session })).status, 200);
  const [b] = backups.list();
  assert.ok(b, 'er is een backup na het opslaan');
  const del = (body) => post('/api/admin/backups/delete', { ids: [b.id], ...body }, { cookie: session });
  assert.equal((await del({})).status, 400);
  assert.equal((await del({ password: 'fout-wachtwoord' })).status, 400);
  assert.ok(backups.read(b.id));
  const ok = await del({ password: PW });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).deleted, 1);
});

test('zonder ORIGIN: QR-links volgen het adres waarop het beheer is geopend', async () => {
  const items = await (await j('/api/admin/qr', { headers: { cookie: session } })).json();
  assert.ok(items[0].url.startsWith(`${base}/?q=`), items[0].url);
  const proxied = await (await j('/api/admin/qr', { headers: { cookie: session, 'X-Forwarded-Host': 'map.example.com', 'X-Forwarded-Proto': 'https' } })).json();
  assert.ok(proxied[0].url.startsWith('https://map.example.com/?q='), proxied[0].url);
});

test('met een passkey gelden weer de strengere regels voor een wachtwoordsessie', async () => {
  const fake = { id: 'test-passkey', publicKey: 'x', counter: 0, transports: [], name: 'Test', createdAt: new Date().toISOString() };
  store.db().passkeys.push(fake);
  try {
    assert.equal((await status(session)).fullSession, false);
    assert.equal((await put('/api/admin/password', { password: 'nieuw-wachtwoord-1', currentPassword: PW }, { cookie: session })).status, 403);
    assert.equal((await post('/api/auth/register/options', { name: 'Nog een' }, { cookie: session })).status, 403);
  } finally {
    store.db().passkeys = store.db().passkeys.filter((p) => p !== fake);
  }
});
