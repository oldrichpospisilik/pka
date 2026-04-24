# PKA (Personal Knowledge Assistant)

Familiárně **Pekáček**. Správce osobní wiki, knížek a audia na pCloudu, filmů na ČSFD a budoucí osobní asistent.

Pracovní adresář pro Claude Code. Wiki obsah je na pCloudu, tady je CLAUDE.md, skripty a skills.

## Spuštění

### 1. pCloud disk

Wiki žije na pCloudu (`P:\Wiki\Wiki\`). Ve WSL se mountuje jako `/mnt/p/`. Pokud po startu WSL `/mnt/p/` nejde otevřít:

```bash
# Ujisti se, že pCloud běží ve Windows (systray)
# Pak ve WSL:
sudo mount -t drvfs P: /mnt/p
```

Ověření:
```bash
ls /mnt/p/Wiki/Wiki/index.md   # měl bys vidět wiki obsah
```

### 2. Symlink

`~/pka/wiki` je symlink na `/mnt/p/Wiki/Wiki/`. Pokud se rozbil (je to prázdný soubor místo symlinku):

```bash
rm ~/pka/wiki
ln -s /mnt/p/Wiki/Wiki ~/pka/wiki
```

### 3. Claude Code

```bash
cd ~/pka
claude
```

## Struktura

```
~/pka/
├── CLAUDE.md              ← instrukce pro Clauda (správce wiki)
├── README.md              ← tohle (instrukce pro tebe)
├── .env                   ← ČSFD credentials (CSFD_USERNAME, CSFD_PASSWORD)
├── .env.example           ← šablona pro .env
├── .mcp.json              ← MCP servery (ČSFD)
├── package.json           ← Node.js dependencies (playwright, dotenv)
├── csfd-rate.mjs          ← ČSFD skript (hodnocení, watchlist)
├── start.sh               ← startup checklist + mount + launch Claude Code
├── wiki -> /mnt/p/Wiki/Wiki/  ← symlink na wiki obsah
├── .claude/skills/        ← projektové skills (Claude Code je načte z .claude/skills/)
│   ├── csfd/SKILL.md          ← ČSFD integrace
│   ├── ebook-ingest/SKILL.md  ← třídění ebooků
│   └── audiobook-ingest/SKILL.md ← třídění audioknih
└── tools/                 ← pekacek Chrome extension + bridge, Windows .lnk
```

## Skripty

### csfd-rate.mjs — ČSFD hodnocení + watchlist

Playwright skript (Firefox), přihlásí se na ČSFD a provede akci.

```bash
# Ohodnotit film (zapíše na ČSFD)
node csfd-rate.mjs rate <url-nebo-id> <1-5>
node csfd-rate.mjs rate https://www.csfd.cz/film/370706-daredevil/ 4
node csfd-rate.mjs rate 370706 4

# Zkontrolovat hodnocení
node csfd-rate.mjs check <url-nebo-id>
node csfd-rate.mjs check 370706

# Watchlist — přečíst
node csfd-rate.mjs watchlist            # první stránka (50 filmů)
node csfd-rate.mjs watchlist --all      # celý watchlist (pomalé, 14+ stránek)

# Watchlist — přidat
node csfd-rate.mjs watchlist-add <url-nebo-id> [poznamka]
node csfd-rate.mjs watchlist-add 1018007 "Ryan Gosling, vypadá dobře"

# Watchlist — odebrat
node csfd-rate.mjs watchlist-remove <url-nebo-id>
```

**Potřebuje:** `.env` s `CSFD_USERNAME` a `CSFD_PASSWORD` (přezdívka, ne email).

## Skills (Claude Code)

Skills se Claudovi načtou automaticky při startu z `~/pka/`. Nevoláš je ručně — Claude je použije, když řekneš relevantní věc.

| Skill | Trigger | Co dělá |
|---|---|---|
| **csfd** | "ohodnoť X", "přidej na watchlist", "chci vidět X" | Vyhledá film, ohodnotí, spravuje watchlist |
| **ebook-ingest** | "roztřiď ebooky", "zpracuj raw ebooky" | Roztřídí ebooky z `_raw/` do knihovny na pCloudu |
| **audiobook-ingest** | "roztřiď audioknihy", "zpracuj raw audioknihy" | Roztřídí audioknihy z `__raw/` do knihovny na pCloudu |

## MCP servery

Definované v `.mcp.json`, Claude Code je načte při startu.

| Server | Tooly | Účel |
|---|---|---|
| **csfd** | `search`, `get_movie`, `get_creator`, `get_user_ratings`, `get_user_reviews`, `get_cinemas` | Čtení dat z ČSFD (read-only) |
| **chrome-bookmarks** | `list_bookmarks`, `search_bookmarks`, `find_duplicates`, `move_bookmark`, `create_bookmark`, `create_folder`, `delete_bookmark`, `update_bookmark` | Správa Chrome záložek přes Pekáček extension (long-poll bridge `:3777`). Vyžaduje běžící Chrome s nahranou extensionou. |

Pokud jsou v Claude.ai zapnuté connectory (Gmail, Google Calendar, Notion, Slack, Google Drive), Claude je uvidí taky — ale tenhle projekt je explicitně využívá jen pro **Gmail** (read, drafty) a **Google Calendar** (plné ovládání). Viz CLAUDE.md sekci "Co umím".

## Pekáček Chrome extension

V `tools/pekacek-extension/` je Chrome extension (Manifest V3) s vlastním sidebarem. Bridge (`tools/pekacek-extension/bridge.mjs`, port `:3888`) propojuje sidebar s Claude Code a umožňuje volat mě přímo z prohlížeče. Start.sh bridge spouští automaticky.

Features v sidebaru:
- **Souhrn** stránky / **protimyšlenky** / **Vysvětli ▾** (jako pětiletému / zjednodušeně / odborně / analogií / diagramem) / **Experimenty** z `lab/`
- **Rychlé akce** (dashboard chip, pickery pro filmy, recepty, knihy, divadlo, články)
- **Uložit ▾** — do `_raw` záložek nebo rovnou ingest do wiki
- **YouTube** — transcript (yt-dlp), souhrn z transcriptu
- **Persistentní historie** konverzací (max 30, auto-archivace, ↻ Reset zakládá novou)
- **MCP status** — tečka v status-baru + popover se stavem `chrome-bookmarks` MCP a Reconnect tlačítkem

Instalace extension: Chrome → `chrome://extensions` → Developer mode → Load unpacked → vyber `tools/pekacek-extension/`. Jakmile změním kód, reloadni extension (↻ v chrome://extensions).

## Raw zdroje pro wiki

Tři místa kam házíš raw vstupy pro ingest do wiki — Claude při ingestu zkontroluje všechna:

| Odkud | Cesta | Typické použití |
|---|---|---|
| pCloud (telefon/browser) | `/mnt/p/Wiki/raw/` | Z telefonu, prohlížeče |
| Obsidian Web Clipper | `/mnt/p/Wiki/Wiki/_raw/` | Automaticky z browser extension |
| Chrome záložky | `_raw` složka v Bookmarks | Záložky k roztřídění (přes `chrome-bookmarks` MCP) |

## Setup na novém stroji

```bash
git clone https://github.com/oldrichpospisilik/pka.git ~/pka
cd ~/pka
cp .env.example .env             # vyplnit ČSFD credentials (přezdívka + heslo)
npm install                      # playwright, dotenv
npx playwright install firefox   # browser pro ČSFD skripty (Chromium blokuje BotStopper)
./start.sh                       # namountuje pCloud, zkontroluje vše, spustí Claude Code
```

Předpoklady: Node.js, pCloud nainstalovaný ve Windows, WSL.
