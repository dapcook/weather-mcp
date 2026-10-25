/**
 * The full daily record behind the climate explorer is about 2 MB per place once
 * parsed, so it is cached against a memory budget instead of an entry count.
 *
 * Runs the real OpenMeteoService against a local server returning a small
 * synthetic record, with a budget that holds exactly three of them.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { OpenMeteoService, estimateDailyRecordBytes, DEFAULT_DAILY_RECORD_CACHE_BYTES } from '../../src/services/openmeteo.js';
import type { OpenMeteoHistoricalResponse } from '../../src/types/openmeteo.js';

const DAYS = 100;
const days = Array.from({ length: DAYS }, (_, i) => new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10));
const payload = JSON.stringify({
  latitude: 39, longitude: -94, elevation: 244, timezone: 'America/Chicago', timezone_abbreviation: 'CST',
  utc_offset_seconds: -21600, generationtime_ms: 1, daily_units: {},
  daily: {
    time: days,
    temperature_2m_max: days.map(() => 70),
    temperature_2m_min: days.map(() => 50),
    precipitation_sum: days.map(() => 0),
  },
});

describe('daily record cache', () => {
  const bytesPerRecord = DAYS * 64;
  let server: Server;
  let service: OpenMeteoService;
  let requests = 0;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      requests += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(payload);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    // Room for three records (and not a fourth)
    service = new OpenMeteoService({
      baseURL: `http://127.0.0.1:${port}/v1`,
      timeout: 5000,
      dailyRecordCacheBytes: bytesPerRecord * 3 + 10,
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    service.clearCache();
    requests = 0;
  });

  // Distinct places, so each is its own cache entry
  const load = (place: number) => service.getDailyTemperatureRecord(30 + place, -100, '2020-01-01', '2020-04-09');

  it('serves a place already loaded without asking Open-Meteo again', async () => {
    const first = await load(0);
    const second = await load(0);
    expect(requests).toBe(1);
    expect(second).toBe(first);
  });

  it('keeps memory within the budget no matter how many places are loaded', async () => {
    for (let place = 0; place < 10; place++) {
      await load(place);
    }
    expect(requests).toBe(10);

    // The three most recent are still cached; older ones are not
    requests = 0;
    for (const place of [9, 8, 7]) await load(place);
    expect(requests).toBe(0);
    await load(0);
    expect(requests).toBe(1);
  });

  it('drops the least recently used place first, and a re-read protects a place', async () => {
    await load(0);
    await load(1);
    await load(2);
    await load(0); // 0 is now the most recently used
    await load(3); // over budget: drops 1, the least recently used
    requests = 0;

    await load(0);
    await load(2);
    await load(3);
    expect(requests).toBe(0);
    await load(1);
    expect(requests).toBe(1);
  });

  it('forgets everything on clearCache()', async () => {
    await load(0);
    service.clearCache();
    await load(0);
    expect(requests).toBe(2);
  });

  it('does not keep records that are larger than the whole budget', async () => {
    const tiny = new OpenMeteoService({
      baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      timeout: 5000,
      dailyRecordCacheBytes: bytesPerRecord - 1,
    });
    await tiny.getDailyTemperatureRecord(30, -100, '2020-01-01', '2020-04-09');
    await tiny.getDailyTemperatureRecord(30, -100, '2020-01-01', '2020-04-09');
    expect(requests).toBe(2);
  });

  describe('size estimate and default budget', () => {
    it('estimates about 64 bytes per day (about 2 MB for the full 1940-present record)', () => {
      const record = { daily: { time: new Array(31708).fill('2000-01-01') } } as unknown as OpenMeteoHistoricalResponse;
      const mb = estimateDailyRecordBytes(record) / 1048576;
      expect(mb).toBeGreaterThan(1.8);
      expect(mb).toBeLessThan(2.3);
    });

    it('estimates zero for a record with no days', () => {
      expect(estimateDailyRecordBytes({} as OpenMeteoHistoricalResponse)).toBe(0);
    });

    it('defaults to a budget that holds dozens of full records yet fits a 768 MB container', () => {
      const fullRecord = 31708 * 64;
      expect(DEFAULT_DAILY_RECORD_CACHE_BYTES / fullRecord).toBeGreaterThan(40);
      expect(DEFAULT_DAILY_RECORD_CACHE_BYTES).toBeLessThan(768 * 1048576 / 4);
    });
  });
});
