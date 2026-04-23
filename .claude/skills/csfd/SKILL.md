---
name: csfd
description: Správa filmů a seriálů na ČSFD — vyhledávání, metadata, hodnocení, watchlist, doporučování. Spouští uživatel zprávou jako "ohodnoť X", "přidej X na watchlist", "chci vidět X", "viděl jsem X", "dávám X hvězdiček", "co mám na watchlistu", "doporuč mi film", "chci se na něco kouknout", "najdi film X na ČSFD".
---

# ČSFD Tool

**Primární zdroj pro filmy je ČSFD, ne wiki.** Když se uživatel ptá na svůj watchlist, hodnocení, doporučení nebo historii zhlédnutí — **negrepuj `kultura/filmy/`**. Zavolej ČSFD nástroje a odpověz z jejich výstupu.

Integrace s ČSFD.cz pro správu filmů/seriálů. Dva kanály:

1. **MCP (read-only)** — vyhledávání, metadata, čtení hodnocení
2. **Playwright skript (write)** — zápis hodnocení, správa watchlistu

## ČSFD profil

- Nick: **maxx**
- Profil: https://www.csfd.cz/uzivatel/316-maxx/
- Credentials: `~/pka/.env` (CSFD_USERNAME, CSFD_PASSWORD)

## MCP tooly

| Tool | Účel |
|---|---|
| `mcp__csfd__search` | Vyhledávání filmů/seriálů/tvůrců |
| `mcp__csfd__get_movie` | Detail filmu (žánr, rok, hodnocení, obsazení, popis) |
| `mcp__csfd__get_creator` | Detail tvůrce |
| `mcp__csfd__get_user_ratings` | Hodnocení uživatele (`user: "maxx"`) |
| `mcp__csfd__get_user_reviews` | Recenze uživatele |
| `mcp__csfd__get_cinemas` | Kina |

**Pozor:** MCP tooly jsou deferred — před prvním použitím zavolej `ToolSearch` s `select:mcp__csfd__search,mcp__csfd__get_movie` atd.

## Playwright skript (`~/pka/csfd-rate.mjs`)

```bash
# Hodnocení
node csfd-rate.mjs rate <csfd-url-nebo-id> <1-5>
node csfd-rate.mjs check <csfd-url-nebo-id>

# Watchlist (Chci vidět)
node csfd-rate.mjs watchlist                       # první stránka (50 filmů)
node csfd-rate.mjs watchlist --all                 # celý watchlist
node csfd-rate.mjs watchlist-add <url-nebo-id> [poznamka]
node csfd-rate.mjs watchlist-remove <url-nebo-id>
```

Přijímá ČSFD URL i číselné ID. Timeout na příkaz: **60 sekund** (login + navigace + akce).

## Workflow: doporučení / "co si pustit" / "co mám na watchlistu"

1. `node csfd-rate.mjs watchlist` (nebo `--all` pro celý) → stáhni Chci vidět
2. Volitelně `mcp__csfd__get_user_ratings` (user `"maxx"`) → zohledni co uživatel už viděl / rád má
3. Doporuč z watchlistu podle vyžádané nálady / žánru / délky. **Nehledej ve wiki** — wiki film stránky jsou výjimky, ne databáze.

## Workflow: uživatel chce přidat na watchlist

1. `mcp__csfd__search` → najdi film, získej ID
2. `node csfd-rate.mjs watchlist-add <id> [poznamka]`
3. **Wiki stránku nezakládej** (ledaže řekne explicitně).

## Workflow: uživatel chce ohodnotit film

1. Pokud neznáš ČSFD ID: `mcp__csfd__search` → najdi film
2. `node csfd-rate.mjs rate <id> <hvezdicky>` → zapíše na ČSFD
3. **Wiki stránku neaktualizuj** (ledaže existuje — pak status → viděno + hodnocení).

## Workflow: uživatel chce odebrat z watchlistu

1. `node csfd-rate.mjs watchlist-remove <url-nebo-id>`

## Workflow: uživatel chce wiki stránku k filmu (výjimka)

Jen na explicitní žádost (*"napiš mi o tom poznámky"*, *"chci si o tom něco zapsat"*):

1. `mcp__csfd__search` + `mcp__csfd__get_movie(id)` → metadata
2. Vytvoř stránku v `wiki/kultura/filmy/` podle zkrácené šablony v CLAUDE.md

## Technické poznámky

- Playwright používá **Firefox** (Chromium blokuje BotStopper).
- Login přes přezdívku (pole `nick`), ne email.
- Hvězdičky: `data-rating` 20/40/60/80/100 = 1–5★.
- Watchlist-add automaticky zaškrtne "po ohodnocení vyřadit ze Chci vidět".
- Dependencies: `playwright`, `dotenv` v `~/pka/package.json`.
