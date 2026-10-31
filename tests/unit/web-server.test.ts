/**
 * Web server: /mcp endpoint, console API, health check, and access controls.
 *
 * Starts the real server on an ephemeral loopback port with saved locations in
 * a temp directory. The only tool called is list_saved_locations, so nothing
 * here touches external weather APIs.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createServices, shutdownServices, WeatherServices } from '../../src/mcpServer.js';
import { toolConfig } from '../../src/config/tools.js';
import { startWebServer, RunningWebServer } from '../../src/web/app.js';
import { LOOPBACK_HOSTS } from '../../src/web/config.js';

const TOKEN = 't'.repeat(40);

interface TestServer {
  web: RunningWebServer;
  services: WeatherServices;
  base: string;
  dir: string;
}

async function startTestServer(token?: string): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), 'weather-mcp-web-test-'));
  const services = createServices({ locationsPath: join(dir, 'locations.json') });
  const web = await startWebServer({ host: '127.0.0.1', port: 0, allowedHosts: LOOPBACK_HOSTS, token }, services);
  return { web, services, dir, base: `http://127.0.0.1:${web.port}` };
}

async function stopTestServer(server: TestServer): Promise<void> {
  await server.web.close();
  await shutdownServices(server.services);
  rmSync(server.dir, { recursive: true, force: true });
}

async function connectMcp(base: string, headers: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: 'web-server-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
  return client;
}

/** GET with an arbitrary Host header (fetch doesn't allow overriding it) */
function getWithHost(base: string, path: string, host: string): Promise<number> {
  const url = new URL(path, base);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: url.hostname, port: url.port, path: url.pathname, headers: { Host: host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('web server without a token', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer();
  });
  afterAll(async () => {
    await stopTestServer(server);
  });

  it('reports health', async () => {
    const response = await fetch(`${server.base}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok', version: expect.any(String) });
  });

  it('serves the console page with a restrictive CSP', async () => {
    const response = await fetch(`${server.base}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await response.text()).toContain('<title>');
  });

  it('lets an MCP client list and call tools over /mcp', async () => {
    const client = await connectMcp(server.base);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([...toolConfig.getEnabledTools()].sort());

      const result = await client.callTool({ name: 'list_saved_locations', arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(JSON.stringify(result.content)).toMatch(/saved location/i);
    } finally {
      await client.close();
    }
  });

  it('rejects GET on /mcp (stateless server, no SSE stream)', async () => {
    const response = await fetch(`${server.base}/mcp`);
    expect(response.status).toBe(405);
  });

  it('runs tools for the console through /api/call', async () => {
    const response = await fetch(`${server.base}/api/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: server.base },
      body: JSON.stringify({ name: 'list_saved_locations', arguments: {} }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ isError: false, content: expect.any(Array) });
  });

  it('returns saved locations as JSON for the console', async () => {
    const response = await fetch(`${server.base}/api/saved-locations`);
    expect(await response.json()).toEqual({ locations: [] });
  });

  it('rejects unknown tools, bad bodies, and non-JSON posts', async () => {
    const post = (body: string, contentType = 'application/json') =>
      fetch(`${server.base}/api/call`, { method: 'POST', headers: { 'Content-Type': contentType }, body });
    expect((await post(JSON.stringify({ name: 'rm_rf', arguments: {} }))).status).toBe(404);
    expect((await post(JSON.stringify({ arguments: {} }))).status).toBe(400);
    expect((await post('{not json')).status).toBe(400);
    expect((await post('{}', 'text/plain')).status).toBe(415);
  });

  it('rejects requests addressed to other hostnames (DNS rebinding)', async () => {
    expect(await getWithHost(server.base, '/api/tools', 'evil.example:8787')).toBe(403);
    expect(await getWithHost(server.base, '/mcp', 'evil.example')).toBe(403);
  });

  it('rejects cross-site browser requests (CSRF)', async () => {
    const response = await fetch(`${server.base}/api/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ name: 'list_saved_locations', arguments: {} }),
    });
    expect(response.status).toBe(403);
  });
});

describe('web server with a token', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer(TOKEN);
  });
  afterAll(async () => {
    await stopTestServer(server);
  });

  it('keeps /health and the page open (they expose no data)', async () => {
    expect((await fetch(`${server.base}/health`)).status).toBe(200);
    expect((await fetch(`${server.base}/`)).status).toBe(200);
  });

  it('requires the token on /api', async () => {
    const without = await fetch(`${server.base}/api/tools`);
    expect(without.status).toBe(401);
    expect(without.headers.get('www-authenticate')).toMatch(/^Bearer/);

    const wrong = await fetch(`${server.base}/api/tools`, { headers: { Authorization: `Bearer ${'w'.repeat(40)}` } });
    expect(wrong.status).toBe(401);

    const withToken = await fetch(`${server.base}/api/tools`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(withToken.status).toBe(200);
  });

  it('keeps query strings (coordinates, place names) out of the logs', async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
    try {
      const response = await fetch(`${server.base}/api/climate?latitude=12.3456&longitude=65.4321&q=SecretPlace`);
      expect(response.status).toBe(401);
    } finally {
      spy.mockRestore();
    }
    const output = logged.join('\n');
    expect(output).toContain('Rejected request without a valid token');
    expect(output).toContain('/api/climate');
    expect(output).not.toMatch(/12\.3456|65\.4321|SecretPlace/);
  });

  it('requires the token on /mcp', async () => {
    await expect(connectMcp(server.base)).rejects.toThrow();

    const client = await connectMcp(server.base, { Authorization: `Bearer ${TOKEN}` });
    try {
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });
});
