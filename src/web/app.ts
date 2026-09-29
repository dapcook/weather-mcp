/**
 * HTTP server for the Weather MCP server: one process serving AI clients and
 * people, sharing one set of services (caches, saved locations).
 *
 *   /mcp      Streamable HTTP MCP endpoint for AI clients (stateless)
 *   /         Web console page
 *   /api/*    Console API: tool list/calls (through an in-process MCP client,
 *             so the console runs the same code path AI clients do), saved
 *             locations, place search, and the climate explorer's data
 *   /health   Liveness check for Docker
 *
 * Every request must use an allowed hostname (DNS-rebinding protection) and, if
 * from a browser, an allowed origin (CSRF protection). When a token is
 * configured, /mcp and /api/* also require "Authorization: Bearer <token>".
 */

import { createServer, IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer, SERVER_VERSION, WeatherServices } from '../mcpServer.js';
import { formatErrorForUser } from '../errors/ApiError.js';
import { logger } from '../utils/logger.js';
import { computeClimatology, packSeries, parseBaseline } from '../utils/climatology.js';
import { validateLatitude, validateLongitude } from '../utils/validation.js';
import { hasValidToken, isAllowedHost, isAllowedOrigin } from './access.js';
import type { WebConfig } from './config.js';

const MAX_BODY_BYTES = 64 * 1024;
// NOMADS model comparisons download several GRIB files and can take a while
const TOOL_CALL_TIMEOUT_MS = 180_000;
const GEOCODE_RESULT_LIMIT = 6;
// Open-Meteo's archive (ERA5) starts in 1940
const CLIMATE_RECORD_START = '1940-01-01';
const DEFAULT_BASELINE = '1991-2020';

const DEFAULT_PAGE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'index.html');

const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
    "img-src https: data:; connect-src 'self'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

export interface WebServerOptions {
  /** Console page to serve (default: web/index.html in the package) */
  pagePath?: string;
}

export interface RunningWebServer {
  server: HttpServer;
  /** Actual port (useful when configured with port 0 in tests) */
  port: number;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly headers: Record<string, string> = {}) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    ...headers,
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

/**
 * Request path for logs, without the query string: queries carry coordinates
 * (/api/climate) and place names (/api/geocode), which the project keeps out of logs.
 */
function pathForLog(url: string | undefined): string {
  return (url ?? '').split('?')[0];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCoordinate(value: string | null, name: string, validate: (v: unknown) => void): number {
  const number = value === null || value.trim() === '' ? NaN : Number(value);
  if (!Number.isFinite(number)) {
    throw new HttpError(400, `${name} must be a number`);
  }
  try {
    validate(number);
  } catch (error) {
    throw new HttpError(400, `Invalid ${name}: ${(error as Error).message.replace(/^Invalid \w+: /, '')}`);
  }
  // ~1 km; the reanalysis grid is ~25 km, so nearby clicks can share a cache entry
  return Math.round(number * 100) / 100;
}

export async function startWebServer(
  config: WebConfig,
  services: WeatherServices,
  options: WebServerOptions = {}
): Promise<RunningWebServer> {
  const pagePath = options.pagePath ?? DEFAULT_PAGE_PATH;
  const startedAt = Date.now();

  // The console talks MCP to its own in-process server, like any AI client
  const consoleServer = createMcpServer(services);
  const consoleClient = new Client({ name: 'weather-mcp-web-console', version: SERVER_VERSION });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await consoleServer.connect(serverTransport);
  await consoleClient.connect(clientTransport);

  let toolCache: { tools: Tool[]; names: Set<string> } | null = null;
  async function listTools() {
    if (!toolCache) {
      const { tools } = await consoleClient.listTools();
      toolCache = { tools, names: new Set(tools.map((tool) => tool.name)) };
    }
    return toolCache;
  }

  function checkAccess(req: IncomingMessage, needsToken: boolean): void {
    if (!isAllowedHost(req.headers.host, config.allowedHosts)) {
      logger.warn('Rejected request with unexpected Host header', { host: req.headers.host, securityEvent: true });
      throw new HttpError(403, 'Forbidden host');
    }
    if (!isAllowedOrigin(req.headers.origin, config.allowedHosts)) {
      logger.warn('Rejected cross-origin request', { origin: req.headers.origin, securityEvent: true });
      throw new HttpError(403, 'Forbidden origin');
    }
    if (needsToken && !hasValidToken(req.headers.authorization, config.token)) {
      logger.warn('Rejected request without a valid token', { path: pathForLog(req.url), securityEvent: true });
      throw new HttpError(401, 'Missing or invalid access token', { 'WWW-Authenticate': 'Bearer realm="weather-mcp"' });
    }
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      // Stateless server: no standalone SSE stream (GET) or sessions (DELETE)
      sendJson(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }, { Allow: 'POST' });
      return;
    }
    // A fresh server + transport per request; services (and caches) are shared
    const server = createMcpServer(services);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }

  async function handleApiCall(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req);
    if (!isPlainObject(body) || typeof body.name !== 'string') {
      throw new HttpError(400, 'Body must be {"name": string, "arguments": object}');
    }
    const args = body.arguments ?? {};
    if (!isPlainObject(args)) {
      throw new HttpError(400, '"arguments" must be an object');
    }
    if (!(await listTools()).names.has(body.name)) {
      throw new HttpError(404, `Unknown or disabled tool: ${body.name}`);
    }

    const started = Date.now();
    const result = await consoleClient.callTool({ name: body.name, arguments: args }, undefined, {
      timeout: TOOL_CALL_TIMEOUT_MS,
    });
    sendJson(res, 200, {
      content: result.content,
      isError: result.isError === true,
      elapsedMs: Date.now() - started,
    });
  }

  function savedLocations() {
    // Another process (e.g. `docker exec ... node dist/index.js`) may have written the file
    services.locationStore.invalidateCache();
    return Object.entries(services.locationStore.getAll())
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
    const response = await services.nominatimService.searchLocation(query, GEOCODE_RESULT_LIMIT);
    return (response.results ?? []).map((result) => ({
      name: result.name,
      latitude: result.latitude,
      longitude: result.longitude,
      admin1: result.admin1,
      country: result.country,
      country_code: result.country_code,
    }));
  }

  // Climate explorer: the full daily record for a point plus its climatology
  async function getClimate(params: URLSearchParams) {
    const latitude = parseCoordinate(params.get('latitude'), 'latitude', validateLatitude);
    const longitude = parseCoordinate(params.get('longitude'), 'longitude', validateLongitude);

    // Two days back in UTC is a complete local day in every timezone
    const endDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const lastFullYear = Number(endDate.slice(0, 4)) - 1;
    const baselineParam = params.get('baseline') ?? DEFAULT_BASELINE;
    const baseline = parseBaseline(baselineParam, Number(CLIMATE_RECORD_START.slice(0, 4)), lastFullYear);
    if (!baseline) {
      throw new HttpError(400, `Invalid baseline "${baselineParam}": use YYYY-YYYY, at least 10 years, 1940-${lastFullYear}`);
    }

    const record = await services.openMeteoService.getDailyTemperatureRecord(latitude, longitude, CLIMATE_RECORD_START, endDate);
    const daily = record.daily!; // validated by the service
    const input = {
      time: daily.time,
      high: daily.temperature_2m_max ?? [],
      low: daily.temperature_2m_min ?? [],
      precipitation: daily.precipitation_sum ?? [],
    };

    return {
      location: {
        latitude: record.latitude,
        longitude: record.longitude,
        elevation: record.elevation,
        timezone: record.timezone,
      },
      units: { temperature: '°F', precipitation: 'in' },
      source: 'Open-Meteo Historical Weather API (ERA5 reanalysis)',
      start: daily.time[0],
      end: daily.time[daily.time.length - 1],
      high: packSeries(input.high),
      low: packSeries(input.low),
      precipitation: packSeries(input.precipitation, 2),
      climatology: computeClimatology(input, baseline),
    };
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (path === '/health') {
      checkAccess(req, false);
      sendJson(res, 200, { status: 'ok', version: SERVER_VERSION, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) });
      return;
    }

    if (path === '/mcp') {
      checkAccess(req, true);
      await handleMcp(req, res);
      return;
    }

    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      // The page holds no data; the API calls it makes are what need the token
      checkAccess(req, false);
      // Read on every request so edits to the page show up on refresh
      const page = await readFile(pagePath, 'utf8');
      res.writeHead(200, PAGE_HEADERS);
      res.end(page);
      return;
    }

    if (path.startsWith('/api/')) {
      checkAccess(req, true);

      if (req.method === 'GET' && path === '/api/tools') {
        sendJson(res, 200, { tools: (await listTools()).tools });
        return;
      }
      if (req.method === 'POST' && path === '/api/call') {
        await handleApiCall(req, res);
        return;
      }
      if (req.method === 'GET' && path === '/api/saved-locations') {
        sendJson(res, 200, { locations: savedLocations() });
        return;
      }
      if (req.method === 'GET' && path === '/api/geocode') {
        sendJson(res, 200, { results: await geocode((url.searchParams.get('q') ?? '').trim()) });
        return;
      }
      if (req.method === 'GET' && path === '/api/climate') {
        sendJson(res, 200, await getClimate(url.searchParams));
        return;
      }
    }

    checkAccess(req, false);
    throw new HttpError(404, 'Not found');
  }

  const server = createServer((req, res) => {
    route(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message }, error.headers);
        return;
      }
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('Web request failed', err, { path: pathForLog(req.url) });
      sendJson(res, 500, { error: formatErrorForUser(err) });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    server,
    port: (server.address() as AddressInfo).port,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await consoleClient.close();
      await consoleServer.close();
    },
  };
}
