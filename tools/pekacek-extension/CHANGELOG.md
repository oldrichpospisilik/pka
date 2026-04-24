# Pekáček Extension — Changelog

Semver: `MAJOR.MINOR.PATCH`.
- **MAJOR** — rozbíjející změny (manifest schema, breaking API)
- **MINOR** — nové feature, zpětně kompatibilní
- **PATCH** — bugfixy, drobné úpravy

## 2.12.0 — 2026-04-24

### Nové
- **Bonus animace na klik do obličeje.** Čtyři varianty, weighted random (favorite: "utíká za obraz a vrátí se s dárkem"):
  - **Útěk & návrat s dárkem** (w=5) — 12 druhů dárků: ⚽ 🎈 🍕 🍎 🌻 ☕ 🐱 🍩 📖 🎸 🥐 🧸, plus malý showoff tanec po návratu
  - **Žonglování s míčem** (w=2) — míč krouží kolem Pekáčka
  - **Tanec** (w=2) — cyklování dancing frameů s hudebními notami ♪/♫
  - **Vykukování zprava** (w=2) — 3× vykoukne a schová se, pak přiběhne
- **Hlavička rezervuje fixní výšku** (`#pekacek-face min-height: 4.3em`) — přechody mezi 1/2/3-řádkovými obličeji už nedělají layout shift. Bonus animace mají pár px bufferu navíc.

### Změny
- **Rename**: `Pekáček — Reading Companion` → `Pekáček — osobní asistent`. Description updatován — už to dávno není jen reader (ingest, ČSFD, start-of-day, filmy/recepty/knihy pickery…).
- **Title stránky se přesunul** ze status-baru do vlastního `#page-bar` řádku pod dashboard chipem (s 🌐 ikonou). Dřív se tísnil vedle MCP statusu.
- **Thinking zprávy se přesunuly ze status-baru do chat loading message.** Rotující kontextový text ("Shrnuju...", "Hledám slabiny...", "Vytvářím stránku...") teď běží přímo v odpovědní bublině v chatu — tam, kam se uživatel dívá. Bublina je oživená: žlutá kurziva, pulse opacity, animované tečky. Horní status-bar se zjednodušil na connection state (Připraveny / Odpovídá / Hotovo / Bridge offline) + MCP + Stop.

### Opravy
- **Layout shift hlavičky eliminován.** Všechny 2-řádkové obličeje (idle, wave, coffee, reading) mají teď řádky paddované na stejnou cell-šířku (~11 cells), takže přechod mezi nimi parent nere-centruje blok a hlava se nehýbe doleva/doprava.
- **Coffee ☕ zpět vedle hlavy** (sipping style), už ne pod tělem (jak vypadal po rozlití) — díky width normalizaci je to teď stabilní.
- **Reading face**: kniha `📖` vedle hlavy (dřív byla `[📚]` nad hlavou ve 3-řádkovém provedení).
- **`yt-dlp` povolen v project allowlist** (`.claude/settings.json`) — free-text požadavky na transcript z YT už nevyžadují permission modal.

## 2.11.0 — 2026-04-24

### Nové
- **Bookmarks MCP status v sidebaru.** Ve status-baru přibyla malá tečka + popisek „MCP" (pro Chrome bookmarks MCP na `:3777`). Barva signalizuje stav: zelená = server běží a extension long-polluje, žlutá = server běží ale extension ještě nepolluje, červená = server offline. Klik otevře popover s podrobnostmi (server, extension, pending příkaz) a tlačítkem **↻ Reconnect**, které resetuje long-poll cyklus v service workeru (force `bookmarksPolling = false` → `bookmarksLongPoll()`). Status se obnovuje každých 5 s.
- Obnoven MCP server `tools/chrome-bookmarks-mcp/` z historie (byl odstraněn při unifikaci extension v `64b6b08`). Extension long-poll kód v `background.js` zůstal celou dobu — server byl jediná chybějící strana. Přidáno do `.mcp.json` a do `start.sh` checklistu (kontrola skriptu, deps, Chrome bookmarks souboru).

## 2.10.1 — 2026-04-23

### Opravy
- **Otevření sidebaru s existující session už neuvede "Vidím článek" znova.** Dva bugs:
  1. **Race condition** — `loadTabInfo()` fire před dokončením `initSession()` / `restoreSessionFromStorage()`, takže `articleRead` a `lastReadUrl` byly ještě `false`/`null`. Fix: `loadTabInfo()` teď běží až po `await initSession()`.
  2. **Chyběla kontrola historie session** — i po dotažení session, kdy `articleRead=false` (typicky pokud jsi dřív skipnul nabídku ale chatoval ručně), nabídka znovu vyskočila. Fix: pokud má aktuální session ≥ 1 zprávu, nabídka se neukazuje (pokračuješ v konverzaci).
- **YouTube SPA navigace detekována.** Když jsi na YT a přeskočil na jiné video bez reloadu (SPA history API), sidebar to teď zachytí. `background.js` naslouchá `chrome.tabs.onUpdated` a posílá `tab-url-changed` message, sidebar na něj resetuje `currentPageContent` / `articleRead` / `lastReadUrl` a znovu volá `loadTabInfo` → nová YT nabídka s čerstvým `videoId`. Dřív ti v chatu zůstávala stará offer tlačítka s closurovaným `videoId` → klik na 📄 vracel transcript předchozího videa z cache.
- **Shift+Klik na 📄 = force refresh** transcript cache pro aktuální video. Bridge endpoint teď zná `?force=1` (invaliduje cache entry pro daný `videoId` a stáhne znovu). User message se označí *"(force refresh)"* a placeholder *"Stahuji transcript znovu (bez cache)…"*, ať je jasné co se děje.
- Bridge logy transcriptů jsou teď čitelnější: `cache hit` / `fresh` / `force refresh` s jazykem a délkou.

## 2.10.0 — 2026-04-23

### Nové
- **Persistentní stav konverzací** přes `chrome.storage.local` (klíče `pekacek.sessions` a `pekacek.currentSessionId`). Každá session má `id`, `title` (auto-odvozený z prvního user promptu), `url` (pokud nad článkem/videem), `createdAt`, `updatedAt`, `messages[{role, rawText, at}]`, `articleRead`, `claudeSessionId`. Drží se **max 30** konverzací (nejstarší se odmazávají).
- **Zapamatuje aktuální session přes restart sidebaru** — když ho zavřeš a otevřeš, pokračuješ ve stejné konverzaci (ne v prázdném chatu). Aktuální session je explicitně uložené id.
- **📚 Historie (tlačítko v avataru, vedle ↻)** — overlay se seznamem uložených konverzací. Každá položka: titul, čas *"před N min/h/dny"*, počet zpráv, 🔗 indikátor pokud je vázaná na URL. Klik = načte zpět do chatu. Hover → ✕ pro smazání (s confirm).
- **↻ Reset** teď **nezmaže konverzaci** — archivuje ji do historie a zakládá novou (oba kroky automaticky). Tooltip aktualizován: *"Nová konverzace (aktuální uložit do historie)"*.
- **Claude session continuity.** Bridge přijímá v `/ask` body `claudeSessionId`, priorita před `articleCache` lookupem. Nový SSE event `claude-session` nese Claude ID zpátky klientovi při každém initu → sidebar ho uloží do current session. Při obnovení historie se poslední `claudeSessionId` přilepí k dalšímu promptu a Claude pokračuje s plným kontextem (funguje i po restartu bridgi — Claude Code session storage je persistentní).

### Známá omezení
- Po obnovení ze storage se **one-shot UI** nerekonstruuje: offer tlačítka (*Přečti si ho / YouTube akce*) a scrollovatelný transcript `<pre>` blok jsou v historii jen jako text. Pro transcript stačí kliknout 📄 znovu.
- `messages` se ukládají jen jako `rawText` (markdown) — bohatý rendering (copy/pin buttony) se skládá znovu, ale vlastní formátování (code bloky, ASCII diagramy) vypadá stejně.

## 2.9.1 — 2026-04-23

### Nové
- **📄 Zobraz transcript** — nové tlačítko v YouTube flow. Stáhne transcript (stejným endpointem jako shrnutí, takže sdílí 24 h cache) a vykreslí ho do scrollovatelného `<pre>` bloku v chatu. Block má `resize: vertical`, copy button a sentence-break prettifier (láme odstavce po interpunkci, nebo fallback po ~35 slovech u auto-caps bez teček).
- Na rozdíl od ostatních YT akcí tlačítka po kliku na 📄 **nezmizí** — transcript je read-only peek, chceš po něm klidně pokračovat na shrnutí nebo ingest bez nutnosti resetu.

## 2.9.0 — 2026-04-23

### Nové
- **YouTube transcript přes yt-dlp.** Bridge endpoint `GET /youtube/transcript?videoId=X` spustí `yt-dlp --write-auto-sub --write-sub --sub-lang cs,en --sub-format vtt --skip-download` do `/tmp/yt-<id>-XXX/`, rozparsuje VTT (zahodí timestampy, WEBVTT header, cue numbery, inline tagy jako `<c>` / `<00:00:01>`, dedupnuje echa z auto-caps) a vrátí plain text. Cache per videoId TTL 24 h. Priorita: `cs.vtt` > `en.vtt` > cokoli jiného.
- **Nové tlačítko 📝 "Shrň důkladně (s transcriptem)"** v YouTube flow — vedle rychlého 💬 shrnutí z popisku. Po kliku: stáhne transcript, pošle ho Claudovi s promptem na strukturované shrnutí (o čem to je · 4–6 klíčových myšlenek · komu to doporučit · doporučení ingest do wiki).
- **📚 Ingest YouTube** teď taky nejprve zkusí transcript. Pokud je, Claude ho dostane jako zdrojový text a ingest má stejnou kvalitu jako u článku. Pokud ne (video bez captions, yt-dlp selhal), fallback na metadata-only s poznámkou "⚠ bez transcriptu — doplnit po zhlédnutí".
- **Graceful fallback** — pokud `yt-dlp` není instalované / selže / video nemá captions, YT tlačítka stejně fungují (fallback na popis + upřímná hláška uživateli).

### Závislosti
- `yt-dlp` musí být v PATH (`apt install yt-dlp` nebo `pip install yt-dlp`).

## 2.8.0 — 2026-04-23

### Nové
- **YouTube handler.** Když je aktivní tab YouTube video (`youtube.com/watch` nebo `youtu.be/`), sidebar nenabízí *"Přečti si ho"* jako u článku, ale YouTube-specific flow:
  - 💬 **Shrň obsah (z popisku)** — Claude shrne o čem video je z metadat + description. Upřímně řekne když je popis chudý a shrnutí by bylo spekulace.
  - 🎬 **Film/seriál → přidat na ČSFD watchlist** — Claude vyhodnotí z názvu jestli jde o samotný film/seriál, použije `mcp__csfd__search`, při match volá `node csfd-rate.mjs watchlist-add`. U rozborů/recenzí/trailerů nabídne související titul.
  - 📚 **Naučné → ingest do wiki** — standardní ingest podle CLAUDE.md workflow, ale s vědomím že nemá transcript; pokud je popis chudý, založí stránku s metadaty a poznámkou "⚠ bez transcriptu — doplnit po zhlédnutí".
  - ⏭ **Přeskoč** — zavře nabídku.
- **Content script rozšířen** o YouTube extraction. Z `og:*` meta tagů a DOM selektorů vytáhne `videoId`, `title`, `channel`, `description` (do 3000 znaků), `duration`. Payload má `type: "youtube"` a i plaintext `text` (metadata + description), aby fungoval kontext v chatu.
- **Bridge allowedTools** v `/ask` endpointu teď zahrnuje `mcp__csfd__search`, `mcp__csfd__get_movie`, `mcp__csfd__get_creator`, `mcp__csfd__get_user_ratings` — nutné aby YouTube→watchlist akce proběhla bez permission promptu v headless módu.

### Známá omezení
- **Transcript se zatím nestahuje** — Claude pracuje jen s metadaty a popiskem. Pro video esej / dlouhou přednášku to znamená omezené shrnutí. Transcript přes headless browser je kandidát na v2.9.

## 2.7.0 — 2026-04-23

### Nové
- **Dashboard chip v horní liště.** Nad status barem nový řádek: `📰 {články} · 📬 {emaily} · 📅 {nejbližší událost}`. Klik rozbalí detail panel se třemi sekcemi:
  - **📰 Články k přečtení** — seznam titulů z `wiki/clanky/` se statusem `chci-precist` (grep filesystemu v bridge, instant). Každá položka klikatelná → pošle prompt "přečti a shrň" s návrhem zda označit `precteno` / `zamitnuto`.
  - **📬 Nepřečtené emaily** — Gmail MCP (`is:unread -category:promotions -category:social`), max 10. Read-only výpis *od — předmět*.
  - **📅 Nadcházející události** — Google Calendar MCP, 14 dní dopředu. Prefix *dnes / zítra / za Nd*, plus čas u časovaných.
  - Footer: "Aktualizováno před N min" + **↻ Obnovit** tlačítko (invaliduje cache a re-fetchne).
- **Bridge endpointy:**
  - `GET /dashboard` — vrací články instantně (filesystem grep) + cached emaily/události (TTL 10 min). Pokud je cache stará / prázdná, spustí background refresh a vrátí `pending: true`.
  - `POST /dashboard/refresh` — invaliduje cache a spustí fetch. Klient poté polluje `GET /dashboard` každé 3s dokud není `pending: false`.
  - Emaily + události fetchuje samostatným `claude -p` voláním s `--allowedTools mcp__claude_ai_Gmail__search_threads mcp__claude_ai_Google_Calendar__list_events` a JSON výstupem.
- **Sidebar polluje dashboard** při otevření a při `visibilitychange` (návrat do záložky).

## 2.6.0 — 2026-04-23

### Nové
- **Recept picker** — místo 3 statických tlačítek (rychlovka / comfort / zdravé) plný chip picker analogický k filmům. Čtyři řádky:
  - **Typ jídla (multi)**: ☀️ snídaně · 🍽️ oběd · 🌙 večeře · 🍰 dezert · 🍲 polévka · 🥪 svačina.
  - **Nálada (multi)**: ⚡ rychlovka · 🍜 comfort · 🥗 zdravé · 🎉 party · 💕 roman · ☀️ letní · 🍂 podzim.
  - **Čas (single)**: &lt;20 · 20–45 · &gt;45 · libovolný.
  - **Dieta (single)**: jakákoliv · vegetariánské · veganské · bezlepkové.
  - Prompt radí Claudovi grepnout frontmatter v `wiki/recepty/` (**Typ jídla**:, **Nálada**:, **Čas**:, **Dieta**:) a preferovat `oblíbené` + `vyzkoušeno`.
- **Knihy picker** — nová sekce "Knihy — co si pustit / přečíst?". Čerpá z `wiki/kultura/knihy/`:
  - **Formát (multi)**: 📕 papír · 📱 ekniha · 🎧 audio.
  - **Nálada (multi)**: 😱 napínavé · 😌 oddych · 🌑 temné · 😂 humor · 🧠 hlubší · 💕 roman.
  - **Délka (single)**: krátká · standard · delší · libovolná.
  - Prompt preferuje status `chci-přečíst` / `chci-poslechnout` před přečtenými.
- **Divadlo** — jednoduchá položka "Co v divadle?" (vypíše stránky z `wiki/kultura/divadlo/` se statusem `chci-vidět` / `mám-lístek`).
- **Accordion sekce v ⚡ menu.** Sekce (Filmy / Recepty / Knihy / Divadlo / Z wiki) jsou teď kolapsovatelné `<details name="pekacek-sections">` — max 1 otevřená naráz (browser-native exkluzivita). Caret ▸ se otáčí, aktivní sekce je zeleně podbarvená. Poslední otevřená sekce se pamatuje v `localStorage` (klíč `pekacek.accordion.open`), default = Filmy. Menu má také `max-height: 70vh` + scroll kdyby se jedna velká sekce nevešla.
- **Klávesové zkratky** v sidebaru:
  - **Alt+1** Souhrn · **Alt+2** Proti · **Alt+3** Zkus · **Alt+4** Vysvětli ▾ · **Alt+5** Uložit ▾.
  - **Alt+Q** — toggle ⚡ quick menu.
  - Tooltipy na tlačítkách teď zmiňují příslušnou zkratku.

## 2.5.0 — 2026-04-23

### Nové
- **Přepínač "watchlist vs celá ČSFD"** ve filmovém pickeru. Třetí chip řádek v ⚡ dropdownu:
  - 📋 **watchlist** (default) — hledá v mém Chci vidět (jako dosud, přes `csfd-rate.mjs watchlist --all`).
  - 🌐 **celé ČSFD** — hledá v celé databázi ČSFD přes `mcp__csfd__search` + `mcp__csfd__get_movie`. Doporučuje i filmy které nemám ve watchlistu (na konci řádku *"— mimo watchlist"*). Preferuje filmy s hodnocením ≥ 70 %.
- **Podpora `--genre` v `csfd-rate.mjs watchlist`** (viz hlavní repo) — prompt teď explicitně radí Claudovi tento flag použít pro přesné filtrování dle žánru místo hádání podle názvů.

## 2.4.0 — 2026-04-23

### Nové
- **Filmový picker s multi-select chipy.** Místo 3 předpečených tlačítek (chill / akční / přemýšlivé) teď v ⚡ dropdownu sekce "Filmy — co mi pustíš?":
  - **Nálada (multi-select)**: 😌 oddych · 🔥 akce · 😱 bát se · 🧠 hlubší · 😂 humor · 💕 roman · ☀️ feel-good · 🌑 temné · 🎨 vizuální. Toggle kliknutím, kombinuj libovolně.
  - **Délka (single-select)**: &lt;90 · 90–120 · &gt;120 · libovolná (default).
  - **Doporuč film (podle výběru)** — tlačítko pod chipy. Pošle prompt s přesnými kritérii (mood popisy + délka) a popíská user message tak, abys v chatu viděl co přesně jsi hledal (např. *"Doporuč film (akce + bát se · kratší)"*).
- **Chip UI komponenta** — reusable `.chip` + `.chip-group.chip-multi / .chip-single` pro budoucí filtry (recepty, knihy…).

## 2.3.1 — 2026-04-23

### Opravy
- **Bash allowlist v bridge.** `--permission-mode acceptEdits` řeší jen Write/Edit — Bash příkazy v headless módu stále potřebují explicit allow. Doplněno `--allowedTools` s bezpečnými read-only příkazy potřebnými pro quick actions:
  - `Bash(node csfd-rate.mjs *)` — watchlist, rate, atd.
  - `Bash(node tools/*)` — ostatní skripty v `tools/`
  - `Bash(grep *)`, `Bash(rg *)`, `Bash(ls *)`, `Bash(find *)` — wiki searches / file listing

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
