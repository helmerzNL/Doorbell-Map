'use strict';
const crypto = require('node:crypto');

const STATUSES = ['green', 'red', 'none'];
const clean = (s, n) => String(s ?? '').trim().slice(0, n);

// Eén huis in de vorm {id, street, number, note, status, points}.
// Oudere gegevens hadden één veld "label" (meestal het huisnummer): dat wordt het huisnummer.
function normalizeHouse(h) {
  const number = 'number' in h ? clean(h.number, 20) : clean(h.label, 20);
  return {
    id: typeof h.id === 'string' && /^[\w-]{1,40}$/.test(h.id) ? h.id : crypto.randomBytes(6).toString('hex'),
    street: clean(h.street, 100),
    number,
    note: clean(h.note, 500),
    status: STATUSES.includes(h.status) ? h.status : 'none',
    points: h.points,
  };
}

const DEFAULT_LABELS = { green: 'Groen', red: 'Rood', none: 'Niet gemarkeerd' };

// Namen van de statussen (door de beheerder aan te passen); ontbrekende of lege namen vallen terug op de standaard.
// Met lang: de namen in die taal (een lege vertaling valt terug op de Nederlandse naam).
function statusLabels(settings, lang) {
  const l = settings?.labels || {};
  const tl = (lang && lang !== 'nl' && settings?.translations?.[lang]?.labels) || {};
  const out = {};
  for (const k of STATUSES) out[k] = clean(tl[k], 24) || clean(l[k], 24) || DEFAULT_LABELS[k];
  return out;
}

// Welke statusregels de overlay op de beheerkaart toont (standaard alle drie).
function statsShow(settings) {
  const s = settings?.statsShow || {};
  return Object.fromEntries(STATUSES.map((k) => [k, s[k] !== false]));
}

module.exports = { normalizeHouse, STATUSES, statusLabels, statsShow, DEFAULT_LABELS };
