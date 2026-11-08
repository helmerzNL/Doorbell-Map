'use strict';
// Geüploade afbeeldingen (logo, klein logo, favicon): soort herkennen aan de inhoud, afmetingen lezen en
// de instelling opbouwen. Gedeeld door de uploadroutes (index.js) en het terugzetten van een backup (backups.js).
const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');

// De drie afbeeldingen uit het beheer: sleutel in de instellingen, voorvoegsel van de bestandsnaam, route en naam
// (die laatste staat in de reden van een backup).
const LOGOS = [
  { key: 'logo', prefix: 'logo', route: '/logo', name: 'Logo' },
  { key: 'logoSmall', prefix: 'logo-small', route: '/logo-small', name: 'Klein logo' },
  { key: 'favicon', prefix: 'favicon', route: '/favicon', name: 'Favicon' },
];
const MAX_IMAGE = 5 * 1024 * 1024; // per afbeelding, bij uploaden en in een backup

const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

const IMAGE_TYPES = [
  { ext: 'png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'webp', test: (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' },
];

// Extensie (png, jpg, webp) volgens de eerste bytes; null als het geen toegestane afbeelding is.
function detect(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length || buf.length > MAX_IMAGE) return null;
  return IMAGE_TYPES.find((t) => t.test(buf))?.ext || null;
}

// Afmetingen uit de kop van de afbeelding (PNG, JPEG, WebP); null als ze niet te lezen zijn.
function imageSize(b, ext) {
  try {
    if (ext === 'png') return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    if (ext === 'jpg') {
      for (let i = 2; i + 9 < b.length && b[i] === 0xff;) {
        const m = b[i + 1];
        if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
        i += 2 + b.readUInt16BE(i + 2);
      }
      return null;
    }
    const kind = b.subarray(12, 16).toString();
    if (kind === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (kind === 'VP8L') return { width: 1 + (((b[22] & 0x3f) << 8) | b[21]), height: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)) };
    if (kind === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  } catch { /* afgekapt bestand: geen afmetingen */ }
  return null;
}

// De instelling voor een opgeslagen afbeelding; het favicon krijgt ook soort en afmetingen (voor het manifest).
const setting = (key, file, buf, ext) => ({ file, url: `/uploads/${file}`, ...(key === 'favicon' ? { type: IMAGE_MIME[ext], ...imageSize(buf, ext) } : {}) });

// Het bestand van een (vervangen of verwijderde) afbeelding weghalen.
const remove = (s) => {
  if (s?.file) fs.rm(path.join(store.uploadDir, path.basename(s.file)), () => {});
};

module.exports = { LOGOS, MAX_IMAGE, detect, imageSize, setting, remove };
