# Client Setup Guide

This guide covers how to set up the Weather MCP Server with various AI assistants and code editors that support the Model Context Protocol (MCP).

**Remember:** No API keys required for this server! Both NOAA and Open-Meteo APIs are free to use.

## Prerequisites

Before setting up with any client, you need **Node.js 18 or higher** installed.

## Installation Options

You have two options for installing the Weather MCP Server:

### Option 1: Via npm/npx (Recommended)

**No installation needed** - Use npx to run the server:
```bash
npx -y @dangahagan/weather-mcp
```

Or install globally:
```bash
npm install -g @dangahagan/weather-mcp
```

### Option 2: From Source

Clone and build from source:
```bash
git clone https://github.com/weather-mcp/weather-mcp.git
cd weather-mcp
npm install
npm run build
```

Then note the absolute path to your `weather-mcp/dist/index.js` file.

---

## Claude Desktop

**Platform:** macOS, Windows, Linux
**Official Docs:** https://modelcontextprotocol.io/docs/develop/connect-local-servers

### Configuration File Location

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

### Quick Setup

1. Open Claude Desktop Settings from the menu bar (Claude > Settings...)
2. Go to the **Developer** tab
3. Click **Edit Config** to open the configuration file
4. Add the weather server configuration:

**Using npx (recommended):**
```json
{
  "mcpServers": {
    "weather": {
      "command": "npx",
      "args": ["-y", "@dangahagan/weather-mcp"]
    }
  }
}
```

**Or from source (if you built manually):**
```json
{
  "mcpServers": {
    "weather": {
      "command": "node",
      "args": ["/absolute/path/to/weather-mcp/dist/index.js"]
    }
  }
}
```

5. Save the file and **restart Claude Desktop**
6. Look for the 🔌 MCP icon in the chat interface to confirm the server is connected

---

## Claude Code (CLI)

**Platform:** macOS, Windows, Linux
**Official Docs:** https://docs.claude.com/docs/claude-code

### Configuration File Location

- **macOS/Linux:** `~/.config/claude-code/mcp_settings.json`
- **Windows:** `%APPDATA%\claude-code\mcp_settings.json`

### Setup Instructions

1. Create or edit the `mcp_settings.json` file at the location above
2. Add the weather server configuration:

**Using npx (recommended):**
```json
{
  "mcpServers": {
    "weather": {
      "command": "npx",
      "args": ["-y", "@dangahagan/weather-mcp"]
    }
  }
}
```

**Or from source (if you built manually):**
```json
{
  "mcpServers": {
    "weather": {
      "command": "node",
      "args": ["/absolute/path/to/weather-mcp/dist/index.js"]
    }
  }
}
```

3. Restart Claude Code
4. The weather tools will be automatically available in your session

---

## Cline (VS Code Extension)

**Platform:** VS Code on macOS, Windows, Linux
**Extension:** https://marketplace.visualstudio.com/items?itemName=saoudrizwan.claude-dev
**Official Docs:** https://docs.cline.bot/mcp/configuring-mcp-servers

### Setup Instructions

1. Install the Cline extension in VS Code
2. Open the Cline panel in VS Code
3. Click the **MCP Servers** icon at the top navigation bar
4. Click **Configure MCP Servers** button (opens `cline_mcp_settings.json`)
5. Add the weather server configuration:

```json
{
  "mcpServers": {
    "weather": {
      "command": "node",
      "args": ["/absolute/path/to/weather-mcp/dist/index.js"],
      "disabled": false
    }
  }
}
```

6. Save the file - Cline will automatically reload the configuration
7. The weather tools will appear in Cline's MCP tools list

### Optional: Allow Tools Without Confirmation

To enable specific tools to run without asking for permission each time:

```json
{
  "mcpServers": {
    "weather": {
      "command": "node",
      "args": ["/absolute/path/to/weather-mcp/dist/index.js"],
      "alwaysAllow": ["get_forecast", "get_current_conditions", "get_historical_weather"],
      "disabled": false
    }
  }
}
```

---

## Cursor

**Platform:** macOS, Windows, Linux
**Website:** https://cursor.com
**Docs:** Uses VS Code-compatible MCP configuration

### Setup Instructions

#### Method 1: Using Cursor Settings (Recommended)

1. Open Cursor
2. Go to **Settings** (Cmd/Ctrl + ,)
3. Navigate to **Tools & Integrations**
4. Click **New MCP Server**
5. Enter the configuration:
   - **Name:** `weather`
   - **Command:** `node`
   - **Args:** `/absolute/path/to/weather-mcp/dist/index.js`

#### Method 2: Manual Configuration File

1. Create or edit `~/.cursor/mcp.json`
2. Add the weather server configuration:

```json
{
  "mcpServers": {
    "weather": {
      "command": "node",
      "args": ["/absolute/path/to/weather-mcp/dist/index.js"]
    }
  }
}
```

3. Restart Cursor
4. The weather tools will be available globally across all projects

---

## Zed Editor

**Platform:** macOS, Windows, Linux
**Website:** https://zed.dev
**Official Docs:** https://zed.dev/docs/ai/mcp

**Note:** MCP support in Zed is currently in preview. You may need to use Zed Preview for full MCP functionality.

### Setup Instructions

#### Method 1: Using Zed Settings UI

1. Open Zed
2. Go to **Settings** (Cmd/Ctrl + ,)
3. Navigate to **AI** settings
4. Find the **Context Servers** section
5. Click **+ Add Context Server**
6. Enter the configuration:
   - **Name:** `weather`
   - **Command:** `node`
   - **Args:** `/absolute/path/to/weather-mcp/dist/index.js`

#### Method 2: Manual Settings Configuration

1. Open Zed settings (Cmd/Ctrl + ,)
2. Switch to the JSON view
3. Add the `context_servers` section:

```json
{
  "context_servers": {
    "weather": {
      "settings": {},
      "command": {
        "path": "node",
        "args": ["/absolute/path/to/weather-mcp/dist/index.js"]
      }
    }
  }
}
```

4. Save and restart Zed
5. Open the **Agent Panel** and check the settings view
6. Verify the indicator dot next to "weather" is **green** (server is active)

---

## VS Code (GitHub Copilot)

**Platform:** macOS, Windows, Linux
**Extension:** GitHub Copilot with MCP support
**Official Docs:** https://code.visualstudio.com/docs/copilot/chat/mcp-servers

### Setup Instructions

1. Ensure you have the latest version of GitHub Copilot extension
2. Open VS Code settings (Cmd/Ctrl + ,)
3. Search for "MCP" or navigate to Extensions > GitHub Copilot
4. Configure MCP servers in one of these locations:
   - **User settings:** Available in all workspaces
   - **Workspace settings:** Specific to current project

5. Add the weather server configuration to settings.json:

```json
{
  "github.copilot.chat.mcp.servers": {
    "weather": {
      "command": "node",
      "args": ["/absolute/path/to/weather-mcp/dist/index.js"]
    }
  }
}
```

6. Reload VS Code
7. The weather tools will be available in Copilot Chat

---

## LM Studio

**Platform:** macOS, Windows, Linux
**Website:** https://lmstudio.ai

### Setup Instructions

1. Open LM Studio
2. Navigate to the **MCP Settings** or **Tools** section
3. Look for an `mcp.json` configuration file or MCP server settings
4. Add the weather server configuration:

```json
{
  "mcpServers": {
    "weather": {
      "command": "node",
      "args": ["/absolute/path/to/weather-mcp/dist/index.js"]
    }
  }
}
```

5. Save and restart LM Studio
6. When the AI makes a tool call, you'll see a confirmation UI before execution

---

## Postman

**Platform:** Desktop app or web
**Website:** https://www.postman.com

Postman can integrate with existing MCP config files from Claude, VS Code, and other clients.

### Setup Instructions

1. Open Postman
2. Navigate to the **AI Integration** or **MCP** section
3. Import your existing MCP configuration file, or create a new one
4. Add the weather server configuration:

```json
{
  "mcpServers": {
    "weather": {
      "command": "node",
      "args": ["/absolute/path/to/weather-mcp/dist/index.js"]
    }
  }
}
```

5. Postman will automatically detect available tools, prompts, and resources

---

## Connecting to a Remote Server (HTTP)

The setups above launch the server on the same computer as your AI client. You can instead run it once on another machine, such as a Raspberry Pi (see **[Running in Docker](./DOCKER.md)**), and connect every client to it over your network.

Every client needs the same three things:

| | |
|---|---|
| **URL** | `http://<host>:3003/mcp` (for example `http://raspberrypi.local:3003/mcp`) |
| **Transport** | Streamable HTTP |
| **Header** | `Authorization: Bearer <your token>` (the server's `WEATHER_MCP_TOKEN`) |

> **Replace `<token>` with the real value** in every example below. A leftover placeholder is the most common reason for a `401` error.
>
> **Tested with:** Claude Code and Claude Desktop (through `mcp-remote`). The Cursor and VS Code examples follow those clients' documented formats but haven't been tested here.

### Claude Code

```bash
claude mcp add --transport http --scope user weather http://raspberrypi.local:3003/mcp --header "Authorization: Bearer <token>"
```

Check it with `claude mcp list`; `weather` should show **✔ Connected**. To share a server with a project without putting the token in git, add a `.mcp.json` that reads it from an environment variable:

```json
{
  "mcpServers": {
    "weather": {
      "type": "http",
      "url": "http://raspberrypi.local:3003/mcp",
      "headers": { "Authorization": "Bearer ${WEATHER_MCP_TOKEN}" }
    }
  }
}
```

### Claude Desktop

Claude Desktop's config file can only launch local programs, so the [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) bridge relays to the server. In `claude_desktop_config.json` (see [Claude Desktop](#claude-desktop) for its location), replace or add the `weather` entry:

```json
{
  "mcpServers": {
    "weather": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote@0.14.3",
        "http://raspberrypi.local:3003/mcp",
        "--allow-http",
        "--header", "Authorization:${WEATHER_AUTH}"
      ],
      "env": { "WEATHER_AUTH": "Bearer <token>" }
    }
  }
}
```

Then fully quit and reopen Claude Desktop (<kbd>Cmd</kbd>+<kbd>Q</kbd> on macOS).

- `--allow-http` is needed because `mcp-remote` only accepts plain `http://` for localhost unless told otherwise. If you serve the console over HTTPS (for example with Tailscale), use the `https://` address and drop that flag.
- The token sits in `env`, and the header has no space after the colon, so the space inside `Bearer <token>` can't split the argument.
- `mcp-remote@0.14.3` is the version tested here; pinning a version keeps `npx` from picking up changes unexpectedly.
- To confirm the connection, look for *"Proxy established successfully"* in the log (macOS: `~/Library/Logs/Claude/mcp-server-weather.log`).

### Cursor

In `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "weather": {
      "url": "http://raspberrypi.local:3003/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

### VS Code (GitHub Copilot)

In `.vscode/mcp.json`. VS Code asks for the token once and stores it securely, so it never sits in the file:

```json
{
  "inputs": [
    { "type": "promptString", "id": "weather-token", "description": "Weather MCP token", "password": true }
  ],
  "servers": {
    "weather": {
      "type": "http",
      "url": "http://raspberrypi.local:3003/mcp",
      "headers": { "Authorization": "Bearer ${input:weather-token}" }
    }
  }
}
```

### Any other client

- **Clients that only launch local commands:** use the same `mcp-remote` command and `env` as the Claude Desktop example.
- **No token or bridge:** run the server inside the container over SSH. Your SSH key is the credential:

```json
"weather": {
  "command": "ssh",
  "args": ["<user>@raspberrypi.local", "docker", "exec", "-i", "weather-mcp", "node", "dist/index.js"]
}
```

### Things to know

- **Use one `weather` entry per client.** If a client has both a local and a remote entry under different names, it sees two copies of every tool.
- **Treat client config files like password files.** Claude Desktop and Cursor store the token in plain text.
- **Claude on the web and mobile apps can't use this.** Their custom connectors are reached from Anthropic's servers, which would mean exposing your server to the internet.
- **Switching back:** restore the local command entry (`npx -y @dangahagan/weather-mcp` or `node .../dist/index.js`).

---

## Testing Your Setup

After configuring any client, test the connection with these simple queries:

1. **Test forecast:**
   > "What's the weather forecast for San Francisco?" (37.7749, -122.4194)

2. **Test current conditions:**
   > "What are the current weather conditions in New York?" (40.7128, -74.0060)

3. **Test historical data:**
   > "What was the weather in Chicago on January 1, 2024?" (41.8781, -87.6298)

---

## Troubleshooting

### Server Not Connecting

1. **Verify the path:** Make sure the path to `dist/index.js` is absolute and correct
2. **Check Node.js:** Ensure Node.js 18+ is installed: `node --version`
3. **Rebuild the project:** Run `npm run build` in the weather-mcp directory
4. **Restart the client:** Most clients need a restart after configuration changes
5. **Check logs:** Look for MCP-related errors in your client's console/logs

### Remote Server Not Connecting

1. **`401` or "Missing or invalid access token":** the token is wrong, or a placeholder such as `Bearer <token>` was left in the config. Compare it with `WEATHER_MCP_TOKEN` in the server's `.env`.
2. **`403 Forbidden host`:** the hostname or IP in your URL isn't in the server's `WEB_ALLOWED_HOSTS`. Add it and run `docker compose up -d`.
3. **Connection refused or timed out:** check that the container is running (`docker compose ps`), that you're on the same network, and that the port matches (`WEATHER_MCP_PORT`).
4. **`.local` name not found:** not every device resolves mDNS names (some Android and Windows setups don't). Use the server's IP address and add it to `WEB_ALLOWED_HOSTS`.
5. **Claude Desktop only:** it must be fully quit and reopened after editing the config, and `npx` must be on the PATH it launches with. The log will say if it couldn't start the command.

### Tools Not Appearing

1. **Look for MCP indicators:** Most clients show an icon or status when MCP servers are connected
2. **Check server status:** In clients with UI (like Zed), verify the server indicator is green
3. **Permissions:** Some clients (like Cline) may require you to approve tool usage first
4. **Configuration syntax:** Verify your JSON configuration is valid (no trailing commas, proper quotes)

### "No historical data available" Errors

- **Recent dates (last 7 days):** Ensure you're using US coordinates
- **Older dates (>7 days):** Should work globally back to 1940
- **Very recent (last 5 days):** May not be available in archival data yet due to 5-day delay

---

## Additional Resources

- **MCP Official Documentation:** https://modelcontextprotocol.io
- **MCP Server Directory:** https://github.com/modelcontextprotocol/servers
- **Find More MCP Servers:**
  - https://smithery.ai
  - https://glama.ai/mcp/servers
  - https://mcpindex.net

---

## Need Help?

If you encounter issues with this MCP server:
1. Check the [main README](./README.md) for API limitations and requirements
2. Review the [Testing Guide](./testing/TESTING_GUIDE.md) for debugging tips
3. Open an issue on GitHub with details about your client and error messages
