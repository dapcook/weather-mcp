/**
 * The climate explorer's data endpoint (/api/climate), end to end through the real web
 * server, with Open-Meteo replaced by a local server that counts requests.
 *
 * One full record is a heavy download (Open-Meteo counts it as hundreds of calls), so
 * the important behavior is that it is fetched once per place and reused.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServices, shutdownServices, WeatherServices } from '../../src/mcpServer.js';
import { OpenMeteoService } from '../../src/services/openmeteo.js';
import { startWebServer, RunningWebServer } from '../../src/web/app.js';
import { LOOPBACK_HOSTS } from '../../src/web/config.js';

const DAYS = 400;
const days = Array.from({ length: DAYS }, (_, i) => new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10));
const okPayload = JSON.stringify({
  latitude: 39.01, longitude: -94.21, elevation: 244, timezone: 'America/Chicago', timezone_abbreviation: 'CST',
  utc_offset_seconds: -21600, generationtime_ms: 1, daily_units: {},
  daily: {
    time: days,
    temperature_2m_max: days.map((_, i) => 60 + (i % 30)),
    temperature_2m_min: days.map((_, i) => 40 + (i % 30)),
    precipitation_sum: days.map((_, i) => (i % 7 === 0 ? 0.25 : 0)),
  },
});

describe('GET /api/climate', () => {
  let stub: Server;
  let web: RunningWebServer;
  let services: WeatherServices;
  let dir: string;
  let base: string;
  let requests = 0;
  let reply: (res: ServerResponse) => void;
  const ok = (res: ServerResponse) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(okPayload); };

  beforeAll(async () => {
    stub = createServer((_req, res) => { requests += 1; reply(res); });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    const { port } = stub.address() as AddressInfo;

    dir = mkdtempSync(join(tmpdir(), 'weather-mcp-climate-test-'));
    services = createServices({ locationsPath: join(dir, 'locations.json') });
    services.openMeteoService = new OpenMeteoService({ baseURL: `http://127.0.0.1:${port}/v1`, timeout: 5000 });
    web = await startWebServer({ host: '127.0.0.1', port: 0, allowedHosts: LOOPBACK_HOSTS }, services);
    base = `http://127.0.0.1:${web.port}`;
  });

  afterAll(async () => {
    await web.close();
    await shutdownServices(services);
    await new Promise<void>((resolve) => stub.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    services.openMeteoService.clearCache();
    requests = 0;
    reply = ok;
  });

  const climate = (query: string) => fetch(`${base}/api/climate?${query}`);

  it('returns the record, its units, and the normals for the baseline', async () => {
    const response = await climate('latitude=39.01&longitude=-94.21');
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toMatchObject({
      location: { latitude: 39.01, longitude: -94.21, elevation: 244, timezone: 'America/Chicago' },
      units: { temperature: '°F', precipitation: 'in' },
      start: '2020-01-01',
      end: days[DAYS - 1],
    });
    expect(data.high).toHaveLength(DAYS);
    expect(data.low).toHaveLength(DAYS);
    expect(data.precipitation).toHaveLength(DAYS);
    expect(data.high[0]).toBe(60);
    expect(data.climatology.baseline).toEqual({ startYear: 1991, endYear: 2020 });
  });

  it('downloads a place once and reuses it, even when only the baseline changes', async () => {
    const results = [];
    for (const baseline of ['1991-2020', '1961-1990', '1951-1980', '1991-2020']) {
      results.push(await (await climate(`latitude=39.01&longitude=-94.21&baseline=${baseline}`)).json());
    }
    expect(requests).toBe(1);
    expect(results.map((r) => r.climatology.baseline.startYear)).toEqual([1991, 1961, 1951, 1991]);
  });

  it('downloads again for a different place', async () => {
    await climate('latitude=39.01&longitude=-94.21');
    await climate('latitude=47.61&longitude=-122.33');
    expect(requests).toBe(2);
  });

  it('treats nearby coordinates (within 0.01 degrees) as the same place', async () => {
    await climate('latitude=39.011&longitude=-94.214');
    await climate('latitude=39.014&longitude=-94.211');
    expect(requests).toBe(1);
  });

  it('does not remember a failure: the next request tries again', async () => {
    reply = (res) => {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: true, reason: 'Hourly API request limit exceeded. Please try again in the next hour.' }));
    };
    const failed = await climate('latitude=39.01&longitude=-94.21');
    expect(failed.status).toBe(500);
    expect((await failed.json()).error).toContain('Hourly API request limit exceeded');

    reply = ok;
    const retried = await climate('latitude=39.01&longitude=-94.21');
    expect(retried.status).toBe(200);
    expect(requests).toBe(2);
  });

  it.each([
    ['latitude=abc&longitude=-94', /latitude must be a number/],
    ['latitude=39&longitude=', /longitude must be a number/],
    ['latitude=95&longitude=-94', /Invalid latitude/],
    ['latitude=39&longitude=-94&baseline=2000-2005', /Invalid baseline/],
    ['latitude=39&longitude=-94&baseline=nonsense', /Invalid baseline/],
  ])('rejects bad input without calling Open-Meteo (%s)', async (query, message) => {
    const response = await climate(query);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(message);
    expect(requests).toBe(0);
  });
});
