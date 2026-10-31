/**
 * The climate explorer across a restart: the first run downloads a place and saves it;
 * a new process on the same data folder serves it without asking Open-Meteo, and says
 * so (rather than failing) when it cannot refresh a saved record.
 *
 * Uses the real services and web server, with Open-Meteo replaced by a local server
 * that answers for whatever dates are requested.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServices, shutdownServices, WeatherServices } from '../../src/mcpServer.js';
import { addDays, daysBetween } from '../../src/services/dailyRecordStore.js';
import { startWebServer, RunningWebServer } from '../../src/web/app.js';
import { LOOPBACK_HOSTS } from '../../src/web/config.js';
import { logger } from '../../src/utils/logger.js';

describe('climate explorer across restarts', () => {
  let stub: Server;
  let baseURL: string;
  let dir: string;
  let requests: Array<{ start: string; end: string }>;
  let failWith: number | null;
  let running: Array<{ web: RunningWebServer; services: WeatherServices }>;

  beforeAll(async () => {
    stub = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const start = url.searchParams.get('start_date') ?? '';
      const end = url.searchParams.get('end_date') ?? '';
      requests.push({ start, end });
      if (failWith) {
        res.writeHead(failWith, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: true, reason: 'Hourly API request limit exceeded. Please try again in the next hour.' }));
        return;
      }
      const n = daysBetween(start, end) + 1;
      const time = Array.from({ length: n }, (_, i) => addDays(start, i));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        latitude: 39.01, longitude: -94.21, elevation: 244, timezone: 'America/Chicago', timezone_abbreviation: 'CST',
        utc_offset_seconds: -21600, generationtime_ms: 1, daily_units: {},
        daily: {
          time,
          temperature_2m_max: time.map((_, i) => 60 + (i % 30)),
          temperature_2m_min: time.map((_, i) => 40 + (i % 30)),
          precipitation_sum: time.map(() => 0),
        },
      }));
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    baseURL = `http://127.0.0.1:${(stub.address() as AddressInfo).port}/v1`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'weather-mcp-climate-disk-'));
    requests = [];
    failWith = null;
    running = [];
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const { web, services } of running) {
      await web.close();
      await shutdownServices(services);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  /** A new "process": fresh services and web server on the shared data folder */
  async function start(): Promise<string> {
    // The saved records go where createServices puts them: next to the saved locations
    const services = createServices({ locationsPath: join(dir, 'locations.json'), openMeteo: { baseURL, timeout: 5000 } });
    const web = await startWebServer({ host: '127.0.0.1', port: 0, allowedHosts: LOOPBACK_HOSTS }, services);
    running.push({ web, services });
    return `http://127.0.0.1:${web.port}`;
  }

  const climate = (base: string) => fetch(`${base}/api/climate?latitude=39.01&longitude=-94.21`);

  it('serves a saved place after a restart without asking Open-Meteo', async () => {
    const first = await (await climate(await start())).json();
    expect(requests).toHaveLength(1);
    expect(readdirSync(join(dir, 'climate'))).toEqual(['39.01_-94.21_1940-01-01.json.gz']);

    // Everything in memory is gone; only the data folder remains
    await running.pop()!.web.close();
    requests = [];
    const second = await (await climate(await start())).json();

    expect(requests).toEqual([]);
    expect(second.refreshNote).toBeUndefined();
    expect(second.start).toBe(first.start);
    expect(second.end).toBe(first.end);
    expect(second.high).toEqual(first.high);
    expect(second.climatology).toEqual(first.climatology);
  });

  it('puts the saved records in the folder given as dataDir', async () => {
    const other = mkdtempSync(join(tmpdir(), 'weather-mcp-climate-other-'));
    const services = createServices({ locationsPath: join(dir, 'locations.json'), dataDir: other, openMeteo: { baseURL, timeout: 5000 } });
    const web = await startWebServer({ host: '127.0.0.1', port: 0, allowedHosts: LOOPBACK_HOSTS }, services);
    running.push({ web, services });
    try {
      await climate(`http://127.0.0.1:${web.port}`);
      expect(readdirSync(join(other, 'climate'))).toHaveLength(1);
      expect(existsSync(join(dir, 'climate'))).toBe(false);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('tells the explorer when it could only show a saved record', async () => {
    await climate(await start());
    await running.pop()!.web.close();

    // A later day: the saved record is one day short, and Open-Meteo is refusing requests
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);
    failWith = 429;
    try {
      const response = await climate(await start());
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.refreshNote).toMatch(/saved data/i);
      expect(data.refreshNote).toMatch(/limit/i);
      expect(data.high.length).toBeGreaterThan(30_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
