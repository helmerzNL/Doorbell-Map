'use strict';
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const { normalizeHouse } = require('./houses');

const dbFile = path.join(config.dataDir, 'db.json');
const uploadDir = path.join(config.dataDir, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const empty = () => ({ users: [], passkeys: [], invites: [], view: null, pdfView: null, houses: [], residents: [], proposals: [], blocked: [], houseSecrets: {}, messages: [], push: null, settings: { intro: '', logo: null, appName: '', appShortName: '', siteTitle: '', residentsEnabled: true, residentsAppOnly: false, labels: { green: 'Groen', red: 'Rood', none: 'Niet gemarkeerd' } }, version: 2 });
let db = empty();
const found = fs.existsSync(dbFile); // stonden er bij het starten al gegevens in de datamap?
if (found) {
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

// Startmelding voor de containerlog: welke datamap de server gebruikt en of daar al gegevens stonden.
// Een lege datamap na een update komt bijna altijd door een andere gekoppelde hostmap (DATA_PATH), niet door verlies.
function startupReport() {
  if (found) return `Gegevens: ${dbFile} (${db.houses.length} huizen, ${db.passkeys.length} passkey(s))`;
  return [
    `Gegevens: geen ${dbFile} gevonden. De server begint met een lege kaart en vraagt om de installatiecode.`,
    `Had je al gegevens? Dan is er een andere (lege) map op ${config.dataDir} gekoppeld, bijvoorbeeld na het verplaatsen van de stackmap.`,
    'Rond de installatie dan niet af, maar zet DATA_PATH in .env op het absolute pad van de map met db.json (docker inspect toont welke map nu gekoppeld is).',
  ].join('\n');
}

module.exports = { db: () => db, save, uploadDir, startupReport };
