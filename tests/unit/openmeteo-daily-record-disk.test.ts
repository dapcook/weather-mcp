/**
 * Saving climate records on disk: a restart should not download a place again, and a
 * saved record only needs its recent end refreshed.
 *
 * Runs the real OpenMeteoService against a local server that answers like Open-Meteo's
 * archive: it returns the days between start_date and end_date, with values that
 * depend on a "revision" so a refreshed day can be told from a saved one.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtemp, rm, readdir, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenMeteoService, DAILY_RECORD_REFRESH_OVERLAP_DAYS } from '../../src/services/openmeteo.js';
import { addDays, daysBetween } from '../../src/services/dailyRecordStore.js';
import { logger } from '../../src/utils/logger.js';

const START = '2020-01-01';

describe('daily records saved on disk', () => {
  let server: Server;
  let baseURL: string;
  let dir: string;
  let requests: Array<{ start: string; end: string }>;
  /** Value reported for each day; bumping it simulates Open-Meteo revising recent days */
  let revision: number;
  /** When set, answer every request with this status */
  let failWith: number | null;
  let delayMs: number;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const start = url.searchParams.get('start_date') ?? '';
      const end = url.searchParams.get('end_date') ?? '';
      requests.push({ start, end });
      const respond = () => {
        if (failWith) {
          res.writeHead(failWith, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: true, reason: 'Hourly API request limit exceeded. Please try again in the next hour.' }));
          return;
        }
        const n = daysBetween(start, end) + 1;
        const time = Array.from({ length: n }, (_, i) => addDays(start, i));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          latitude: 39.1, longitude: -94.6, elevation: 244, timezone: 'America/Chicago', timezone_abbreviation: 'CST',
          utc_offset_seconds: -21600, generationtime_ms: 1, daily_units: {},
          daily: {
            time,
            temperature_2m_max: time.map((day) => daysBetween(START, day) + revision),
            temperature_2m_min: time.map((day) => daysBetween(START, day) - 10 + revision),
            precipitation_sum: time.map(() => 0.1),
          },
        }));
      };
      if (delayMs > 0) {
        setTimeout(respond, delayMs);
      } else {
        respond();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'climate-disk-'));
    requests = [];
    revision = 0;
    failWith = null;
    delayMs = 0;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  /** A fresh service, as after a restart: empty memory, same folder */
  const newService = () => new OpenMeteoService({ baseURL, timeout: 5000, dailyRecordStoreDir: dir });
  const load = (service: OpenMeteoService, end: string, lat = 39.1) =>
    service.getDailyTemperatureRecordWithStatus(lat, -94.6, START, end);

  it('saves a downloaded record to the folder', async () => {
    await load(newService(), '2020-12-31');
    expect(requests).toEqual([{ start: START, end: '2020-12-31' }]);
    expect(await readdir(dir)).toEqual(['39.10_-94.60_2020-01-01.json.gz']);
  });

  it('does not download again after a restart', async () => {
    const first = await load(newService(), '2020-12-31');
    requests = [];
    const second = await load(newService(), '2020-12-31');
    expect(requests).toEqual([]);
    expect(second.refreshError).toBeUndefined();
    expect(second.record.daily).toEqual(first.record.daily);
    expect(second.record.timezone).toBe('America/Chicago');
    expect(second.record.elevation).toBe(244);
  });

  it('cuts a longer saved record down to the range asked for', async () => {
    await load(newService(), '2020-12-31');
    requests = [];
    const { record } = await load(newService(), '2020-03-31');
    expect(requests).toEqual([]);
    expect(record.daily?.time[record.daily.time.length - 1]).toBe('2020-03-31');
    expect(record.daily?.temperature_2m_max).toHaveLength(91);
  });

  it('on a later day fetches only the recent end, replacing the days it overlaps', async () => {
    await load(newService(), '2020-12-31');
    requests = [];
    revision = 5; // Open-Meteo has revised its recent values
    const { record, refreshError } = await load(newService(), '2021-01-10');

    const overlapStart = addDays('2020-12-31', -(DAILY_RECORD_REFRESH_OVERLAP_DAYS - 1));
    expect(requests).toEqual([{ start: overlapStart, end: '2021-01-10' }]);
    expect(refreshError).toBeUndefined();

    const daily = record.daily!;
    expect(daily.time[0]).toBe(START);
    expect(daily.time[daily.time.length - 1]).toBe('2021-01-10');
    expect(daily.time).toHaveLength(daysBetween(START, '2021-01-10') + 1);
    const at = (day: string) => daysBetween(START, day);
    expect(daily.temperature_2m_max[at(addDays(overlapStart, -1))]).toBe(at(addDays(overlapStart, -1))); // untouched
    expect(daily.temperature_2m_max[at(overlapStart)]).toBe(at(overlapStart) + 5); // refreshed
    expect(daily.temperature_2m_max[at('2021-01-10')]).toBe(at('2021-01-10') + 5); // new
  });

  it('saves the topped-up record, so the next restart needs no request', async () => {
    await load(newService(), '2020-12-31');
    await load(newService(), '2021-01-10');
    requests = [];
    const { record } = await load(newService(), '2021-01-10');
    expect(requests).toEqual([]);
    expect(record.daily?.time).toHaveLength(daysBetween(START, '2021-01-10') + 1);
  });

  it('starts the top-up at the first day when the saved record is shorter than the overlap', async () => {
    await load(newService(), '2020-02-09'); // 40 days
    requests = [];
    const { record } = await load(newService(), '2020-02-20');
    expect(requests).toEqual([{ start: START, end: '2020-02-20' }]);
    expect(record.daily?.time).toHaveLength(51);
  });

  describe('when the refresh fails', () => {
    it('serves the saved record with a note instead of an error', async () => {
      await load(newService(), '2020-12-31');
      requests = [];
      failWith = 429;
      vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const { record, refreshError } = await load(newService(), '2021-01-10');
      expect(requests.length).toBeGreaterThan(0);
      expect(record.daily?.time[record.daily.time.length - 1]).toBe('2020-12-31');
      expect(refreshError).toMatch(/limit/i);
      expect(refreshError!.length).toBeLessThanOrEqual(300);
    });

    it('tries again on the next request rather than remembering the stale record', async () => {
      await load(newService(), '2020-12-31');
      const service = newService();
      failWith = 429;
      vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      expect((await load(service, '2021-01-10')).refreshError).toBeDefined();

      failWith = null;
      requests = [];
      const retry = await load(service, '2021-01-10');
      expect(requests.length).toBe(1);
      expect(retry.refreshError).toBeUndefined();
      expect(retry.record.daily?.time[retry.record.daily.time.length - 1]).toBe('2021-01-10');
    });

    it('still fails when nothing was saved', async () => {
      failWith = 429;
      vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      await expect(load(newService(), '2020-12-31')).rejects.toThrow();
      expect(await readdir(dir)).toEqual([]);
    });
  });

  it('shares one download between requests for the same place made at once', async () => {
    delayMs = 50;
    const service = newService();
    const results = await Promise.all([load(service, '2020-12-31'), load(service, '2020-12-31'), load(service, '2020-12-31')]);
    expect(requests).toHaveLength(1);
    expect(results[1].record).toBe(results[0].record);
  });

  it('downloads again, and replaces the file, when the saved one is corrupt', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '39.10_-94.60_2020-01-01.json.gz'), 'not a record');
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { record } = await load(newService(), '2020-12-31');
    expect(requests).toHaveLength(1);
    expect(record.daily?.time).toHaveLength(366);
    requests = [];
    await load(newService(), '2020-12-31');
    expect(requests).toEqual([]);
  });

  it('keeps places apart', async () => {
    await load(newService(), '2020-12-31', 39.1);
    requests = [];
    await load(newService(), '2020-12-31', 40.2);
    expect(requests).toHaveLength(1);
    expect((await readdir(dir)).sort()).toEqual(['39.10_-94.60_2020-01-01.json.gz', '40.20_-94.60_2020-01-01.json.gz']);
  });

  it('writes nothing, and reads nothing, when caching is turned off', async () => {
    const config = await import('../../src/config/cache.js');
    const enabled = vi.spyOn(config.CacheConfig, 'enabled', 'get').mockReturnValue(false);
    try {
      await load(newService(), '2020-12-31');
      await load(newService(), '2020-12-31');
      expect(requests).toHaveLength(2);
      expect(await readdir(dir)).toEqual([]);
    } finally {
      enabled.mockRestore();
    }
  });

  it('keeps the files when the in-memory caches are cleared (as at shutdown)', async () => {
    const service = newService();
    await load(service, '2020-12-31');
    service.clearCache();
    expect(await readdir(dir)).toHaveLength(1);
  });

  it('works as before, memory only, when no folder is configured', async () => {
    const service = new OpenMeteoService({ baseURL, timeout: 5000 });
    await load(service, '2020-12-31');
    await load(service, '2020-12-31');
    expect(requests).toHaveLength(1);
  });
});
