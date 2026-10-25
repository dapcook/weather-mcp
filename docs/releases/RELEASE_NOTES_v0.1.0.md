## Weather MCP Server v0.1.0

Initial public release of the Weather MCP Server - a Model Context Protocol server providing comprehensive weather data with no API keys required!

### Features

- 🌤️ **Weather Forecasts** (7-day) for US locations via NOAA API
- 🌡️ **Current Conditions** for US locations via NOAA API
- 📊 **Historical Weather Data** (1940-present) globally via Open-Meteo API
- 🔍 **Service Status Checking** with proactive health monitoring
- ⚡ **Enhanced Error Handling** with actionable guidance and status page links
- 🔑 **No API Keys Required** - completely free to use

### Installation

#### Via npm (Recommended)
```bash
npm install -g @dangahagan/weather-mcp
```

#### Via npx (No installation)
```bash
npx -y @dangahagan/weather-mcp
```

#### From source
```bash
git clone https://github.com/weather-mcp/weather-mcp.git
cd weather-mcp
npm install
npm run build
```

### Usage

Add to your MCP client configuration:

**Claude Code** (`~/.config/claude-code/mcp_settings.json`):
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

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):
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

See [CLIENT_SETUP.md](../CLIENT_SETUP.md) for setup instructions for all supported clients.

### What's New in v0.1.0

- ✅ Initial public release
- ✅ NOAA Weather API integration for US forecasts and current conditions
- ✅ Open-Meteo API integration for global historical weather data
- ✅ Service status checking tool (`check_service_status`)
- ✅ Enhanced error handling with status page links
- ✅ Support for 8+ MCP clients (Claude Code, Claude Desktop, Cline, Cursor, Zed, VS Code Copilot, LM Studio, Postman)
- ✅ Comprehensive documentation and testing
- ✅ MCP best practices implementation

### Available Tools

1. **check_service_status** - Check operational status of weather APIs
2. **get_forecast** - Get 7-day weather forecasts (US locations)
3. **get_current_conditions** - Get current weather (US locations)
4. **get_historical_weather** - Get historical weather data (1940-present, global)

### Documentation

- [README.md](../../README.md) - Main documentation
- [CLIENT_SETUP.md](../CLIENT_SETUP.md) - Setup for various AI assistants
- [ERROR_HANDLING.md](../ERROR_HANDLING.md) - Error handling documentation
- [MCP_BEST_PRACTICES.md](../MCP_BEST_PRACTICES.md) - MCP implementation guide
- [CHANGELOG.md](./CHANGELOG.md) - Detailed changelog

### Requirements

- Node.js 18 or higher
- No API keys or tokens required

### Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

### License

MIT License - see [LICENSE](../../LICENSE) for details

---

**Links:**
- 📦 npm package: https://www.npmjs.com/package/@dangahagan/weather-mcp
- 🐙 Repository: https://github.com/weather-mcp/weather-mcp
- 📝 Issues: https://github.com/weather-mcp/weather-mcp/issues
- 📖 Documentation: https://github.com/weather-mcp/weather-mcp#readme
