/**
 * Local web console for the Weather MCP server.
 *
 * Runs the real MCP server (dist/index.js) as a child process over stdio,
 * connected through the MCP SDK client exactly as an LLM client would be,
 * and exposes it to a browser UI at http://127.0.0.1:<WEB_PORT>.
 *
 * The UI builds each tool's form from its MCP inputSchema, so new tools and
 * parameters show up without any changes here.
 *
 * Usage: npm run web
 *   WEB_PORT       Port to listen on (1024-65535, default: 8787)
 *   ENABLED_TOOLS  Tool preset passed to the MCP server (default: all)
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LocationStore } from '../services/locationStore.js';
import { NominatimService } from '../services/nominatim.js';
import { formatErrorForUser } from '../errors/ApiError.js';
import { logger } from '../utils/logger.js';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const MAX_BODY_BYTES = 64 * 1024;
// NOMADS model comparisons download several GRIB files and can take a while
const TOOL_CALL_TIMEOUT_MS = 180_000;
const GEOCODE_RESULT_LIMIT = 6;

const moduleDir = dirname(fileURLToPath(import.meta.url)); // dist/web
const MCP_SERVER_ENTRY = join(moduleDir, '..', 'index.js'); // dist/index.js
const PAGE_PATH = join(moduleDir, '..', '..', 'web', 'index.html');

const PORT = parsePort(process.env.WEB_PORT);
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);

const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
    "img-src https: data:; connect-src 'self'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function parsePort(value: string | undefined): number {
  if (!value) {
    return DEFAULT_PORT;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`WEB_PORT must be an integer between 1024 and 65535 (got "${value}")`);
  }
  return port;
}

// ---------------------------------------------------------------------------
// MCP client (child process), connected lazily and reconnected if it exits
// ---------------------------------------------------------------------------

let clientPromise: Promise<Client> | null = null;
let knownToolNames: Set<string> | null = null;

function getClient(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = connectClient().catch((error: unknown) => {
      clientPromise = null;
      throw error;
    });
  }
  return clientPromise;
}

async function connectClient(): Promise<Client> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env.ENABLED_TOOLS = process.env.ENABLED_TOOLS ?? 'all';

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_SERVER_ENTRY],
    env,
    stderr: 'inherit',
  });

  const client = new Client({ name: 'weather-mcp-web-console', version: '1.0.0' });
  client.onclose = () => {
    logger.warn('MCP server connection closed; will reconnect on next request');
    clientPromise = null;
    knownToolNames = null;
  };

  await client.connect(transport);
  logger.info('Connected to MCP server', { entry: MCP_SERVER_ENTRY, enabledTools: env.ENABLED_TOOLS });
  return client;
}

async function listTools() {
  const client = await getClient();
  const { tools } = await client.listTools();
  knownToolNames = new Set(tools.map((tool) => tool.name));
  return tools;
}

async function isKnownTool(name: string): Promise<boolean> {
  if (!knownToolNames) {
    await listTools();
  }
  return knownToolNames?.has(name) ?? false;
}

// ---------------------------------------------------------------------------
// Location helpers (read directly so the UI gets structured JSON)
// ---------------------------------------------------------------------------

const locationStore = new LocationStore();
let nominatimService: NominatimService | null = null;

function getSavedLocations() {
  // The MCP child process writes this file on save/remove, so always re-read it
  locationStore.invalidateCache();
  const store = locationStore.getAll();
  return Object.entries(store)
    .map(([alias, location]) => ({
      alias,
      name: location.name,
      latitude: location.latitude,
      longitude: location.longitude,
      admin1: location.admin1,
      country_code: location.country_code,
    }))
    .sort((a, b) => a.alias.localeCompare(b.alias));
}

async function geocode(query: string) {
  nominatimService ??= new NominatimService();
  const response = await nominatimService.searchLocation(query, GEOCODE_RESULT_LIMIT);
  return (response.results ?? []).map((result) => ({
    name: result.name,
    latitude: result.latitude,
    longitude: result.longitude,
    admin1: result.admin1,
    country: result.country,
    country_code: result.country_code,
  }));
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const contentType = req.headers['content-type'] ?? '';
  if (!contentType.startsWith('application/json')) {
    throw new HttpError(415, 'Content-Type must be application/json');
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, 'Request body too large');
    }
    chunks.push(buffer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON');
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Only answer requests addressed to this loopback server (blocks DNS rebinding)
 * and, for browser requests, only from this page's own origin (blocks other
 * sites from driving save_location/remove_saved_location via CSRF).
 */
function checkRequestOrigin(req: IncomingMessage): void {
  if (!ALLOWED_HOSTS.has(req.headers.host ?? '')) {
    logger.warn('Rejected request with unexpected Host header', { host: req.headers.host, securityEvent: true });
    throw new HttpError(403, 'Forbidden host');
  }
  const origin = req.headers.origin;
  if (origin !== undefined && !ALLOWED_ORIGINS.has(origin)) {
    logger.warn('Rejected cross-origin request', { origin, securityEvent: true });
    throw new HttpError(403, 'Forbidden origin');
  }
}

async function handleCall(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  if (!isPlainObject(body) || typeof body.name !== 'string') {
    throw new HttpError(400, 'Body must be {"name": string, "arguments": object}');
  }
  const args = body.arguments ?? {};
  if (!isPlainObject(args)) {
    throw new HttpError(400, '"arguments" must be an object');
  }
  if (!(await isKnownTool(body.name))) {
    throw new HttpError(404, `Unknown or disabled tool: ${body.name}`);
  }

  const client = await getClient();
  const started = Date.now();
  const result = await client.callTool({ name: body.name, arguments: args }, undefined, {
    timeout: TOOL_CALL_TIMEOUT_MS,
  });
  sendJson(res, 200, {
    content: result.content,
    isError: result.isError === true,
    elapsedMs: Date.now() - started,
  });
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  checkRequestOrigin(req);
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    // Read on every request so edits to the page show up on refresh
    const page = await readFile(PAGE_PATH, 'utf8');
    res.writeHead(200, PAGE_HEADERS);
    res.end(page);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/tools') {
    sendJson(res, 200, { tools: await listTools() });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/call') {
    await handleCall(req, res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/saved-locations') {
    sendJson(res, 200, { locations: getSavedLocations() });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/geocode') {
    const query = (url.searchParams.get('q') ?? '').trim();
    sendJson(res, 200, { results: await geocode(query) });
    return;
  }

  throw new HttpError(404, 'Not found');
}

const server = createServer((req, res) => {
  route(req, res).catch((error: unknown) => {
    if (error instanceof HttpError) {
      sendJson(res, error.status, { error: error.message });
      return;
    }
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Web console request failed', err, { path: req.url });
    sendJson(res, 500, { error: formatErrorForUser(err) });
  });
});

server.listen(PORT, HOST, () => {
  logger.info(`Weather MCP web console running at http://${HOST}:${PORT}`);
  // Start the MCP server now so startup problems surface immediately
  getClient().catch((error: unknown) => {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('Failed to start MCP server (did you run `npm run build`?)', err);
  });
});

async function shutdown(): Promise<void> {
  server.close();
  if (clientPromise) {
    try {
      await (await clientPromise).close();
    } catch {
      // Already closed
    }
  }
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
