'use strict';
// Community: bezoekers die hun positie willen delen, zien elkaar live op de kaart (alleen als de beheerder
// de functie aanzet). Posities staan alleen in het geheugen en verlopen vanzelf (TTL); er wordt niets bewaard.
// Wederkerig: wie zijn eigen positie doorgeeft, krijgt de posities van de anderen terug; wie niet deelt, ziet niets.
const crypto = require('node:crypto');
const express = require('express');
const store = require('./store');

const TTL_MS = 45 * 1000; // zonder nieuwe positie verdwijnt een deelnemer hierna van de kaart
const MIN_GAP_MS = 2000; // een apparaat mag niet vaker dan dit een nieuwe positie doorgeven
const MAX_PARTICIPANTS = 500;
const MAX_PER_IP = 20; // een gezin of buurthuis deelt één IP; dit stopt alleen het volspammen met verzonnen id's
const MAX_ACC = 5000; // m
const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

const SALT = crypto.randomBytes(16); // alleen voor de korte, niet terug te rekenen sleutel per deelnemer
const people = new Map(); // apparaat-id -> { lat, lng, acc, t, k, ip }

const enabled = () => store.db().settings?.communityEnabled === true;
const keyOf = (id) => crypto.createHash('sha256').update(SALT).update(id).digest('hex').slice(0, 10);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);

function sweep(now = Date.now()) {
  for (const [id, p] of people) if (now - p.t > TTL_MS) people.delete(id);
}
const clear = () => people.clear();

// Positie van de anderen, zonder apparaat-id: alleen coördinaten, nauwkeurigheid, leeftijd en een korte sleutel.
function listOthers(exceptId, now = Date.now()) {
  sweep(now);
  const out = [];
  for (const [id, p] of people) {
    if (id !== exceptId) out.push({ k: p.k, lat: p.lat, lng: p.lng, acc: p.acc, age: Math.round((now - p.t) / 1000) });
  }
  return out;
}

const router = express.Router();
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (!enabled()) return res.status(403).json({ error: 'De community staat uit', off: true });
  next();
});

router.post('/ping', (req, res) => {
  const { id } = req.body || {};
  const lat = num(req.body?.lat), lng = num(req.body?.lng);
  const acc = Math.min(Math.max(Math.round(num(req.body?.acc) || 0), 0), MAX_ACC);
  if (typeof id !== 'string' || !ID_RE.test(id)) return res.status(400).json({ error: 'Ongeldig apparaat-id' });
  if (!(lat >= -90 && lat <= 90) || !(lng >= -180 && lng <= 180)) return res.status(400).json({ error: 'Ongeldige positie' });
  const now = Date.now();
  sweep(now);
  const prev = people.get(id);
  if (!prev) {
    if (people.size >= MAX_PARTICIPANTS) return res.status(429).json({ error: 'De community zit vol, probeer het straks opnieuw' });
    let mine = 0;
    for (const p of people.values()) if (p.ip === req.ip) mine++;
    if (mine >= MAX_PER_IP) return res.status(429).json({ error: 'Te veel apparaten vanaf dit netwerk' });
  }
  if (!prev || now - prev.t >= MIN_GAP_MS) people.set(id, { lat, lng, acc, t: now, k: prev?.k || keyOf(id), ip: req.ip });
  res.json({ peers: listOthers(id, now) });
});

router.post('/leave', (req, res) => {
  const id = req.body?.id;
  if (typeof id === 'string') people.delete(id);
  res.json({ ok: true });
});

// Beheer: alle deelnemers (ook zonder zelf te delen). Staat de functie uit, dan is de lijst leeg.
function adminList(req, res) {
  res.set('Cache-Control', 'no-store');
  const on = enabled();
  res.json({ enabled: on, participants: on ? listOthers(null) : [] });
}

module.exports = { router, adminList, clear, enabled, TTL_MS, MAX_PARTICIPANTS };
