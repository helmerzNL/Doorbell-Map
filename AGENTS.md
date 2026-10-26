# AGENTS.md — werkafspraken voor AI-agents

Dit is het **canonieke** bestand met de werkafspraken voor elke AI-agent in deze repository (Claude Code, Copilot, Codex, ...).
`CLAUDE.md` verwijst hiernaartoe en herhaalt niets. Waar dit bestand en een clientbestand verschillen, wint dit bestand.

Het project volgt de richtlijnen van [App-Guidance](https://github.com/Flux76HQ/App-Guidance)
(`shared/guidelines/project-baseline.md`).

## Over deze repository

Doorbell Map (`doorbell-map`, voorheen Sint Maarten) is een evenement-neutrale interactieve wijkkaart (Node 22 + Express, JSON-opslag, passkeys), uitgerold als
Docker-container. Zie [README.md](README.md). Wijzigingen zijn bijna altijd kleine functies of fixes in `server/`, `public/` of
de tooling; de app heeft Nederlandse bron-teksten en een Engelse vertaling (`public/js/lang-en.js`).

## Git workflow

- **Pull requests gaan naar `beta`, nooit rechtstreeks naar `main`.** `beta` is de integratiebranch (stel de Default branch op
  GitHub in op `beta`). `main` is de stabiele lijn en ontvangt alleen een **promotie-PR van `beta`**, wanneer de eigenaar daarom
  vraagt. De check `only-from-beta` (`.github/workflows/pr-target.yml`) laat elke andere PR naar `main` falen; de eigenaar maakt
  hem verplicht en verbiedt directe pushes naar `main` in de branch protection (dat kan niet vanuit de code).
- Werk op een `feature/…`-, `fix/…`- of `docs/…`-branch vanaf `beta`. Controleer vóór een vervolgcommit op een eerdere branch of de
  PR al gemerged is; zo ja: nieuwe branch vanaf `beta` en een nieuwe PR.
- Elke push naar `beta` bouwt het image `ghcr.io/helmerznl/doorbell-map:beta` (zonder versietag, release of `:latest`); een push naar
  `main` bouwt `:latest`, zet de versietag en maakt de GitHub Release (`.github/workflows/docker.yml`).
- **Promotie van `beta` naar `main`** volgt de [promotion-runbook](https://github.com/Flux76HQ/App-Guidance/blob/main/shared/guidelines/promotion-runbook.md).
  Hier:
  - Alleen **op verzoek van de eigenaar**. De agent bereidt voor (checks, release notes, PR); de eigenaar (Helmer) merget. De agent
    merget een promotie niet zonder uitdrukkelijke opdracht.
  - Titel: `Release vX.Y.Z: promotie van beta naar productie`. Body in de volgorde van de runbook: wat dit is · volgorde · wat
    verandert voor gebruikers · risico's (met *Deployment files* en *Limits* uitgeschreven) · gecontroleerd · na het mergen.
  - Mergen met een **merge commit**, nooit squash (anders loopt `beta` achter op `main`).
  - Release notes: automatisch uit de gemergde PR's (`tools/release-notes.js`); omvat de promotie meerdere beta-versies, schrijf dan
    `docs/releases/<tag>.md` (met "Sinds de vorige stabiele versie" en "Goed om te weten bij het bijwerken") en merge die als gewone
    PR naar `beta` **vóór** de promotie. `tools/publish-release.sh` gebruikt dat bestand als het bestaat.
  - Het volledige testcommando is `npm test`. Een falende test hoort met naam in de PR, niet weggelaten.
  - Versiemodel: de pipeline zet de versie (tag via `tools/next-version.sh`); PR's wijzigen `VERSION` niet en `main` hoeft niet terug
    in `beta` gemerged te worden.
  - Controleer na het mergen dat release `vX.Y.Z` bestaat (geen prerelease, *latest*) en dat de images `latest` en `X.Y.Z` gebouwd zijn.
    Meld daarna wat er live staat en wat de beheerder moet doen (`docker compose pull && docker compose up -d`, pagina verversen).
- Een PR volgt `.github/PULL_REQUEST_TEMPLATE.md`; issues volgen de formulieren in `.github/ISSUE_TEMPLATE/`.
- Commit- en PR-teksten zijn Nederlands.

## Configuratie en gegevens

- Nooit `.env` of geheimen committen; alleen `.env.example` staat in git.
- De gegevens staan in één host-map, `DATA_PATH` (zie `docker-compose.yml` en README), niet in een Docker-volume.
- Wijzigingen aan `docker-compose.yml` of `.env.example` beschrijf je in de PR onder *Deployment files* als instructie voor de beheerder.
