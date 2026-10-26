#!/usr/bin/env node
'use strict';
// Maakt release notes (Markdown, Nederlands) voor een tag, uit de pull requests die sinds de vorige tag zijn gemerged.
//   node tools/release-notes.js <tag> [<vorige-tag>] [--fixture bestand.json]
// Met GITHUB_TOKEN en GITHUB_REPOSITORY (owner/repo) in de omgeving; --fixture leest PR-gegevens uit een bestand (voor tests).
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const SECTIONS = [
  ['feature', '✨ Nieuwe functies en verbeteringen'],
  ['fix', '🐞 Opgeloste problemen'],
  ['docs', '📚 Documentatie'],
  ['other', '🔧 Overig'],
];
const FIX_WORDS = /(fix|herstel|repareer|crash|bug|probleem|opgelost)/i;

// Indeling op branchnaam (fix/…, docs/…) of titel.
function classify(pr) {
  const ref = String(pr.head || '');
  if (/^(fix|hotfix|bugfix)\//i.test(ref) || FIX_WORDS.test(pr.title || '')) return 'fix';
  if (/^docs?\//i.test(ref)) return 'docs';
  return 'feature';
}

const clean = (t) => String(t)
  .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/`([^`]*)`/g, '$1')
  .replace(/\*\*([^*]+)\*\*/g, '$1')
  .replace(/\s+/g, ' ')
  .trim();

// De eerste paar opsommingen uit het kopje "Wijziging(en)" / "Oplossing" / "Summary" van de PR-beschrijving.
function summarize(body, max = 3) {
  const lines = String(body || '').replace(/\r/g, '').split('\n');
  const start = lines.findIndex((l) => /^##\s+(wijziging|oplossing|wat|summary)/i.test(l));
  if (start < 0) return [];
  const out = [];
  for (const l of lines.slice(start + 1)) {
    if (/^##\s/.test(l)) break;
    const m = /^[-*]\s+(.*)$/.exec(l); // alleen opsommingen op het hoogste niveau
    if (!m) continue;
    const t = clean(m[1]);
    if (t) out.push(t.length > 170 ? `${t.slice(0, 167).trimEnd()}…` : t);
    if (out.length >= max) break;
  }
  return out;
}

function render({ tag, prev, repo, prs, commits = [] }) {
  const groups = Object.fromEntries(SECTIONS.map(([k]) => [k, []]));
  for (const pr of prs) groups[pr.kind || classify(pr)].push(pr);
  if (!prs.length) for (const c of commits) groups.other.push({ title: c, number: null, summary: [] });
  const out = [`Release **${tag}** van Doorbell Map – interactieve wijkkaart.`, ''];
  let any = false;
  for (const [key, title] of SECTIONS) {
    const list = groups[key];
    if (!list.length) continue;
    any = true;
    out.push(`### ${title}`, '');
    for (const pr of list) {
      const ref = pr.number ? ` (#${pr.number})` : '';
      out.push(`- **${clean(pr.title)}**${ref}`);
      for (const s of pr.summary || summarize(pr.body)) out.push(`  - ${s}`);
    }
    out.push('');
  }
  if (!any) out.push('Geen functionele wijzigingen in deze release.', '');
  out.push('### Installeren', '', '```sh', `docker pull ghcr.io/${(repo || 'helmerznl/doorbell-map').toLowerCase()}:${tag}`, '```', '',
    'Zie [Zelf deployen met Docker](https://github.com/' + (repo || 'helmerzNL/doorbell-map') + '#zelf-deployen-met-docker) voor `docker-compose.yml` en `.env`.');
  if (prev && repo) out.push('', `**Volledige wijzigingen:** https://github.com/${repo}/compare/${prev}...${tag}`);
  return out.join('\n') + '\n';
}

const vkey = (t) => t.replace(/^v/, '').split('.').map(Number);
function previousTag(tag) {
  const tags = execFileSync('git', ['tag', '-l', 'v*'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const cmp = (a, b) => { const x = vkey(a), y = vkey(b); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
  const lower = tags.filter((t) => cmp(t, tag) < 0).sort(cmp);
  return lower[lower.length - 1] || null;
}

async function gh(path, token) {
  const res = await fetch(`https://api.github.com${path}`, { headers: { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}), 'User-Agent': 'doorbell-map-release-notes' } });
  if (!res.ok) throw new Error(`GitHub ${path}: ${res.status}`);
  return res.json();
}

// Pull requests die in deze tag-reeks zijn gemerged: "Merge pull request #N …" of "… (#N)" (squash).
function prNumbers(commits) {
  const nums = [];
  for (const c of commits) {
    const first = String((c.commit && c.commit.message) || '').split('\n')[0];
    const m = /^Merge pull request #(\d+)/.exec(first) || /\(#(\d+)\)\s*$/.exec(first);
    if (m && !nums.includes(Number(m[1]))) nums.push(Number(m[1]));
  }
  return nums.sort((a, b) => a - b);
}

async function main(argv) {
  const args = argv.slice(2);
  const fi = args.indexOf('--fixture');
  let fixture = null;
  if (fi >= 0) { fixture = JSON.parse(fs.readFileSync(args[fi + 1], 'utf8')); args.splice(fi, 2); }
  const [tag, prevArg] = args;
  if (!tag) { console.error('Gebruik: node tools/release-notes.js <tag> [<vorige-tag>] [--fixture bestand]'); process.exit(1); }
  const repo = process.env.GITHUB_REPOSITORY || 'helmerzNL/doorbell-map';
  const prev = prevArg || previousTag(tag);
  if (fixture) { process.stdout.write(render({ tag, prev, repo, prs: fixture.prs || [], commits: fixture.commits || [] })); return; }
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  let commits = [];
  if (prev) commits = (await gh(`/repos/${repo}/compare/${prev}...${tag}?per_page=100`, token)).commits || [];
  const prs = [];
  for (const n of prNumbers(commits)) {
    const p = await gh(`/repos/${repo}/pulls/${n}`, token);
    prs.push({ number: n, title: p.title, body: p.body || '', head: p.head && p.head.ref });
  }
  const loose = commits.map((c) => String(c.commit.message).split('\n')[0]).filter((m) => !/^Merge /.test(m));
  process.stdout.write(render({ tag, prev, repo, prs, commits: loose.slice(0, 15) }));
}

module.exports = { classify, summarize, render, prNumbers, previousTag, clean };
if (require.main === module) main(process.argv).catch((e) => { console.error(e.message); process.exit(1); });
