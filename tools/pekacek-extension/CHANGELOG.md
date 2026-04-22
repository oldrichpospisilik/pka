# Pekáček Extension — Changelog

Semver: `MAJOR.MINOR.PATCH`.
- **MAJOR** — rozbíjející změny (manifest schema, breaking API)
- **MINOR** — nové feature, zpětně kompatibilní
- **PATCH** — bugfixy, drobné úpravy

## 2.1.0 — 2026-04-22

### Nové
- **Smart auto-scroll** — respektuje uživatelskou scroll pozici, tlačítko "↓ Nové zprávy" když přibývá text mimo viewport
- **Reset tlačítko (↻)** v hlavičce — smaže chat, zapomene session, znovu nabídne přečtení
- **Kontextové "Přemýšlím" hlášky** — různé podle akce (Shrnuju / Hledám slabiny / Kreslím diagram...) + rotace během čekání + cyklování výrazů obličeje
- **Copy tlačítko (⧉)** u Pekáčkovy odpovědi — kopíruje raw markdown, ✓ feedback
- **Toggle sidebar** přes `setPanelBehavior` — klik na ikonu otevírá i zavírá sidepanel
- **Větší toolbar ikona** — vyplňuje skoro celý čtverec, tlustší tahy, čitelnější
- **Sloučení s Bookmarks MCP bridge** — jedna extension místo dvou
- **Auto-start bridge** ve `start.sh` s duplicate detection
- `/forget` endpoint v bridge pro reset session

### Opravy
- Retry mechanismus pro prázdný tab title
- Fallback na hostname URL když title chybí
- `<all_urls>` host_permissions — extension funguje na všech stránkách
- Content script injection s lepším error logging
- Session ID jako UUID (dřív custom formát)
- Close handler — poslouchá na `res` objektu místo `req` (fix ghost disconnects)

### Odstraněno
- Popup (klik na ikonu rovnou otevírá sidepanel)
- Úvodní "Ahoj" zpráva (Pekáček se rovnou ptá na článek)

## 2.0.0 — 2026-04-22

Iniciální release reading companion sidebaru.

### Features
- Sidebar s Pekáček ASCII avatarem a idle animacemi (mrkání, mávání, kafe, nakukování)
- 8 akčních tlačítek: Souhrn, Proti, Zkus, Analogie, Diagram, ELI5, Wiki, Ingest, Raw
- SSE streaming s pravými tokeny (`--include-partial-messages`)
- Session memory přes `claude -p --resume` — follow-upy pokračují v kontextu článku
- Auto-nabídka přečtení článku při otevření sidebaru
- Tool indikátor v status baru (cte soubor, hleda v souborech...)
- Options page pro konfiguraci bridge URL
- Komunikace přes lokální bridge (`localhost:3888`) — žádný API key, full Claude Code tool access
