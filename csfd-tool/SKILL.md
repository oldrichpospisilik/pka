---
name: csfd
description: Správa filmů a seriálů na ČSFD — vyhledávání, metadata, hodnocení, watchlist. Spouští uživatel zprávou jako "ohodnoť X", "přidej X na watchlist", "chci vidět X", "viděl jsem X", "dávám X hvězdiček", "co mám na watchlistu", "najdi film X na ČSFD".
---

# ČSFD Tool

Integrace s ČSFD.cz pro správu filmů/seriálů. Dva kanály:

1. **MCP (read-only)** — vyhledávání, metadata, čtení hodnocení
2. **Playwright skript (write)** — zápis hodnocení, správa watchlistu

## ČSFD profil

- Nick: **maxx**
- Profil: https://www.csfd.cz/uzivatel/316-maxx/
- Credentials: `~/wiki/.env` (CSFD_USERNAME, CSFD_PASSWORD)

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

## Playwright skript (`~/wiki/csfd-rate.mjs`)

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

## Workflow: uživatel chce přidat film do wiki

1. `mcp__csfd__search` → najdi film, získej ID
2. `mcp__csfd__get_movie(id)` → stáhni metadata
3. Vytvoř stránku v `wiki/kultura/filmy/` podle šablony v CLAUDE.md
4. Zeptej se na subjektivní pole: *proč chci vidět*, *nálada*, *zdroj doporučení*

## Workflow: uživatel chce ohodnotit film

1. Pokud neznáš ČSFD ID: `mcp__csfd__search` → najdi film
2. `node csfd-rate.mjs rate <id> <hvezdicky>` → zapíše na ČSFD
3. Aktualizuj wiki stránku filmu (status → viděno, hodnocení, poznámky)

## Workflow: uživatel chce přidat na watchlist

1. `mcp__csfd__search` → najdi film
2. `node csfd-rate.mjs watchlist-add <id> [poznamka]`
3. Volitelně: vytvoř wiki stránku se status `chci-vidět`

## Workflow: uživatel chce odebrat z watchlistu

1. `node csfd-rate.mjs watchlist-remove <url-nebo-id>`

## Workflow: sync hodnocení z ČSFD

1. `mcp__csfd__get_user_ratings` s `user: "maxx"` → seznam hodnocených filmů
2. Porovnej s wiki stránkami v `kultura/filmy/`
3. Aktualizuj chybějící hodnocení

## Technické poznámky

- Playwright používá **Firefox** (Chromium blokuje BotStopper).
- Login přes přezdívku (pole `nick`), ne email.
- Hvězdičky: `data-rating` 20/40/60/80/100 = 1–5★.
- Watchlist-add automaticky zaškrtne "po ohodnocení vyřadit ze Chci vidět".
- Dependencies: `playwright`, `dotenv` v `~/wiki/package.json`.
