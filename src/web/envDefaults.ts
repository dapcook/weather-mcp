/**
 * Defaults for the web server's process environment.
 *
 * Imported by src/web/server.ts before any module that reads these variables
 * (config/tools.ts reads ENABLED_TOOLS once, at import). Runs after
 * dotenv/config, so values from the environment or a .env file still win.
 */

// The console is for trying every tool, so expose all of them unless configured otherwise
process.env.ENABLED_TOOLS ??= 'all';
