// Inloggen en accounts: installatie met passkey of wachtwoord, tweestapsverificatie, bevestigen, uitnodigingen en
// gebruikersbeheer. Elke test begint vanaf een lege installatie (fresh()).
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const OTPAuth = require('otpauth');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-acc-'));
process.env.SETUP_TOKEN = 'test-setup-token-123';
process.env.SESSION_SECRET = 'test-session-secret-123';
// Een vast adres, zodat de nep-authenticator weet voor welk adres hij tekent. Zonder ORIGIN: zie origin-request.test.js.
process.env.ORIGIN = 'https://sintmaarten.flux76.app';
const app = require('../server/index.js');
const store = require('../server/store');
const users = require('../server/users');
const config = require('../server/config');
const { passkeySupport } = require('../server/account');
const { FakeAuthenticator } = require('./fake-authenticator');

let server, base;
test.before(() => new Promise((r) => { server = app.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); }); }));
test.after(() => server.close());

// Elke test een eigen IP (X-Forwarded-For), zodat de limiter van de ene test de andere niet raakt.
let ipN = 0, ip = '';
function fresh() {
  const d = store.db();
  d.users = []; d.passkeys = []; d.invites = [];
  ip = `10.0.0.${++ipN}`;
}
const call = async (method, p, body, cookie, extra = {}) => {
  const r = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, ...(cookie ? { cookie } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = r.headers.get('set-cookie');
  return { status: r.status, body: await r.json().catch(() => ({})), cookie: set && !set.startsWith('sm_session=;') ? set.split(';')[0] : null };
};
const post = (p, body, cookie, extra) => call('POST', p, body ?? {}, cookie, extra);
const get = (p, cookie, extra) => call('GET', p, undefined, cookie, extra);

const PW = 'een-lang-wachtwoord';
async function setupPassword(username = 'Helmer', password = PW) {
  const r = await post('/api/auth/setup/password', { setupToken: 'test-setup-token-123', username, password });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.cookie);
  return r.cookie;
}
async function setupPasskey(username = 'Helmer') {
  const fa = new FakeAuthenticator({ origin: config.origin, rpID: config.rpID });
  const o = await post('/api/auth/register/options', { setupToken: 'test-setup-token-123', username, name: 'Telefoon' });
  assert.equal(o.status, 200, JSON.stringify(o.body));
  const v = await post('/api/auth/register/verify', { challengeId: o.body.challengeId, response: fa.register(o.body.options) });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  return { fa, cookie: v.cookie };
}
async function passkeyLogin(fa) {
  const o = await post('/api/auth/login/options');
  const v = await post('/api/auth/login/verify', { challengeId: o.body.challengeId, response: fa.assert(o.body.options) });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  return v.cookie;
}
const status = async (cookie) => (await get('/api/auth/status', cookie)).body;
const totp = (secret) => new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) });
async function enableMfa(cookie, password = PW) {
  const s = await post('/api/admin/mfa/start', { confirm: { password } }, cookie);
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.match(s.body.uri, /^otpauth:\/\/totp\//);
  const c = await post('/api/admin/mfa/confirm', { challengeId: s.body.challengeId, code: totp(s.body.secret).generate() }, cookie);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  return { secret: s.body.secret, codes: c.body.recoveryCodes, cookie: c.cookie };
}
// Een code voor de volgende tijdstap (de huidige is al gebruikt bij het aanzetten; een stap werkt maar één keer).
const nextCode = (secret) => totp(secret).generate({ timestamp: Date.now() + 30000 });

test('installatie met wachtwoord: installatiecode, wachtwoordregels en daarna niet nog eens', async () => {
  fresh();
  const st = await status();
  assert.deepEqual([st.configured, st.loggedIn, st.passwordEnabled, st.passkeysEnabled], [false, false, false, false]);
  assert.equal(typeof st.passkey.available, 'boolean');
  const setup = (body) => post('/api/auth/setup/password', { setupToken: 'test-setup-token-123', username: 'Helmer', password: PW, ...body });
  assert.equal((await setup({ setupToken: 'fout' })).status, 403);
  assert.equal((await setup({ password: 'kort' })).status, 400);
  assert.equal((await setup({ password: 'aaaaaaaaaaaa' })).status, 400); // minder dan 4 verschillende tekens
  assert.equal((await setup({ username: 'Helmer', password: 'xxhelmerxx-123' })).status, 400); // bevat de naam
  assert.equal((await setup({ username: '' , password: PW })).status, 200); // lege naam: "beheerder"
  assert.equal(users.byId('owner').username, 'beheerder');
  assert.equal((await setup({})).status, 403); // al ingesteld
  assert.equal((await post('/api/auth/register/options', { setupToken: 'test-setup-token-123' })).status, 401);
});

test('inloggen met gebruikersnaam en wachtwoord; de naam is niet hoofdlettergevoelig', async () => {
  fresh();
  const cookie = await setupPassword('Helmer');
  const st = await status(cookie);
  assert.deepEqual([st.configured, st.loggedIn, st.method, st.user.owner, st.user.strong, st.user.password], [true, true, 'pw', true, true, true]);
  assert.equal((await post('/api/auth/password-login', { username: 'helmer', password: 'fout-wachtwoord' })).status, 401);
  assert.equal((await post('/api/auth/password-login', { username: 'iemand', password: PW })).status, 401);
  const ok = await post('/api/auth/password-login', { username: ' HELMER ', password: PW });
  assert.equal(ok.status, 200);
  assert.ok(ok.cookie);
  assert.equal((await get('/api/admin/account', ok.cookie)).body.username, 'Helmer');
});

test('MFA: aanzetten met QR-geheim, inloggen in twee stappen, geen replay, herstelcodes één keer', async () => {
  fresh();
  const first = await setupPassword();
  assert.equal((await post('/api/admin/mfa/confirm', { challengeId: 'x', code: '123456' }, first)).status, 400);
  assert.equal((await post('/api/admin/mfa/start', {}, first)).status, 400); // aanzetten vraagt het wachtwoord
  assert.equal((await post('/api/admin/mfa/start', { confirm: { password: 'fout-fout-fout' } }, first)).status, 400);
  const s = await post('/api/admin/mfa/start', { confirm: { password: PW } }, first);
  assert.equal((await post('/api/admin/mfa/confirm', { challengeId: s.body.challengeId, code: '000000' }, first)).status, 400);
  const { secret, codes, cookie } = await enableMfa(first);
  assert.equal(codes.length, 8);
  assert.match(codes[0], /^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/);
  // het geheim staat versleuteld in db.json, de herstelcodes alleen als hash
  const raw = fs.readFileSync(path.join(process.env.DATA_DIR, 'db.json'), 'utf8');
  assert.ok(!raw.includes(secret) && !raw.includes(codes[0]) && !raw.includes(codes[0].replace(/-/g, '')));
  assert.ok(fs.existsSync(path.join(process.env.DATA_DIR, 'secret.key')));
  // MFA aanzetten meldt de andere sessies af; dit apparaat kreeg een nieuw cookie
  assert.equal((await get('/api/admin/account', first)).status, 401);
  assert.equal((await get('/api/admin/account', cookie)).body.mfa, true);
  // opnieuw instellen (ander geheim, nieuwe herstelcodes) kan niet zolang MFA aan staat, ook niet met het wachtwoord
  assert.equal((await post('/api/admin/mfa/start', { confirm: { password: PW, code: nextCode(secret) } }, cookie)).status, 400);

  const step1 = await post('/api/auth/password-login', { username: 'Helmer', password: PW });
  assert.equal(step1.status, 200);
  assert.equal(step1.body.mfaRequired, true);
  assert.equal(step1.cookie, null); // het ticket is geen sessie
  assert.equal((await post('/api/auth/mfa-login', { ticket: step1.body.ticket, code: '000000' })).status, 401);
  const code = nextCode(secret);
  const ok = await post('/api/auth/mfa-login', { ticket: step1.body.ticket, code });
  assert.equal(ok.status, 200);
  assert.ok(ok.cookie);
  assert.equal((await post('/api/auth/mfa-login', { ticket: step1.body.ticket, code })).status, 401); // ticket gebruikt
  const again = await post('/api/auth/password-login', { username: 'Helmer', password: PW });
  assert.equal((await post('/api/auth/mfa-login', { ticket: again.body.ticket, code })).status, 401); // dezelfde code nog eens
  // herstelcode (hoofdletters/streepjes maken niet uit), maar maar één keer
  const rc = codes[3].toLowerCase().replace(/-/g, ' ');
  assert.equal((await post('/api/auth/mfa-login', { ticket: again.body.ticket, code: rc })).status, 200);
  const third = await post('/api/auth/password-login', { username: 'Helmer', password: PW });
  assert.equal((await post('/api/auth/mfa-login', { ticket: third.body.ticket, code: rc })).status, 401);
  assert.equal((await get('/api/admin/account', ok.cookie)).body.recoveryLeft, 7);
});

test('MFA-ticket vervalt na te veel foute codes', async () => {
  fresh();
  const { secret } = await enableMfa(await setupPassword());
  const t = (await post('/api/auth/password-login', { username: 'Helmer', password: PW })).body.ticket;
  for (let i = 0; i < 5; i++) assert.equal((await post('/api/auth/mfa-login', { ticket: t, code: '000000' })).status, 401);
  assert.equal((await post('/api/auth/mfa-login', { ticket: t, code: nextCode(secret) })).status, 401);
});

test('bevestigen zonder passkey: met het huidige wachtwoord (en de MFA-code als die aan staat)', async () => {
  fresh();
  let cookie = await setupPassword();
  const o = await post('/api/admin/confirm/options', {}, cookie);
  assert.deepEqual(o.body, { method: 'password', mfa: false });
  // wachtwoord wijzigen: zonder of met fout bewijs geweigerd
  assert.equal((await call('PUT', '/api/admin/password', { password: 'nieuw-wachtwoord-1' }, cookie)).status, 400);
  assert.equal((await call('PUT', '/api/admin/password', { password: 'nieuw-wachtwoord-1', confirm: { password: 'fout-fout-fout' } }, cookie)).status, 400);
  const ch = await call('PUT', '/api/admin/password', { password: 'nieuw-wachtwoord-1', confirm: { password: PW } }, cookie);
  assert.equal(ch.status, 200);
  assert.equal((await get('/api/admin/account', cookie)).status, 401); // oude sessie afgemeld
  cookie = ch.cookie;
  assert.equal((await post('/api/auth/password-login', { username: 'Helmer', password: 'nieuw-wachtwoord-1' })).status, 200);
  // met MFA: wachtwoord én code; backups verwijderen gebruikt dezelfde bevestiging
  const m = await enableMfa(cookie, 'nieuw-wachtwoord-1');
  cookie = m.cookie;
  assert.deepEqual((await post('/api/admin/confirm/options', {}, cookie)).body, { method: 'password', mfa: true });
  assert.equal((await post('/api/admin/backups/delete', { ids: ['1700000000000-abcdef'], confirm: { password: 'nieuw-wachtwoord-1' } }, cookie)).status, 400);
  const del = await post('/api/admin/backups/delete', { ids: ['1700000000000-abcdef'], confirm: { password: 'nieuw-wachtwoord-1', code: nextCode(m.secret) } }, cookie);
  assert.equal(del.status, 200);
  // MFA uitzetten met een herstelcode
  const off = await post('/api/admin/mfa/disable', { confirm: { password: 'nieuw-wachtwoord-1', code: m.codes[0] } }, cookie);
  assert.equal(off.status, 200);
  assert.equal((await get('/api/admin/account', off.cookie)).body.mfa, false);
  // zonder passkey kan het wachtwoord niet weg
  assert.equal((await post('/api/admin/password/remove', { confirm: { password: 'nieuw-wachtwoord-1' } }, off.cookie)).status, 400);
});

test('installatie met passkey; inloggen met de passkey kiest de juiste gebruiker', async () => {
  fresh();
  const { fa, cookie } = await setupPasskey('Helmer');
  const st = await status(cookie);
  assert.deepEqual([st.method, st.user.username, st.user.passkeys, st.user.password, st.passkeysEnabled], ['pk', 'Helmer', 1, false, true]);
  assert.equal(store.db().passkeys[0].userId, 'owner');
  const login = await passkeyLogin(fa);
  assert.equal((await status(login)).user.id, 'owner');
  // een andere origin wordt geweigerd
  const o = await post('/api/auth/login/options');
  assert.equal((await post('/api/auth/login/verify', { challengeId: o.body.challengeId, response: fa.assert(o.body.options, { origin: 'https://evil.example' }) })).status, 400);
  // de laatste passkey kan alleen weg als er een wachtwoord is
  const id = store.db().passkeys[0].id;
  assert.equal((await call('DELETE', `/api/admin/passkeys/${encodeURIComponent(id)}`, undefined, cookie)).status, 400);
});

test('met een passkey: bevestigen met die passkey; een wachtwoordsessie mag de inlog dan niet wijzigen', async () => {
  fresh();
  const { fa, cookie } = await setupPasskey();
  const opts = await post('/api/admin/confirm/options', {}, cookie);
  assert.equal(opts.body.method, 'passkey');
  const set = await call('PUT', '/api/admin/password', { password: PW, challengeId: opts.body.challengeId, response: fa.assert(opts.body.options) }, cookie);
  assert.equal(set.status, 200, JSON.stringify(set.body));
  const pw = await post('/api/auth/password-login', { username: 'Helmer', password: PW });
  assert.equal(pw.status, 200);
  const st = await status(pw.cookie);
  assert.deepEqual([st.method, st.user.strong], ['pw', false]);
  assert.equal((await get('/api/admin/passkeys', pw.cookie)).status, 200);
  assert.equal((await post('/api/admin/mfa/start', {}, pw.cookie)).status, 403);
  assert.equal((await call('PUT', '/api/admin/password', { password: 'iets-anders-123' }, pw.cookie)).status, 403);
  assert.equal((await post('/api/auth/register/options', {}, pw.cookie)).status, 403);
  // met een wachtwoord mag de laatste passkey weg; daarna is de wachtwoordsessie wel sterk
  const id = store.db().passkeys[0].id;
  assert.equal((await call('DELETE', `/api/admin/passkeys/${encodeURIComponent(id)}`, undefined, set.cookie)).status, 200);
  assert.equal((await status(pw.cookie)).user.strong, true);
});

test('een extra passkey toevoegen voor jezelf (vanuit een wachtwoordsessie met bevestiging); een passkey van een ander kan niet bevestigen', async () => {
  fresh();
  const cookie = await setupPassword();
  const fa = new FakeAuthenticator({ origin: config.origin, rpID: config.rpID });
  assert.equal((await post('/api/auth/register/options', { name: 'Laptop' }, cookie)).status, 400); // zonder wachtwoord
  const o = await post('/api/auth/register/options', { name: 'Laptop', confirm: { password: PW } }, cookie);
  assert.equal(o.status, 200);
  // de wachtwoordbeheerder toont de naam van de site/app met de gebruikersnaam; de gebruikersnaam zelf verandert niet
  assert.equal(o.body.options.rp.name, 'Onze wijk');
  assert.equal(o.body.options.user.name, 'Onze wijk (Helmer)');
  assert.equal(o.body.options.user.displayName, 'Onze wijk (Helmer)');
  // met een naam van de app, en daarboven een eigen naam bij een passkey
  store.db().settings.appName = 'Wijkapp';
  const withApp = await post('/api/auth/register/options', { name: 'Laptop', confirm: { password: PW } }, cookie);
  assert.deepEqual([withApp.body.options.rp.name, withApp.body.options.user.name], ['Wijkapp', 'Wijkapp (Helmer)']);
  store.db().settings.passkeyName = 'Sint Maarten Hoogland';
  const custom = await post('/api/auth/register/options', { name: 'Laptop', confirm: { password: PW } }, cookie);
  assert.deepEqual([custom.body.options.rp.name, custom.body.options.user.name], ['Sint Maarten Hoogland', 'Sint Maarten Hoogland (Helmer)']);
  assert.equal((await status(cookie)).passkeyDetails, null); // nog geen passkey: niets bij te werken
  const v = await post('/api/auth/register/verify', { challengeId: custom.body.challengeId, response: fa.register(custom.body.options) }, cookie);
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.deepEqual(store.db().passkeys.map((p) => [p.name, p.userId]), [['Laptop', 'owner']]);
  assert.equal(users.byId('owner').username, 'Helmer');
  // voor de Signal API: zo werkt de browser ook een bestaande passkey bij met de huidige naam
  assert.deepEqual((await status(cookie)).passkeyDetails, { rpId: config.rpID, userId: users.byId('owner').webauthnId, name: 'Sint Maarten Hoogland (Helmer)', displayName: 'Sint Maarten Hoogland (Helmer)' });
  assert.equal((await status()).passkeyDetails, null);
  delete store.db().settings.passkeyName; store.db().settings.appName = '';
  // een vreemde passkey (andere gebruiker) bij een bevestiging
  store.db().users.push({ ...users.byId('owner'), id: 'ander', username: 'Ander', password: null, webauthnId: 'YQ' });
  const other = new FakeAuthenticator({ origin: config.origin, rpID: config.rpID });
  const reg = { id: other.id, publicKey: 'x', counter: 0, transports: [], name: 'x', createdAt: '', userId: 'ander' };
  store.db().passkeys.push(reg);
  const c = await post('/api/admin/confirm/options', {}, cookie);
  assert.equal((await post('/api/admin/backups/delete', { ids: ['1700000000000-abcdef'], challengeId: c.body.challengeId, response: other.assert(c.body.options) }, cookie)).status, 400);
});

test('uitnodigen: link eenmalig, gast kiest zelf naam en wachtwoord, eigenaar weet niets', async () => {
  fresh();
  const owner = await setupPassword('Helmer');
  const inv = await post('/api/admin/users/invites', { username: 'Anna' }, owner);
  assert.equal(inv.status, 200);
  assert.match(inv.body.url, new RegExp(`^${config.origin}/beheer#invite=[A-Za-z0-9_-]{43}$`));
  assert.ok(!JSON.stringify(store.db()).includes(inv.body.token)); // alleen de hash staat in de database
  // de naam is gereserveerd zolang de uitnodiging openstaat
  assert.equal((await post('/api/admin/users/invites', { username: 'anna' }, owner)).status, 409);
  // informatie voor de gast (token in een header), en hetzelfde antwoord voor elke ongeldige token
  const info = await get('/api/invites/info', null, { 'X-Invite-Token': inv.body.token });
  assert.equal(info.status, 200);
  assert.deepEqual([info.body.kind, info.body.username, info.body.invitedBy], ['new', 'Anna', 'Helmer']);
  for (const t of ['', 'x', 'A'.repeat(43)]) {
    const r = await get('/api/invites/info', null, { 'X-Invite-Token': t });
    assert.deepEqual([r.status, r.body.error], [404, users.INVALID_INVITE]);
  }
  // naam- en wachtwoordregels; niets half aangemaakt
  assert.equal((await post('/api/invites/password', { token: inv.body.token, username: 'Helmer', password: PW })).status, 409);
  assert.equal((await post('/api/invites/password', { token: inv.body.token, username: 'Anna', password: 'kort' })).status, 400);
  assert.equal(users.all().length, 1);
  const done = await post('/api/invites/password', { token: inv.body.token, username: 'Anna B', password: 'annas-eigen-wachtwoord' });
  assert.equal(done.status, 200);
  assert.ok(done.cookie);
  const st = await status(done.cookie);
  assert.deepEqual([st.user.username, st.user.owner], ['Anna B', false]);
  // eenmalig
  assert.equal((await get('/api/invites/info', null, { 'X-Invite-Token': inv.body.token })).status, 404);
  assert.equal((await post('/api/invites/password', { token: inv.body.token, username: 'Piet', password: 'nog-een-wachtwoord' })).status, 404);
  // een gewone gebruiker beheert geen gebruikers (de server dwingt dat af), maar wel de kaart
  for (const [m, p] of [['GET', '/api/admin/users'], ['POST', '/api/admin/users/invites'], ['POST', '/api/admin/users/owner/reset'], ['DELETE', '/api/admin/users/owner'], ['DELETE', '/api/admin/users/invites/x']]) {
    assert.equal((await call(m, p, m === 'GET' ? undefined : {}, done.cookie)).status, 403, `${m} ${p}`);
  }
  assert.equal((await get('/api/admin/backups', done.cookie)).status, 200);
  // de eigenaar ziet hoe iedereen inlogt
  const list = (await get('/api/admin/users', owner)).body;
  assert.deepEqual(list.users.map((u) => [u.username, u.owner, u.password, u.passkeys]), [['Helmer', true, true, 0], ['Anna B', false, true, 0]]);
  assert.deepEqual(list.invites, []);
  // ieder logt in met het eigen wachtwoord; een wachtwoordwijziging van Anna meldt de eigenaar niet af
  const anna = await post('/api/auth/password-login', { username: 'anna b', password: 'annas-eigen-wachtwoord' });
  assert.equal((await status(anna.cookie)).user.username, 'Anna B');
  assert.equal((await call('PUT', '/api/admin/password', { password: 'nieuw-van-anna-1', confirm: { password: 'annas-eigen-wachtwoord' } }, anna.cookie)).status, 200);
  assert.equal((await get('/api/admin/account', anna.cookie)).status, 401);
  assert.equal((await get('/api/admin/account', owner)).status, 200);
});

test('uitnodiging intrekken; verlopen links werken niet; limiet op open uitnodigingen', async () => {
  fresh();
  const owner = await setupPassword();
  const a = await post('/api/admin/users/invites', {}, owner);
  assert.equal((await call('DELETE', `/api/admin/users/invites/${a.body.id}`, undefined, owner)).status, 200);
  assert.equal((await get('/api/invites/info', null, { 'X-Invite-Token': a.body.token })).status, 404);
  const b = await post('/api/admin/users/invites', {}, owner);
  store.db().invites.find((i) => i.id === b.body.id).expiresAt = new Date(Date.now() - 1000).toISOString();
  assert.equal((await get('/api/invites/info', null, { 'X-Invite-Token': b.body.token })).status, 404);
  // openstaande uitnodigingen tellen mee als toekomstige gebruikers (1 eigenaar + 49 uitnodigingen = 50)
  for (let i = 1; i < users.MAX_USERS; i++) assert.equal((await post('/api/admin/users/invites', {}, owner)).status, 200);
  const full = await post('/api/admin/users/invites', {}, owner);
  assert.deepEqual([full.status, full.body.error], [409, 'Het maximale aantal gebruikers is bereikt']);
});

test('uitnodiging met een passkey: bezette naam vóór de passkey geweigerd, daarna ingelogd als de nieuwe gebruiker', async () => {
  fresh();
  const owner = await setupPassword('Helmer');
  const inv = await post('/api/admin/users/invites', {}, owner);
  assert.equal((await post('/api/auth/register/options', { invite: 'ongeldig', username: 'Anna' })).status, 404);
  assert.equal((await post('/api/auth/register/options', { invite: inv.body.token, username: 'helmer' })).status, 409);
  const fa = new FakeAuthenticator({ origin: config.origin, rpID: config.rpID });
  const o = await post('/api/auth/register/options', { invite: inv.body.token, username: 'Anna', name: 'Telefoon' });
  assert.equal(o.status, 200);
  const v = await post('/api/auth/register/verify', { challengeId: o.body.challengeId, response: fa.register(o.body.options) });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  const st = await status(v.cookie);
  assert.deepEqual([st.method, st.user.username, st.user.owner, st.user.passkeys], ['pk', 'Anna', false, 1]);
  assert.equal((await get('/api/invites/info', null, { 'X-Invite-Token': inv.body.token })).status, 404);
  assert.equal((await status(await passkeyLogin(fa))).user.username, 'Anna');
});

test('reset: oude inlog blijft tot de nieuwe is ingesteld, dan vervangen (ook MFA) en afgemeld', async () => {
  fresh();
  const owner = await setupPassword('Helmer');
  const inv = await post('/api/admin/users/invites', {}, owner);
  const anna = await post('/api/invites/password', { token: inv.body.token, username: 'Anna', password: 'eigen-geheim-wachtwoord' });
  const m = await enableMfa(anna.cookie, 'eigen-geheim-wachtwoord');
  const annaId = (await status(m.cookie)).user.id;
  assert.equal((await post(`/api/admin/users/owner/reset`, {}, owner)).status, 404); // de eigenaar niet
  const r1 = await post(`/api/admin/users/${annaId}/reset`, { username: 'Gekaapt' }, owner);
  const r2 = await post(`/api/admin/users/${annaId}/reset`, {}, owner); // vervangt de vorige reset-link
  assert.equal((await get('/api/invites/info', null, { 'X-Invite-Token': r1.body.token })).status, 404);
  const info = await get('/api/invites/info', null, { 'X-Invite-Token': r2.body.token });
  assert.deepEqual([info.body.kind, info.body.username], ['reset', 'Anna']);
  // link maken of openen verandert niets
  assert.equal((await get('/api/admin/account', m.cookie)).status, 200);
  assert.equal((await post('/api/auth/password-login', { username: 'Anna', password: 'eigen-geheim-wachtwoord' })).body.mfaRequired, true);
  const done = await post('/api/invites/password', { token: r2.body.token, username: 'Gekaapt', password: 'weer-binnen-123' });
  assert.equal(done.status, 200);
  const st = await status(done.cookie);
  assert.deepEqual([st.user.username, st.user.mfa], ['Anna', false]); // naam blijft, MFA is weg
  assert.equal((await get('/api/admin/account', m.cookie)).status, 401); // oude sessie afgemeld
  assert.equal((await post('/api/auth/password-login', { username: 'Anna', password: 'eigen-geheim-wachtwoord' })).status, 401);
  assert.equal((await post('/api/auth/password-login', { username: 'Anna', password: 'weer-binnen-123' })).body.ok, true);
});

test('gebruiker verwijderen beëindigt de sessie; de eigenaar kan niet weg', async () => {
  fresh();
  const owner = await setupPassword('Helmer');
  const inv = await post('/api/admin/users/invites', {}, owner);
  const anna = await post('/api/invites/password', { token: inv.body.token, username: 'Anna', password: 'eigen-geheim-wachtwoord' });
  const id = (await status(anna.cookie)).user.id;
  store.db().passkeys.push({ id: 'pk-anna', userId: id });
  assert.equal((await call('DELETE', '/api/admin/users/owner', undefined, owner)).status, 400);
  assert.equal((await call('DELETE', `/api/admin/users/${id}`, undefined, owner)).status, 200);
  assert.equal((await get('/api/admin/account', anna.cookie)).status, 401);
  assert.ok(!store.db().passkeys.some((p) => p.userId === id));
  assert.equal((await call('DELETE', `/api/admin/users/${id}`, undefined, owner)).status, 404);
});

test('gebruikersnaam wijzigen: uniek, niet hoofdlettergevoelig', async () => {
  fresh();
  const owner = await setupPassword('Helmer');
  const inv = await post('/api/admin/users/invites', {}, owner);
  await post('/api/invites/password', { token: inv.body.token, username: 'Anna', password: 'eigen-geheim-wachtwoord' });
  assert.equal((await call('PUT', '/api/admin/account/username', { username: 'ANNA' }, owner)).status, 409);
  assert.equal((await call('PUT', '/api/admin/account/username', { username: '  Helmer   Z ' }, owner)).body.username, 'Helmer Z');
  assert.equal((await post('/api/auth/password-login', { username: 'helmer z', password: PW })).status, 200);
});

test('oude sessiecookies (van vóór de gebruikers) gelden alleen voor de gemigreerde eigenaar, tot de epoch verandert', async () => {
  fresh();
  await setupPassword();
  const crypto = require('node:crypto');
  const exp = String(Date.now() + 3600e3);
  const old = `sm_session=${exp}.pw.${crypto.createHmac('sha256', 'test-session-secret-123').update(`${exp}.pw`).digest('base64url')}`;
  assert.equal((await status(old)).loggedIn, false); // een via de wizard gemaakte eigenaar begint met een willekeurige epoch
  users.byId('owner').epoch = 0; // zoals na de migratie van één beheerder
  assert.equal((await status(old)).user.id, 'owner');
  const ch = await call('PUT', '/api/admin/password', { password: 'nieuw-wachtwoord-1', confirm: { password: PW } }, old);
  assert.equal(ch.status, 200);
  assert.equal((await status(old)).loggedIn, false);
});

test('na het herstelcommando en een nieuwe installatie werken oude cookies van de eigenaar niet meer', async () => {
  fresh();
  const before = await setupPassword('Helmer');
  assert.equal((await status(before)).loggedIn, true);
  // zoals server/reset-login.js: alle inloggegevens weg
  const d = store.db();
  d.users = []; d.passkeys = []; d.invites = [];
  assert.equal((await status(before)).loggedIn, false);
  const after = await setupPassword('Helmer');
  assert.equal((await status(after)).loggedIn, true);
  assert.equal((await status(before)).loggedIn, false);
});

test('een ontbrekende secret.key wordt bij ontsleutelen niet stilletjes opnieuw gemaakt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-key-'));
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ version: 2, houses: [], passkeys: [], invites: [],
    users: [{ id: 'owner', username: 'Helmer', epoch: 0, password: { salt: 's', hash: 'h' }, mfa: { secret: 'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA', lastCounter: 0 }, recovery: [] }] }));
  const out = execFileSync(process.execPath, ['-e', "const u = require('./server/users'); process.stdout.write(String(u.verifyMfa(u.byId('owner'), '123456')))"], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8',
  });
  assert.equal(out, 'null');
  assert.ok(!fs.existsSync(path.join(dir, 'secret.key')));
});

test('migratie: een wachtwoord uit een oudere versie (na terugrollen) gaat naar de eigenaar', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-mig2-'));
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ version: 2, houses: [], invites: [], password: { salt: 's', hash: 'oud' },
    users: [{ id: 'owner', username: 'Helmer', epoch: 3, password: null, mfa: null, recovery: [] }], passkeys: [{ id: 'a', userId: 'owner' }, { id: 'b' }] }));
  const out = execFileSync(process.execPath, ['-e', "require('./server/users').migrate(); process.stdout.write(require('fs').readFileSync(process.env.DATA_DIR + '/db.json', 'utf8'))"], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8',
  });
  const db = JSON.parse(out);
  assert.equal(db.users[0].password.hash, 'oud');
  assert.deepEqual(db.passkeys.map((p) => p.userId), ['owner', 'owner']);
  assert.ok(!('password' in db));
});

test('migratie: één beheerder met wachtwoord en passkeys wordt de eigenaar', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-mig-'));
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({
    version: 2, userId: 'aGFuZGxl', password: { salt: 's', hash: 'h', N: 2, r: 8, p: 1 },
    passkeys: [{ id: 'a', createdAt: '2025-10-01T00:00:00.000Z' }, { id: 'b', createdAt: '2024-10-01T00:00:00.000Z' }], houses: [],
  }));
  const out = execFileSync(process.execPath, ['-e', "require('./server/users').migrate(); process.stdout.write(require('fs').readFileSync(process.env.DATA_DIR + '/db.json', 'utf8'))"], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8',
  });
  const db = JSON.parse(out);
  assert.equal(db.users.length, 1);
  const [o] = db.users;
  assert.deepEqual([o.id, o.username, o.webauthnId, o.password.hash, o.createdAt, o.epoch], ['owner', 'beheerder', 'aGFuZGxl', 'h', '2024-10-01T00:00:00.000Z', 0]);
  assert.deepEqual(db.passkeys.map((p) => p.userId), ['owner', 'owner']);
  assert.ok(!('password' in db) && !('userId' in db));
  assert.deepEqual(db.invites, []);
});

test('kan een passkey hier werken? (domeinnaam en HTTPS)', () => {
  const cases = [
    ['https://kaart.example.nl', 'kaart.example.nl', true],
    ['https://xn--bcher-kva.example', 'xn--bcher-kva.example', true],
    ['http://localhost:9888', 'localhost', true],
    ['http://kaart.example.nl', 'kaart.example.nl', false],
    ['https://192.168.1.20', '192.168.1.20', false],
    ['https://[::1]', '[::1]', false],
    ['https://nas', 'nas', false],
    ['https://nas.local', 'nas.local', false],
    ['https://kaart.home.arpa', 'kaart.home.arpa', false],
    ['https://kaart.lan', 'kaart.lan', false],
  ];
  for (const [origin, rp, ok] of cases) {
    const r = passkeySupport(origin, rp);
    assert.equal(r.available, ok, `${origin}`);
    assert.equal(!!r.reason, !ok, `${origin}`);
  }
});

test('herstelcommando uit de README: alle inloggegevens weg, de kaart blijft, de wizard komt terug', () => {
  // het commando staat in beide README's en wordt hier echt gedraaid (zonder docker: het deel na de containernaam)
  for (const f of ['README.md', 'README.en.md']) {
    const readme = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.match(readme, /docker compose run --rm doorbell-map node server\/reset-login\.js/, f);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-reset-'));
  const sq = [[52.02, 5.16], [52.02, 5.161], [52.021, 5.161]];
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({
    version: 2, houses: [{ id: 'a', number: '1', street: 'X', status: 'green', points: sq }], settings: { siteTitle: 'Mijn wijk' },
    users: [{ id: 'owner', username: 'Helmer', password: { salt: 's', hash: 'h' }, mfa: { secret: 'x' } }, { id: 'u2', username: 'Anna' }],
    passkeys: [{ id: 'pk', userId: 'owner' }], invites: [{ id: 'i', tokenHash: 'h' }],
  }));
  const out = execFileSync(process.execPath, ['server/reset-login.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' });
  assert.match(out, /2 gebruiker\(s\), 1 passkey\(s\), 1 uitnodiging\(en\)/);
  const db = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
  assert.deepEqual([db.users, db.passkeys, db.invites], [[], [], []]);
  assert.equal(db.houses.length, 1);
  assert.equal(db.settings.siteTitle, 'Mijn wijk');
  // en de server ziet een installatie die opnieuw ingesteld moet worden
  const configured = execFileSync(process.execPath, ['-e', "process.stdout.write(String(require('./server/users').configured()))"], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' });
  assert.equal(configured, 'false');
});

test('dezelfde passkey (credential-id) kan geen tweede keer worden geregistreerd', async () => {
  fresh();
  const { fa } = await setupPasskey('Helmer');
  const owner = await passkeyLogin(fa);
  const inv = await post('/api/admin/users/invites', {}, owner);
  const o = await post('/api/auth/register/options', { invite: inv.body.token, username: 'Anna' });
  const v = await post('/api/auth/register/verify', { challengeId: o.body.challengeId, response: fa.register(o.body.options) });
  assert.equal(v.status, 409);
  assert.equal(users.all().length, 1); // geen half aangemaakte gebruiker
  assert.equal((await get('/api/invites/info', null, { 'X-Invite-Token': inv.body.token })).status, 200); // de link werkt nog
});
