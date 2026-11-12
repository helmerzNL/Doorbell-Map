'use strict';
// Site sluiten: de beheerder plant een moment (meestal na afloop van een evenement). Vanaf dat moment krijgen bezoekers
// een bedankscherm in plaats van de voorpagina, en geeft de server de kaart (de huizen) niet meer vrij. Het beheer blijft
// gewoon werken. Er is geen timer: elke aanvraag kijkt zelf of het moment verstreken is.
const store = require('./store');
const { defaultLang, customText, trParagraphs, LANGS } = require('./lang');

// Het bedankscherm: de tekst is in het beheer aan te passen (per taal). Alinea's staan gescheiden door een lege regel.
// De standaardtekst noemt geen evenement bij naam, zodat hij voor elke keer klopt.
const DEFAULT_TEXT = 'Het evenement is afgelopen en de kaart is gesloten. Hartelijk dank voor het meedoen en voor jullie hulp.\n\nTot de volgende keer!';

const settings = () => store.db().settings || {};
// Het ingestelde moment in milliseconden, of null als sluiten niet gepland is (uit, of zonder geldige datum).
const closeMs = () => {
  const s = settings();
  if (s.siteCloseOn !== true) return null;
  const t = Date.parse(s.siteCloseAt || '');
  return Number.isFinite(t) ? t : null;
};
const closed = (now = Date.now()) => { const t = closeMs(); return t !== null && now >= t; };

// Eigen tekst van die taal, anders de standaardtekst in die taal.
const text = (l = defaultLang()) => customText('closedText', l) || trParagraphs(l, DEFAULT_TEXT);
const defaults = () => Object.fromEntries(LANGS.map((l) => [l, trParagraphs(l, DEFAULT_TEXT)]));

// Voor het beheer: de instelling zoals bewaard en of de site nu gesloten is.
const info = () => ({ on: settings().siteCloseOn === true, at: settings().siteCloseAt || null, closed: closed() });

module.exports = { closed, text, defaults, info, DEFAULT_TEXT };
