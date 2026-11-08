const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { zipSync, strToU8 } = require('fflate');

// Een datamap met 55 backups (en een ander bestand): bij het starten blijven de nieuwste 50 staan.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-bkp-'));
process.env.DATA_DIR = DATA;
delete process.env.MAX_BACKUPS;
const BK = path.join(DATA, 'backups');
fs.mkdirSync(BK, { recursive: true });
const idOf = (i) => `${1700000000000 + i}-abcdef`;
const name = (id) => `sint_maarten-backup-${id}.zip`;
for (let i = 0; i < 55; i++) {
  const doc = { id: idOf(i), createdAt: new Date(1700000000000 + i).toISOString(), reason: 'Test', ok: true, houses: [], view: null, texts: { intro: '' } };
  fs.writeFileSync(path.join(BK, name(idOf(i))), zipSync({ 'backup.json': strToU8(JSON.stringify(doc)) }));
}
fs.writeFileSync(path.join(BK, 'notitie.txt'), 'van de beheerder');

const backups = require('../server/backups');
const zips = () => fs.readdirSync(BK).filter((f) => f.endsWith('.zip')).sort();

test('de nieuwste 50 backups blijven bewaard; oudere worden bij het starten en bij elke nieuwe backup opgeruimd', () => {
  assert.equal(backups.MAX_BACKUPS, 50);
  let files = zips();
  assert.equal(files.length, 50);
  assert.equal(files[0], name(idOf(5))); // de vijf oudste zijn weg
  assert.equal(files[49], name(idOf(54)));
  assert.ok(fs.existsSync(path.join(BK, 'notitie.txt'))); // wat geen backup is, blijft staan

  const id = backups.create('Nieuw', true, { force: true });
  files = zips();
  assert.equal(files.length, 50);
  assert.equal(files[0], name(idOf(6)));
  assert.ok(files.includes(name(id)));
  assert.equal(backups.list().length, 50);
});
