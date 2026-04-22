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

`~/wiki/wiki` je symlink na `/mnt/p/Wiki/Wiki/`. Pokud se rozbil (je to prázdný soubor místo symlinku):

```bash
rm ~/wiki/wiki
ln -s /mnt/p/Wiki/Wiki ~/wiki/wiki
```

### 3. Claude Code

```bash
cd ~/wiki
claude
```

## Struktura

```
~/wiki/
├── CLAUDE.md              ← instrukce pro Clauda (správce wiki)
├── README.md              ← tohle (instrukce pro tebe)
├── .env                   ← ČSFD credentials (CSFD_USERNAME, CSFD_PASSWORD)
├── .env.example           ← šablona pro .env
├── .mcp.json              ← MCP servery (ČSFD)
├── package.json           ← Node.js dependencies (playwright, dotenv)
├── csfd-rate.mjs          ← ČSFD skript (hodnocení, watchlist)
├── raw/                   ← surové zdroje pro wiki ingest (lokální)
├── wiki -> /mnt/p/Wiki/Wiki/  ← symlink na wiki obsah
├── csfd-tool/SKILL.md     ← Claude skill: ČSFD integrace
├── ebook-ingest/SKILL.md  ← Claude skill: třídění ebooků
└── audiobook-ingest/SKILL.md ← Claude skill: třídění audioknih
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

Skills se Claudovi načtou automaticky při startu z `~/wiki/`. Nevoláš je ručně — Claude je použije, když řekneš relevantní věc.

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

## Raw zdroje pro wiki

Tři místa kam házíš raw vstupy pro ingest do wiki:

| Odkud | Cesta | Typické použití |
|---|---|---|
| WSL (lokálně) | `~/wiki/raw/` | Při práci v Claude Code |
| pCloud (telefon/browser) | `/mnt/p/Wiki/raw/` | Z telefonu, prohlížeče |
| Obsidian Web Clipper | `/mnt/p/Wiki/Wiki/_raw/` | Automaticky z browser extension |

Claude při ingestu zkontroluje všechna tři místa.

## Setup na novém stroji

```bash
git clone https://github.com/oldrichpospisilik/pka.git ~/wiki
cd ~/wiki
cp .env.example .env             # vyplnit ČSFD credentials (přezdívka + heslo)
npm install                      # playwright, dotenv
npx playwright install firefox   # browser pro ČSFD skripty (Chromium blokuje BotStopper)
./start.sh                       # namountuje pCloud, zkontroluje vše, spustí Claude Code
```

Předpoklady: Node.js, pCloud nainstalovaný ve Windows, WSL.
