#!/usr/bin/env bash
# Claude Code status line — Pekáček edition
# Dostane JSON na stdin (session_id, cwd, model, workspace, ...)

input=$(cat)

parse() {
    python3 -c "
import json, sys
try:
    d = json.loads('''$input''')
except Exception:
    sys.exit(0)
$1" 2>/dev/null
}

cwd=$(parse "print(d.get('workspace',{}).get('current_dir') or d.get('cwd') or '')")
[ -z "$cwd" ] && cwd="$PWD"
short_path="${cwd/#$HOME/~}"

model=$(parse "print(d.get('model',{}).get('display_name',''))")

branch=""
if git -C "$cwd" rev-parse --git-dir &>/dev/null; then
    branch=$(git -C "$cwd" branch --show-current 2>/dev/null)
fi

T='\033[38;2;78;204;163m'  # Pekáček turquoise (#4ecca3)
Y='\033[1;33m'             # yellow
C='\033[0;36m'             # cyan (for path)
D='\033[2m'                # dim
NC='\033[0m'

out="🍞 ${T}Pekáček${NC} ${D}·${NC} ${C}${short_path}${NC}"
[ -n "$branch" ] && out+=" ${D}·${NC} ${Y}${branch}${NC}"
[ -n "$model" ]  && out+=" ${D}·${NC} ${model}"

printf "%b" "$out"
