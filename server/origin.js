'use strict';
// Het adres van de app. Met ORIGIN (en eventueel RP_ID) staat het vast. Zonder ORIGIN volgt de app het adres waarop hij wordt
// geopend, zodat hij ook zonder eigen domein werkt, bijvoorbeeld op http://homeassistant.local:9888 met inloggen via een wachtwoord.
// Achter een reverse proxy tellen X-Forwarded-Proto en X-Forwarded-Host mee ('trust proxy' staat aan in index.js).
const config = require('./config');

const hostOf = (value) => {
  try { return new URL(value).host; } catch { return null; }
};

// Het adres van deze aanvraag: schema en host zoals de server ze ziet.
function requestOrigin(req) {
  if (config.origin) return config.origin;
  return `${req.protocol}://${req.host || 'localhost'}`;
}

// Het adres van de pagina die de aanvraag doet. Een browser stuurt bij een POST altijd de Origin-header mee; die is betrouwbaarder
// dan het schema dat een proxy wel of niet doorgeeft. Hij telt alleen als de host gelijk is aan die van de aanvraag.
function pageOrigin(req) {
  if (config.origin) return config.origin;
  const o = req.headers.origin;
  if (o && o !== 'null' && hostOf(o) === req.host) return o;
  return requestOrigin(req);
}

// Het domein waaraan passkeys gebonden zijn.
function rpID(req) {
  if (config.rpID) return config.rpID;
  try { return new URL(pageOrigin(req)).hostname; } catch { return 'localhost'; }
}

// Cookies met Secure alleen als de pagina via https loopt; anders zou de browser ze op http weigeren.
const secureCookie = (req) => pageOrigin(req).startsWith('https://');

// Komt een wijzigende aanvraag van onze eigen pagina? Met ORIGIN moet de Origin-header precies gelijk zijn; zonder ORIGIN moet de host
// gelijk zijn aan die van de aanvraag (het schema niet, omdat niet elke proxy X-Forwarded-Proto doorgeeft).
function isOwnOrigin(req, o) {
  if (config.origin) return o === config.origin;
  return hostOf(o) !== null && hostOf(o) === req.host;
}

module.exports = { requestOrigin, pageOrigin, rpID, secureCookie, isOwnOrigin };
