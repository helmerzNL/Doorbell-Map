'use strict';
// Taal van de site (instelling in het beheer) en vertaling van teksten die de server zelf verstuurt (pushmeldingen).
const store = require('./store');
const { makeTranslator } = require('../public/js/lang-core');
const dicts = require('../public/js/lang-en');

const LANGS = ['nl', 'en'];
const translators = Object.fromEntries(Object.entries(dicts).map(([k, d]) => [k, makeTranslator(d)]));

const multilingual = () => store.db().settings?.multilingual === true;
const defaultLang = () => { const l = store.db().settings?.defaultLang; return LANGS.includes(l) ? l : 'nl'; };
// Vertaalt een Nederlandse tekst naar de standaardtaal van de site (voor meldingen aan de beheerder).
const tr = (s) => (translators[defaultLang()] ? translators[defaultLang()].tr(s) : s);
// Sjabloon met variabelen, bijvoorbeeld t('{n} berichten', { n: 3 }).
const t = (tpl, vars) => {
  const x = translators[defaultLang()];
  return x ? x.t(tpl, vars) : tpl.replace(/\{(\w+)\}/g, (m, n) => (vars && n in vars ? String(vars[n]) : m));
};

const trIn = (l, s) => (translators[l] ? translators[l].tr(s) : s);

// Teksten per taal: Nederlands staat in de gewone instellingen, andere talen in settings.translations[taal].
// Een lege vertaling valt terug op de Nederlandse tekst.
const TEXT_FIELDS = ['siteTitle', 'appName', 'appShortName', 'intro', 'residentInfo', 'qrShareText', 'communityTitle', 'communityText'];
const translations = (l) => store.db().settings?.translations?.[l] || {};
const text = (field, l = defaultLang()) => {
  const own = l === 'nl' ? '' : translations(l)[field];
  if (typeof own === 'string' && own.trim()) return own;
  const base = store.db().settings?.[field];
  return typeof base === 'string' ? base : '';
};

// Oudere versie: losse velden introEn en residentInfoEn -> translations.en
function migrate() {
  const s = store.db().settings;
  if (!s || (!('introEn' in s) && !('residentInfoEn' in s))) return;
  s.translations = s.translations || {};
  s.translations.en = s.translations.en || {};
  if (s.introEn && !s.translations.en.intro) s.translations.en.intro = s.introEn;
  if (s.residentInfoEn && !s.translations.en.residentInfo) s.translations.en.residentInfo = s.residentInfoEn;
  delete s.introEn; delete s.residentInfoEn;
  store.save();
}

module.exports = { LANGS, TEXT_FIELDS, multilingual, defaultLang, tr, trIn, t, translations, text, migrate };
