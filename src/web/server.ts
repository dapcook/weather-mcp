/**
 * Weather MCP web server entry point: the HTTP /mcp endpoint for AI clients
 * plus the web console (tool runner and climate explorer), in one process.
 * See src/web/app.ts for the routes.
 *
 * Usage: npm run web
 *   WEB_HOST, WEB_PORT, WEB_ALLOWED_HOSTS, WEATHER_MCP_TOKEN  see src/web/config.ts
 *   WEATHER_MCP_DATA_DIR  Folder for saved locations (default ~/.weather-mcp)
 *   ENABLED_TOOLS         Tool preset (default here: all)
 */

// Order matters: load .env, then apply defaults, before modules that read the environment
import 'dotenv/config';
import './envDefaults.js';

import { toolConfig } from '../config/tools.js';
import { logger } from '../utils/logger.js';
import { createServices, shutdownServices, SERVER_VERSION } from '../mcpServer.js';
import { startWebServer } from './app.js';
import { loadWebConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadWebConfig();
  const services = createServices();
  const web = await startWebServer(config, services);

  const displayHost = config.host === '0.0.0.0' ? 'localhost' : config.host;
  logger.info(`Weather MCP web server running at http://${displayHost}:${web.port}`, {
    version: SERVER_VERSION,
    listen: `${config.host}:${web.port}`,
    mcpEndpoint: '/mcp',
    allowedHosts: config.allowedHosts.join(', '),
    tokenRequired: Boolean(config.token),
    enabledTools: toolConfig.getEnabledTools().length,
  });
  if (config.host !== '127.0.0.1' && config.host !== 'localhost' && !config.token) {
    logger.warn('Listening beyond this machine without WEATHER_MCP_TOKEN: anyone who can reach it can use every tool', {
      securityEvent: true,
    });
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down gracefully...`);
    try {
      await web.close();
      await shutdownServices(services);
      process.exit(0);
    } catch (error) {
      logger.error('Error during shutdown', error as Error);
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  logger.error('Failed to start web server', error instanceof Error ? error : new Error(String(error)));
  process.exit(1);
});
