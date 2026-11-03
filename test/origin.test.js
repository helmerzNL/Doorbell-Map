// Met ORIGIN ingesteld staat het adres vast, ongeacht de host van de aanvraag. Eigen bestand, omdat ORIGIN bij het laden telt.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-origin-'));
process.env.SETUP_TOKEN = 'test-setup-token-123';
process.env.SESSION_SECRET = 'test-session-secret-123';
process.env.ORIGIN = 'https://map.example.com/';
delete process.env.RP_ID;
const app = require('../server/index.js');

let server, base;
test.before(() => new Promise((r) => { server = app.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); }); }));
test.after(() => server.close());

const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('met ORIGIN telt alleen precies dat adres', async () => {
  assert.equal((await post('/api/auth/logout', {}, { Origin: 'https://map.example.com' })).status, 200);
  assert.equal((await post('/api/auth/logout', {}, { Origin: base })).status, 403);
  assert.equal((await post('/api/auth/logout', {}, { Origin: 'http://map.example.com' })).status, 403);
});

test('met ORIGIN horen passkeys bij dat domein en is de cookie Secure', async () => {
  const r = await post('/api/auth/register/options', { setupToken: 'test-setup-token-123' }, { Origin: 'https://map.example.com' });
  assert.equal((await r.json()).options.rp.id, 'map.example.com');
  const setup = await post('/api/auth/setup-password', { setupToken: 'test-setup-token-123', password: 'een-lang-wachtwoord' }, { Origin: 'https://map.example.com' });
  assert.equal(setup.status, 200);
  assert.match(setup.headers.get('set-cookie'), /;\s*Secure/i);
});
