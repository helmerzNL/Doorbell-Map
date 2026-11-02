const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// De startmelding in een eigen proces, zodat de datamap per geval anders kan zijn.
const report = (dataDir) => execFileSync(process.execPath, ['-e', "process.stdout.write(require('./server/store').startupReport())"], {
  cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8',
});

test('startmelding: lege datamap wijst op DATA_PATH', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-store-'));
  const r = report(dir);
  assert.match(r, /geen .*db\.json gevonden/);
  assert.match(r, /DATA_PATH/);
  assert.ok(r.includes(dir));
  assert.ok(!fs.existsSync(path.join(dir, 'db.json'))); // alleen melden, niets aanmaken
});

test('startmelding: bestaande gegevens met aantallen', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-store-'));
  const sq = [[52.02, 5.16], [52.02, 5.161], [52.021, 5.161]];
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ version: 2, passkeys: [{ id: 'pk' }], houses: [{ id: 'a', points: sq }, { id: 'b', points: sq }] }));
  const r = report(dir);
  assert.match(r, /^Gegevens: .*db\.json \(2 huizen, 1 passkey\(s\)\)$/);
});
