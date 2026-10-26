'use strict';
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const { normalizeHouse } = require('./houses');

const dbFile = path.join(config.dataDir, 'db.json');
const uploadDir = path.join(config.dataDir, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const empty = () => ({ userId: null, passkeys: [], password: null, view: null, pdfView: null, houses: [], residents: [], proposals: [], blocked: [], houseSecrets: {}, messages: [], push: null, settings: { intro: '', logo: null, appName: '', appShortName: '', siteTitle: '', residentsEnabled: true, residentsAppOnly: false, labels: { green: 'Groen', red: 'Rood', none: 'Niet gemarkeerd' } }, version: 2 });
let db = empty();
if (fs.existsSync(dbFile)) {
  db = { ...empty(), ...JSON.parse(fs.readFileSync(dbFile, 'utf8')) };
  if (db.version !== 2) {
    // Oude versie met geüploade afbeelding: huizen waren relatief aan het plaatje en zijn niet bruikbaar op de kaart.
    db.houses = [];
    delete db.map;
    db.version = 2;
  }
  db.houses = (db.houses || []).map(normalizeHouse); // label -> huisnummer, straat toevoegen
}

function save() {
  const tmp = `${dbFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, dbFile);
}

module.exports = { db: () => db, save, uploadDir };
