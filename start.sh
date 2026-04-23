#!/usr/bin/env bash
#
# Wiki launcher — mountne pCloud, zkontroluje prereqs, spustí Claude Code.
# Použití:  ./start.sh          (normální start)
#           ./start.sh --safe   (bez --dangerously-skip-permissions)
#

set -euo pipefail

# Load nvm & npm-global PATH (needed when run from Windows shortcut —
# non-interactive shell doesn't source .bashrc)
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
export PATH="$HOME/.npm-global/bin:$PATH"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PKA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PCCLOUD_MOUNT="/mnt/p"
WIKI_SYMLINK="$PKA_DIR/wiki"
WIKI_TARGET="$PCCLOUD_MOUNT/Wiki/Wiki"

ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }

echo ""
echo "━━━ Wiki startup checklist ━━━"
echo ""

errors=0

# --- 0. Git pull (sync z jiného stroje) ---
cd "$PKA_DIR"
if [ -d "$PKA_DIR/.git" ] && git remote get-url origin &>/dev/null; then
    if git pull --ff-only 2>/dev/null; then
        ok "Git pull (up to date)"
    else
        warn "Git pull selhal — offline nebo merge conflict?"
    fi
else
    warn "Git remote není nastavený — skip pull"
fi

# --- 1. pCloud mount ---
if [ -d "$PCCLOUD_MOUNT/Wiki" ]; then
    ok "pCloud namountovaný ($PCCLOUD_MOUNT)"
else
    warn "pCloud není namountovaný — mountuji..."
    if [ ! -d "$PCCLOUD_MOUNT" ]; then
        sudo mkdir -p "$PCCLOUD_MOUNT"
    fi
    if sudo mount -t drvfs P: "$PCCLOUD_MOUNT" 2>/dev/null; then
        ok "pCloud namountovaný"
    else
        fail "Mount selhal — běží pCloud ve Windows?"
        ((errors++))
    fi
fi

# --- 2. Wiki symlink ---
if [ -L "$WIKI_SYMLINK" ] && [ -d "$WIKI_SYMLINK" ]; then
    ok "Wiki symlink OK ($WIKI_SYMLINK → $(readlink "$WIKI_SYMLINK"))"
elif [ -L "$WIKI_SYMLINK" ] && [ ! -d "$WIKI_SYMLINK" ]; then
    fail "Wiki symlink existuje ale cíl není dostupný (pCloud?)"
    ((errors++))
elif [ -f "$WIKI_SYMLINK" ]; then
    warn "wiki je soubor, ne symlink — opravuji..."
    rm "$WIKI_SYMLINK"
    ln -s "$WIKI_TARGET" "$WIKI_SYMLINK"
    ok "Symlink opraven"
elif [ ! -e "$WIKI_SYMLINK" ]; then
    warn "Wiki symlink neexistuje — vytvářím..."
    ln -s "$WIKI_TARGET" "$WIKI_SYMLINK"
    ok "Symlink vytvořen"
fi

# --- 3. .env ---
if [ -f "$PKA_DIR/.env" ]; then
    ok ".env existuje (ČSFD credentials)"
else
    warn ".env chybí — ČSFD skripty nebudou fungovat (viz .env.example)"
fi

# --- 4. Node.js ---
if command -v node &>/dev/null; then
    ok "Node.js $(node --version)"
else
    fail "Node.js není nainstalovaný"
    ((errors++))
fi

# --- 5. Dependencies ---
if [ -d "$PKA_DIR/node_modules/playwright" ]; then
    ok "Playwright nainstalovaný"
else
    warn "Playwright chybí — spusť: npm install"
fi

if ls "$HOME/.cache/ms-playwright/"chromium-* &>/dev/null 2>&1; then
    ok "Chromium browser nainstalovaný (ČSFD scraping)"
else
    warn "Chromium browser chybí — spusť: npx playwright install chromium"
fi

# --- 6. MCP config ---
if [ -f "$PKA_DIR/.mcp.json" ]; then
    ok ".mcp.json existuje (ČSFD MCP)"
else
    warn ".mcp.json chybí — ČSFD MCP nebude dostupný"
fi

# --- 7. Wiki obsah ---
if [ -f "$WIKI_SYMLINK/index.md" ]; then
    pages=$(find -L "$WIKI_SYMLINK" -name "*.md" 2>/dev/null | wc -l)
    ok "Wiki dostupná (${pages} stránek)"
else
    if [ $errors -eq 0 ]; then
        fail "Wiki index.md nenalezen"
        ((errors++))
    fi
fi

# --- 8. Disk space ---
disk_usage=$(df -h / 2>/dev/null | awk 'NR==2 {print $5}' | tr -d '%')
if [ -n "$disk_usage" ] && [ "$disk_usage" -gt 90 ]; then
    warn "Disk C: je na ${disk_usage}% — dávej pozor na velké operace"
else
    ok "Disk OK (${disk_usage:-?}%)"
fi

# --- 9. ČSFD pre-auth (zrychlí první Pekáčkův dotaz na watchlist) ---
if [ -f "$PKA_DIR/.env" ] && [ -f "$PKA_DIR/csfd-rate.mjs" ]; then
    if [ -f "$PKA_DIR/.csfd-state.json" ]; then
        ok "ČSFD session existuje (skip login)"
    else
        (
            cd "$PKA_DIR"
            node csfd-rate.mjs watchlist >/tmp/csfd-preauth.log 2>&1
        ) &
        disown
        ok "ČSFD pre-auth spuštěn na pozadí (log: /tmp/csfd-preauth.log)"
    fi
fi

echo ""

# --- Výsledek ---
if [ $errors -gt 0 ]; then
    echo -e "${RED}${errors} problém(ů) — oprav je a zkus znovu.${NC}"
    echo ""
    exit 1
fi

echo -e "${GREEN}Všechno OK.${NC}"
echo ""

# --- Start Pekáček bridge (for Chrome extension) ---
BRIDGE_SCRIPT="$PKA_DIR/tools/pekacek-extension/bridge.mjs"
BRIDGE_PORT=3888
BRIDGE_LOG="/tmp/pekacek-bridge.log"
BRIDGE_PID_FILE="/tmp/pekacek-bridge.pid"

if [ -f "$BRIDGE_SCRIPT" ]; then
    # Check if bridge already running (port responds)
    if curl -s -o /dev/null -m 1 "http://localhost:$BRIDGE_PORT/status" 2>/dev/null; then
        existing_pid=""
        [ -f "$BRIDGE_PID_FILE" ] && existing_pid=$(cat "$BRIDGE_PID_FILE" 2>/dev/null)
        ok "Pekáček bridge už běží (port $BRIDGE_PORT${existing_pid:+, PID $existing_pid})"
    else
        # Clean stale PID file
        rm -f "$BRIDGE_PID_FILE"
        # Start in background, detached from shell
        nohup node "$BRIDGE_SCRIPT" >"$BRIDGE_LOG" 2>&1 &
        bridge_pid=$!
        echo "$bridge_pid" > "$BRIDGE_PID_FILE"
        disown "$bridge_pid" 2>/dev/null || true

        # Wait briefly for startup
        for i in 1 2 3 4 5; do
            sleep 0.3
            if curl -s -o /dev/null -m 1 "http://localhost:$BRIDGE_PORT/status" 2>/dev/null; then
                ok "Pekáček bridge spuštěn (PID $bridge_pid, log: $BRIDGE_LOG)"
                break
            fi
            if [ $i -eq 5 ]; then
                warn "Bridge se nenastartoval — zkontroluj $BRIDGE_LOG"
            fi
        done
    fi
else
    warn "Bridge script nenalezen ($BRIDGE_SCRIPT) — Chrome extension nebude fungovat"
fi

echo ""

# --- Start Claude Code ---
cd "$PKA_DIR"

if [ "${1:-}" = "--safe" ]; then
    echo "Spouštím Claude Code (safe mode)..."
    echo ""
    exec claude
else
    echo "Spouštím Claude Code (skip permissions)..."
    echo ""
    exec claude --dangerously-skip-permissions
fi
