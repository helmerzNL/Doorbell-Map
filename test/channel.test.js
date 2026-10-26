const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');

// Start de app in een eigen proces met of zonder DOORBELL_MAP_TAG (of het oude SINTMAARTEN_TAG) en lees kanaal, pagina en manifest.
function probe(tag, varName = 'DOORBELL_MAP_TAG') {
  const script = `
    const app = require('./server/index.js');
    const s = app.listen(0, async () => {
      const b = 'http://localhost:' + s.address().port;
      const out = {
        version: await (await fetch(b + '/api/version')).json(),
        page: await (await fetch(b + '/')).text(),
        manifest: await (await fetch(b + '/manifest.webmanifest')).json(),
        beheer: await (await fetch(b + '/beheer.webmanifest')).json(),
      };
      console.log(JSON.stringify(out));
      s.close(); process.exit(0);
    });`;
  const env = { ...process.env, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'sm-ch-')), SETUP_TOKEN: 'test-setup-token-123', SESSION_SECRET: 'test-session-secret-123', APP_VERSION: '1.2.3' };
  delete env.SINTMAARTEN_TAG; delete env.DOORBELL_MAP_TAG;
  if (tag !== undefined) env[varName] = tag;
  return JSON.parse(execFileSync('node', ['-e', script], { cwd: root, env }).toString().trim().split('\n').pop());
}

test('stabiele build toont geen beta-label', () => {
  for (const tag of [undefined, 'latest', 'v1.0.21']) {
    const r = probe(tag);
    assert.equal(r.version.channel, 'stable', String(tag));
    assert.match(r.page, /<meta name="sm-channel" content="stable">/);
    assert.ok(!/beta/i.test(r.manifest.name + r.manifest.short_name + r.beheer.name));
  }
});

test('beta-build meldt het kanaal en zet beta in pagina en manifesten', () => {
  const r = probe('beta');
  assert.equal(r.version.channel, 'beta');
  assert.match(r.page, /<meta name="sm-channel" content="beta">/);
  assert.match(r.manifest.name, /\(beta\)$/);
  assert.match(r.manifest.short_name, /β$/);
  assert.ok(r.manifest.short_name.length <= 12);
  assert.match(r.beheer.name, /\(beta\)$/);
});

test('het oude SINTMAARTEN_TAG blijft het beta-kanaal bepalen (bestaande NAS-setups)', () => {
  assert.equal(probe('beta', 'SINTMAARTEN_TAG').version.channel, 'beta');
  assert.equal(probe('latest', 'SINTMAARTEN_TAG').version.channel, 'stable');
});

test('een image dat op de beta-branch is gebouwd (versie x.y.z-beta) is ook beta', () => {
  const script = "process.env.APP_VERSION='1.2.3-beta'; console.log(require('./server/version').channel)";
  const env = { ...process.env }; delete env.SINTMAARTEN_TAG; delete env.DOORBELL_MAP_TAG;
  assert.equal(execFileSync('node', ['-e', script], { cwd: root, env }).toString().trim(), 'beta');
});

test('docker-compose.yml en .env.example gebruiken dezelfde DOORBELL_MAP_TAG', () => {
  const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
  const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  assert.match(compose, /image: ghcr\.io\/helmerznl\/doorbell-map:\$\{DOORBELL_MAP_TAG:-\$\{SINTMAARTEN_TAG:-latest\}\}/);
  assert.match(compose, /DOORBELL_MAP_TAG: "\$\{DOORBELL_MAP_TAG:-\$\{SINTMAARTEN_TAG:-latest\}\}"/);
  assert.match(envExample, /^DOORBELL_MAP_TAG=latest$/m);
  assert.ok(!/APP_IMAGE/.test(compose + envExample));
});
