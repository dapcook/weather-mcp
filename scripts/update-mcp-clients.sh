#!/usr/bin/env bash
# Update local AI client MCP configurations (Claude Desktop, Claude Code,
# Gemini CLI, Antigravity, Cursor, Codex) to point "weather" at a remote
# Weather MCP HTTP endpoint (e.g. Raspberry Pi).
#
# Usage:
#   ./scripts/update-mcp-clients.sh --url http://10.0.0.103:3003/mcp --token <token>
#   ./scripts/update-mcp-clients.sh --from-pi dcook@10.0.0.103
#   ./scripts/update-mcp-clients.sh --dry-run --from-pi dcook@10.0.0.103

set -euo pipefail

URL="${WEATHER_MCP_URL:-http://10.0.0.103:3003/mcp}"
TOKEN="${WEATHER_MCP_TOKEN:-}"
PI_SSH=""
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --url)      URL="$2"; shift 2 ;;
    --token)    TOKEN="$2"; shift 2 ;;
    --from-pi)  PI_SSH="$2"; shift 2 ;;
    --dry-run)  DRY_RUN=1; shift ;;
    -h|--help)
      sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

if [ -n "$PI_SSH" ] && [ -z "$TOKEN" ]; then
  HOST_PART="${PI_SSH#*@}"
  URL="http://${HOST_PART}:3003/mcp"
  echo "Fetching WEATHER_MCP_TOKEN from $PI_SSH..."
  TOKEN=$(ssh -o BatchMode=yes "$PI_SSH" "grep '^WEATHER_MCP_TOKEN=' ~/WeatherMCP/.env | cut -d= -f2-")
fi

if [ -z "$TOKEN" ]; then
  echo "Error: provide --token <token>, set WEATHER_MCP_TOKEN, or pass --from-pi <user@host>." >&2
  exit 1
fi

STAMP=$(date +%Y%m%d-%H%M%S)
export WEATHER_CFG_URL="$URL"
export WEATHER_CFG_TOKEN="$TOKEN"
export WEATHER_CFG_DRY="$DRY_RUN"
export WEATHER_CFG_STAMP="$STAMP"

if pgrep -xq "Claude" 2>/dev/null; then
  echo "Warning: Claude Desktop appears to be running. Quit it (Cmd+Q) so it doesn't overwrite claude_desktop_config.json."
fi

node - <<'NODE'
const fs = require('fs');
const os = require('os');
const path = require('path');

const url = process.env.WEATHER_CFG_URL;
const token = process.env.WEATHER_CFG_TOKEN;
const dryRun = process.env.WEATHER_CFG_DRY === '1';
const stamp = process.env.WEATHER_CFG_STAMP;
const home = os.homedir();
const isLocalHttp = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(url);

const claudeDesktopArgs = ['-y', 'mcp-remote@0.14.3', url];
if (url.startsWith('http://') && !isLocalHttp) {
  claudeDesktopArgs.push('--allow-http');
}
claudeDesktopArgs.push('--header', 'Authorization:${WEATHER_AUTH}');

const targets = [
  {
    name: 'Claude Desktop',
    file: path.join(home, 'Library/Application Support/Claude/claude_desktop_config.json'),
    entry: {
      command: 'npx',
      args: claudeDesktopArgs,
      env: { WEATHER_AUTH: `Bearer ${token}` },
    },
  },
  {
    name: 'Claude Code',
    file: path.join(home, '.claude.json'),
    entry: {
      type: 'http',
      url,
      headers: { Authorization: `Bearer ${token}` },
    },
  },
  {
    name: 'Gemini CLI',
    file: path.join(home, '.gemini/settings.json'),
    entry: {
      type: 'http',
      url,
      headers: { Authorization: `Bearer ${token}` },
    },
  },
  {
    name: 'Antigravity',
    file: path.join(home, '.gemini/antigravity/mcp_config.json'),
    entry: {
      serverUrl: url,
      headers: { Authorization: `Bearer ${token}` },
    },
  },
  {
    name: 'Cursor',
    file: path.join(home, '.cursor/mcp.json'),
    entry: {
      url,
      headers: { Authorization: `Bearer ${token}` },
    },
  },
];

for (const t of targets) {
  if (!fs.existsSync(t.file)) {
    console.log(`- Skipping ${t.name} (${t.file} not found)`);
    continue;
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(t.file, 'utf8'));
  } catch (err) {
    console.error(`! Failed to parse ${t.name} (${t.file}): ${err.message}`);
    continue;
  }
  if (!data.mcpServers || typeof data.mcpServers !== 'object') {
    data.mcpServers = {};
  }
  data.mcpServers.weather = t.entry;
  const output = JSON.stringify(data, null, 2) + '\n';

  if (dryRun) {
    console.log(`[dry-run] Would update ${t.name}: ${t.file}`);
    continue;
  }

  const backup = `${t.file}.bak.${stamp}`;
  fs.copyFileSync(t.file, backup);
  fs.writeFileSync(t.file, output, 'utf8');
  console.log(`✓ Updated ${t.name} (${t.file}) [backup: ${path.basename(backup)}]`);
}
NODE

# Update Codex TOML if present
CODEX_TOML="$HOME/.codex/config.toml"
if [ -f "$CODEX_TOML" ] && [ -n "$PI_SSH" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] Would update Codex ($CODEX_TOML) to SSH stdio via $PI_SSH"
  else
    cp "$CODEX_TOML" "${CODEX_TOML}.bak.${STAMP}"
    PI_SSH_TARGET="$PI_SSH" node - "$CODEX_TOML" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const sshTarget = process.env.PI_SSH_TARGET;
let text = fs.readFileSync(file, 'utf8');
const replacement =
  `[mcp_servers.weather]\n` +
  `enabled = true\n` +
  `command = "ssh"\n` +
  `args = [ "${sshTarget}", "docker", "exec", "-i", "weather-mcp", "node", "dist/index.js" ]\n`;
const re = /\[mcp_servers\.weather\][\s\S]*?(?=\n\[|$)/;
if (re.test(text)) {
  text = text.replace(re, replacement.trimEnd());
} else {
  text = text.trimEnd() + '\n\n' + replacement;
}
fs.writeFileSync(file, text, 'utf8');
console.log(`✓ Updated Codex (${file}) [SSH stdio via ${sshTarget}]`);
NODE
  fi
elif [ -f "$CODEX_TOML" ]; then
  echo "- Codex ($CODEX_TOML) skipped (pass --from-pi <user@host> to configure SSH stdio)"
fi

echo "Done. Target endpoint: $URL"
