'use strict';
// Herstel als niemand meer kan inloggen: verwijdert alle gebruikers, passkeys, wachtwoorden, MFA en uitnodigingen.
// De kaart, edities, backups en instellingen blijven staan. Daarna toont /beheer weer de installatie-wizard
// (met de installatiecode, SETUP_TOKEN). Draai dit alleen terwijl de server gestopt is, anders overschrijft die het.
//   docker compose stop doorbell-map
//   docker compose run --rm doorbell-map node server/reset-login.js
//   docker compose up -d
const store = require('./store');
const audit = require('./audit');

const db = store.db();
const counts = { users: (db.users || []).length, passkeys: (db.passkeys || []).length, invites: (db.invites || []).length };
db.users = [];
db.passkeys = [];
db.invites = [];
delete db.password; // van vóór de gebruikers
delete db.userId;
store.save();
audit.site(audit.SYSTEM, 'users', 'Alle inloggegevens verwijderd met het herstelcommando', { counts });
console.log(`Inloggegevens verwijderd: ${counts.users} gebruiker(s), ${counts.passkeys} passkey(s), ${counts.invites} uitnodiging(en).`);
console.log('Start de container weer en open /beheer: de installatie-wizard vraagt om de installatiecode (SETUP_TOKEN).');
