/**
 * The on-disk copies of climate records: round trip, safety against bad files,
 * size pruning, and that nothing about a place leaks into the logs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readdir, writeFile, readFile, stat, utimes, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { DailyRecordStore, DailyRecord, addDays, daysBetween, recordEndDate } from '../../src/services/dailyRecordStore.js';
import { logger } from '../../src/utils/logger.js';

function makeRecord(days: number, startDate = '1940-01-01'): DailyRecord {
  return {
    latitude: 39.1, longitude: -94.58, elevation: 244, timezone: 'America/Chicago', timezoneAbbreviation: 'CST',
    utcOffsetSeconds: -21600, startDate,
    high: Array.from({ length: days }, (_, i) => (i % 7 === 0 ? null : 60 + (i % 30))),
    low: Array.from({ length: days }, (_, i) => 40 + (i % 20)),
    precipitation: Array.from({ length: days }, (_, i) => (i % 5) / 10),
  };
}

describe('DailyRecordStore', () => {
  let dir: string;
  let climateDir: string;
  let store: DailyRecordStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'climate-store-'));
    climateDir = join(dir, 'climate');
    store = new DailyRecordStore(climateDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await chmod(dir, 0o700).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  });

  it('returns what was saved, including missing values', async () => {
    const record = makeRecord(400);
    await store.save(39.1, -94.58, record);
    expect(await store.load(39.1, -94.58, '1940-01-01')).toEqual(record);
  });

  it('keeps the file private and compressed', async () => {
    await store.save(39.1, -94.58, makeRecord(400));
    const names = await readdir(climateDir);
    expect(names).toEqual(['39.10_-94.58_1940-01-01.json.gz']);
    const info = await stat(join(climateDir, names[0]));
    expect(info.mode & 0o077).toBe(0);
    expect(((await stat(climateDir)).mode & 0o077)).toBe(0);
    const raw = await readFile(join(climateDir, names[0]));
    expect(raw[0]).toBe(0x1f); // gzip magic number
  });

  it('returns null for a place never saved, and for a different first day', async () => {
    await store.save(39.1, -94.58, makeRecord(10));
    expect(await store.load(40, -94.58, '1940-01-01')).toBeNull();
    expect(await store.load(39.1, -94.58, '1950-01-01')).toBeNull();
  });

  it('replaces the earlier record for a place', async () => {
    await store.save(39.1, -94.58, makeRecord(10));
    await store.save(39.1, -94.58, makeRecord(20));
    expect((await store.load(39.1, -94.58, '1940-01-01'))?.high).toHaveLength(20);
    expect(await readdir(climateDir)).toHaveLength(1);
  });

  it('never leaves temporary files behind', async () => {
    await store.save(39.1, -94.58, makeRecord(10));
    expect((await readdir(climateDir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  describe('unusable files', () => {
    const file = () => join(climateDir, '39.10_-94.58_1940-01-01.json.gz');
    const plant = async (body: Buffer | string) => {
      await store.save(1, 1, makeRecord(1)); // creates the folder
      await writeFile(file(), body);
    };

    it.each([
      ['not gzip', 'hello'],
      ['gzip of not JSON', gzipSync('{nope')],
      ['an old format version', gzipSync(JSON.stringify({ ...makeRecord(5), version: 0 }))],
      ['series of different lengths', gzipSync(JSON.stringify({ ...makeRecord(5), version: 1, low: [1, 2] }))],
      ['a non-numeric value', gzipSync(JSON.stringify({ ...makeRecord(5), version: 1, high: [1, 'x', 3, 4, 5] }))],
      ['a record that starts on another day', gzipSync(JSON.stringify({ ...makeRecord(5, '1941-01-01'), version: 1 }))],
      ['a day that is not a real date', gzipSync(JSON.stringify({ ...makeRecord(5, '1940-02-31'), version: 1 }))],
    ])('ignores and removes a file that is %s', async (_name, body) => {
      await plant(body);
      expect(await store.load(39.1, -94.58, '1940-01-01')).toBeNull();
      expect(await readdir(climateDir)).not.toContain('39.10_-94.58_1940-01-01.json.gz');
    });

    it('refuses a file that would expand to something enormous', async () => {
      await plant(gzipSync(Buffer.alloc(40 * 1024 * 1024, 0x20)));
      expect(await store.load(39.1, -94.58, '1940-01-01')).toBeNull();
      expect(await readdir(climateDir)).not.toContain('39.10_-94.58_1940-01-01.json.gz');
    });
  });

  describe('keys', () => {
    it.each([[NaN, 0, '1940-01-01'], [0, Infinity, '1940-01-01'], [0, 0, '../../etc/passwd'], [0, 0, '1940-13-01']])(
      'cannot be used to reach outside the folder (%s, %s, %s)',
      async (lat, lon, start) => {
        expect(await store.load(lat, lon, start)).toBeNull();
        await expect(store.save(lat, lon, { ...makeRecord(3), startDate: start })).resolves.toBeUndefined();
        expect(await readdir(dir)).toEqual([]);
      }
    );
  });

  describe('size limit', () => {
    it('drops the least recently used places first', async () => {
      const probe = new DailyRecordStore(join(dir, 'probe'));
      await probe.save(1, 1, makeRecord(3000));
      const one = (await stat(join(dir, 'probe', (await readdir(join(dir, 'probe')))[0]))).size;

      const small = new DailyRecordStore(climateDir, { maxBytes: one * 2 + 100 });
      await small.save(1, 1, makeRecord(3000));
      await small.save(2, 2, makeRecord(3000));
      // Make place 1 the older of the two, then use it
      const old = new Date(Date.now() - 60_000);
      await utimes(join(climateDir, '1.00_1.00_1940-01-01.json.gz'), old, old);
      await utimes(join(climateDir, '2.00_2.00_1940-01-01.json.gz'), new Date(Date.now() - 30_000), new Date(Date.now() - 30_000));
      expect(await small.load(1, 1, '1940-01-01')).not.toBeNull(); // reading marks it recently used
      await new Promise((r) => setTimeout(r, 50));

      await small.save(3, 3, makeRecord(3000));
      const left = (await readdir(climateDir)).sort();
      expect(left).toEqual(['1.00_1.00_1940-01-01.json.gz', '3.00_3.00_1940-01-01.json.gz']);
    });
  });

  describe('failures', () => {
    it('does not throw when the folder cannot be written', async () => {
      await chmod(dir, 0o500);
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      await expect(store.save(39.1, -94.58, makeRecord(10))).resolves.toBeUndefined();
      expect(await store.load(39.1, -94.58, '1940-01-01')).toBeNull();
      if (process.getuid?.() !== 0) {
        expect(warn).toHaveBeenCalled();
      }
    });

    it('logs only an error code, never a path or coordinates', async () => {
      await chmod(dir, 0o500);
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      await store.save(39.1, -94.58, makeRecord(10));
      await store.save(1, 1, makeRecord(1));
      await store.load(39.1, -94.58, '1940-01-01');
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).not.toContain('39.1');
      expect(logged).not.toContain('94.58');
      expect(logged).not.toContain(dir);
    });

    it('logs no coordinates when removing a corrupt file', async () => {
      await store.save(39.1, -94.58, makeRecord(3));
      await writeFile(join(climateDir, '39.10_-94.58_1940-01-01.json.gz'), 'junk');
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      await store.load(39.1, -94.58, '1940-01-01');
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).not.toContain('39.1');
      expect(logged).not.toContain(dir);
    });
  });

  describe('date helpers', () => {
    it('add days across month, year and leap boundaries', () => {
      expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
      expect(addDays('2023-02-28', 1)).toBe('2023-03-01');
      expect(addDays('2023-12-31', 1)).toBe('2024-01-01');
      expect(addDays('2024-01-01', -1)).toBe('2023-12-31');
    });

    it('count days between', () => {
      expect(daysBetween('2024-01-01', '2024-01-01')).toBe(0);
      expect(daysBetween('2023-01-01', '2024-01-01')).toBe(365);
      expect(daysBetween('2024-01-02', '2024-01-01')).toBe(-1);
    });

    it('find the last day of a record', () => {
      expect(recordEndDate(makeRecord(366, '2024-01-01'))).toBe('2024-12-31');
    });
  });
});
