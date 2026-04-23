# Pekáček Extension — Changelog

Semver: `MAJOR.MINOR.PATCH`.
- **MAJOR** — rozbíjející změny (manifest schema, breaking API)
- **MINOR** — nové feature, zpětně kompatibilní
- **PATCH** — bugfixy, drobné úpravy

## 2.3.0 — 2026-04-23

### Nové
- **⚡ Rychlé akce u send buttonu** — dropdown vlevo od textarea s pre-pečenými prompty pro časté dotazy. Otevírá se nahoru (je u dolní hrany). Sekce:
  - **Filmy** (z ČSFD watchlistu): 😌 Chill/oddychové · 🔥 Akční/napínavé · 🧠 Přemýšlivé. Každá varianta spustí `csfd-rate.mjs watchlist --all` a doporučí 3 tituly pasující k náladě.
  - **Recepty** (mám chuť na…): ⚡ Rychlovku · 🍜 Comfort food · 🥗 Něco zdravého. Filtruje `wiki/recepty/` podle tagů, preferuje oblíbené + vyzkoušené.
  - **Z wiki**: 🧪 Co dneska z labu? (doporučí jeden experiment z `lab/` na dotažení) · 📰 Co dnes číst? (3 tipy z `clanky/` se statusem `chci-precist`) · 📅 Co mám dneska? (kalendář + důležité nepřečtené emaily).
- **Dropdown sekce s header-y** — `.dropdown-header` pro oddělení skupin (malý uppercase text, čára mezi sekcemi).
- **`.dropdown-up`** CSS utility pro menu otevírající se nad tlačítkem.

## 2.2.2 — 2026-04-23

### Opravy
- **💾 Uložit ▾ dropdown se už nerozsype mimo obrazovku** — zarovnán k pravému okraji toho tlačítka (dřív `left: 0` + `min-width: 150px` → menu přetékalo doprava mimo panel). Nový CSS utility `.dropdown-right` pro dropdowny u pravého okraje.

## 2.2.1 — 2026-04-23

### Konsolidace akčních tlačítek — **5 buttonů místo 9**

Top bar je teď: **📋 Souhrn · 🤔 Proti · 🧪 Zkus · 🎓 Vysvětli ▾ · 💾 Uložit ▾**

- **🎓 Vysvětli ▾ dropdown rozšířen** — Analogie + Diagram přesunuté pod něj. Všechny "vysvětli to nějak" módy pod jednou střechou:
  - 👶 Jako pětiletému
  - 🧒 Zjednodušeně
  - 🔬 Odborně
  - 💡 Pomocí analogií
  - 📊 Nakreslit diagram
- **💾 Uložit ▾ dropdown** — Ingest + Raw sloučené do jednoho dropdownu:
  - 📚 Do wiki (ingest) — zpracuje článek a vytvoří wiki stránku
  - 🗂️ Do _raw (na pozdějc) — uloží URL do Chrome záložek pro pozdější ingest
- **Ikona Zkus** změněna z 🔬 (mikroskop) na 🧪 (zkumavka) — víc odpovídá "experimentu" a nekonflikuje s 🔬 Odborně.

## 2.2.0 — 2026-04-23

### Změny akčních tlačítek
- **Kompaktnější akční lišta** — ikona inline vedle textu (nebyla nad textem), menší padding, výška řady ~50 % původní. Víc místa pro chat.
- **🎓 Vysvětli ▾ dropdown** — nahrazuje původní ELI5 tlačítko. Tři úrovně vysvětlení:
  - 👶 Jako pětiletému (dřívější ELI5)
  - 🧒 Zjednodušeně (bez žargonu, plnohodnotné vysvětlení pro laika)
  - 🔬 Odborně (s technickými detaily, edge cases, trade-offs)
  Dropdown se zavírá kliknutím mimo.
- **Odstraněno tlačítko 🔗 Wiki** — bylo redundantní (jen navrhovalo, nic nezapisovalo). Stejnou funkci pokryje volný dotaz *"kam to patří ve wiki?"* v chatu; reálný zápis dělá 📚 Ingest (celý článek) nebo 📌 Pin (konkrétní odpověď).

## 2.1.4 — 2026-04-23

### Nové
- **Startup checks v bridge.** Při spuštění se ověří: `claude --version`, pCloud mount `/mnt/p/Wiki/Wiki`, symlink `~/pka/wiki` a read/write přístup. Problémy se logují do stderr s jasnou hláškou (např. "pCloud asi není namountovaný — spusť 'pcloud' alias"). Server startuje nezávisle na výsledku (jen informuje).

## 2.1.3 — 2026-04-23

### Opravy
- **`--add-dir /mnt/p/Wiki/Wiki` pro Pin do wiki.** v2.1.2 přidal `acceptEdits`, ale wiki je symlink `~/pka/wiki` → `/mnt/p/Wiki/Wiki` — po resolve mimo cwd, takže Claude Code v headless módu stále blokoval. `--add-dir` přidává pCloud cestu jako další povolený working directory.

## 2.1.2 — 2026-04-23

### Opravy
- **Pin do wiki 📌 už reálně zapisuje.** Bridge spouští `claude -p` s `--permission-mode acceptEdits` — v headless módu se Write/Edit jinak zastaví na interaktivním potvrzení (které nemá kdo stisknout) a Pekáček to pak překládá do *"Potřebuji přístup pro čtení a zápis do wiki"*.
- **User settings allowlist**: přejmenována stará cesta `/home/oposp/wiki/wiki/**` → `/home/oposp/pka/wiki/**` (zbytek po wiki→pka rename). Doplněny i `Edit(...)` patterny pro obě cesty (pCloud + WSL symlink).

## 2.1.1 — 2026-04-23

### Nové
- **Stop tlačítko ⏹** v status baru během generování — zastaví běžící Claude Code proces. Klávesová zkratka **Esc**. Bridge nový endpoint `POST /stop?id=<reqId>` kill-uje spawn, sidebar obdrží `stopped` event a doplní `(přerušeno)` k částečné odpovědi.
- **Badge 🔔 na toolbar ikoně** — když Pekáček dokončí odpověď a uživatel se mezitím přepnul do jiné záložky (`document.hidden`), na ikoně se zobrazí zelená tečka. Smaže se při návratu do sidebaru (visibilitychange → visible) nebo po kliknutí na ikonu.
- **Pin do wiki 📌** — u každé Pekáčkovy odpovědi nové tlačítko vedle Copy. Klik → přidá user message "📌 Ulož předchozí odpověď do wiki" a pošle pin prompt přes standardní `/ask` SSE flow. Claude Code urcí kategorii, založí stránku (dle formátu v CLAUDE.md), aktualizuje index.md + log.md, streamuje progress. Finální řádek odpovědi obsahuje cestu `📌 Uloženo: wiki/<kat>/<soubor>.md`.

### UX / Polish
- **Diakritika** — doplněna do všech user-facing stringů (sidebar.html/js, options.html/js, background.js, bridge.mjs banner + system prompt). Tool indikátory v češtině s diakritikou.
- **SIGTERM handling v bridge** — proces zabitý user Stopem už nehlásí jako error, čistě se uzavře stream.
- **activeRequests map** v bridge — tracking běžících /ask requestů pro čistý cleanup při disconnect / stop / close.

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
