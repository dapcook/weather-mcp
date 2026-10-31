#!/usr/bin/env node

/**
 * Weather MCP Server: stdio entry point.
 *
 * AI clients that launch the server as a local command (e.g. Claude Desktop's
 * `node dist/index.js`, or `docker exec -i weather-mcp node dist/index.js`)
 * talk to it over stdin/stdout. For the HTTP /mcp endpoint and the web
 * console, see src/web/server.ts.
 */

// Load environment variables from .env file (for local development)
import 'dotenv/config';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CacheConfig } from './config/cache.js';
import { toolConfig } from './config/tools.js';
import { logger } from './utils/logger.js';
import { createMcpServer, createServices, shutdownServices, SERVER_VERSION } from './mcpServer.js';

async function main() {
  const services = createServices();
  const server = createMcpServer(services);
  const transport = new StdioServerTransport();

  // Set up graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully...`);

    try {
      // Flush analytics and clear caches
      await shutdownServices(services);
      logger.info('Analytics flushed and cache cleared');

      await server.close();
      logger.info('Server closed');

      process.exit(0);
    } catch (error) {
      logger.error('Error during shutdown', error as Error);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  try {
    await server.connect(transport);
    logger.info('Weather MCP Server started', {
      version: SERVER_VERSION,
      transport: 'stdio',
      cacheEnabled: CacheConfig.enabled,
      logLevel: process.env.LOG_LEVEL || 'INFO',
      enabledTools: toolConfig.getEnabledTools().length,
      toolList: toolConfig.getEnabledTools().join(', ')
    });

    // Inform users about version and upgrade options
    logger.info('Version check', {
      installedVersion: SERVER_VERSION,
      latestRelease: 'https://github.com/weather-mcp/weather-mcp/releases/latest',
      upgradeInstructions: 'https://github.com/weather-mcp/weather-mcp#upgrading-to-latest-version',
      autoUpdateTip: 'Use npx -y @dangahagan/weather-mcp@latest in MCP config for automatic updates'
    });
  } catch (error) {
    logger.error('Failed to start server', error as Error);
    throw error;
  }
}

main().catch((error) => {
  logger.error('Fatal error in main()', error);

  // Log structured error for monitoring
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'FATAL',
    message: 'Application failed to start',
    error: {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }
  }));

  process.exit(1);
});
