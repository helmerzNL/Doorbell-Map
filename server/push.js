'use strict';
// Web Push naar de apparaten van de beheerder. De VAPID-sleutels worden bij de eerste keer gemaakt en in de database bewaard.
const crypto = require('node:crypto');
const webpush = require('web-push');
const store = require('./store');
const config = require('./config');

let sender = webpush; // te vervangen in tests

function state() {
  const db = store.db();
  if (!db.push) {
    const k = webpush.generateVAPIDKeys();
    db.push = { publicKey: k.publicKey, privateKey: k.privateKey, devices: [] };
    store.save();
  }
  if (!Array.isArray(db.push.devices)) db.push.devices = [];
  return db.push;
}

// De afzender (VAPID-subject) moet een https-adres of mailto zijn. Zonder ORIGIN nemen we het https-adres waarop het laatste apparaat
// zich aanmeldde: meldingen werken in de browser alleen via https (of op localhost), dus dat adres is er bijna altijd.
const subject = () => {
  if (config.origin?.startsWith('https://')) return config.origin;
  const seen = store.db().push?.origin;
  if (seen) return seen;
  return `mailto:beheer@${config.rpID || 'localhost'}`;
};
const publicKey = () => state().publicKey;
const devices = () => state().devices.map(({ id, label, createdAt }) => ({ id, label, createdAt }));

function validSubscription(s) {
  try {
    const u = new URL(s?.endpoint);
    return u.protocol === 'https:' && typeof s.keys?.p256dh === 'string' && typeof s.keys?.auth === 'string'
      && s.endpoint.length < 1000 && s.keys.p256dh.length < 200 && s.keys.auth.length < 100;
  } catch { return false; }
}

function addDevice(subscription, label, pageOrigin) {
  if (!validSubscription(subscription)) throw new Error('Ongeldige pushregistratie');
  const p = state();
  if (typeof pageOrigin === 'string' && pageOrigin.startsWith('https://')) p.origin = pageOrigin;
  const existing = p.devices.find((d) => d.subscription.endpoint === subscription.endpoint);
  if (existing) { existing.subscription = subscription; if (label) existing.label = String(label).slice(0, 80); store.save(); return existing.id; }
  if (p.devices.length >= 20) throw new Error('Maximaal 20 apparaten voor meldingen');
  const device = { id: crypto.randomBytes(6).toString('hex'), label: String(label || 'Apparaat').slice(0, 80), createdAt: new Date().toISOString(), subscription };
  p.devices.push(device);
  store.save();
  return device.id;
}

function removeDevice(id) {
  const p = state();
  const before = p.devices.length;
  p.devices = p.devices.filter((d) => d.id !== id);
  store.save();
  return before !== p.devices.length;
}

function removeByEndpoint(endpoint) {
  const p = state();
  p.devices = p.devices.filter((d) => d.subscription.endpoint !== endpoint);
  store.save();
}

async function send(payload) {
  const p = state();
  if (!p.devices.length) return { sent: 0, removed: 0 };
  const options = { vapidDetails: { subject: subject(), publicKey: p.publicKey, privateKey: p.privateKey }, TTL: 3600, urgency: 'normal' };
  const dead = [];
  let sent = 0;
  await Promise.all(p.devices.map(async (d) => {
    try {
      await sender.sendNotification(d.subscription, JSON.stringify(payload), options);
      sent++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) dead.push(d.id); // registratie is verlopen
      else console.error('Push mislukt:', err.statusCode || '', err.message);
    }
  }));
  if (dead.length) { p.devices = p.devices.filter((d) => !dead.includes(d.id)); store.save(); }
  return { sent, removed: dead.length };
}

module.exports = { publicKey, devices, addDevice, removeDevice, removeByEndpoint, send, _setSender: (s) => { sender = s || webpush; } };
