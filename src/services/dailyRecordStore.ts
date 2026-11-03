/**
 * On-disk copies of full daily weather records (the climate explorer's 86-year
 * downloads), so a restart does not have to download them again.
 *
 * Why this exists: Open-Meteo's free allowance counts one full record as hundreds of
 * calls (roughly 7 new places an hour, 14 a day). The records are kept in memory for
 * speed, but memory is lost on every restart or rebuild. Each place is saved as one
 * gzipped JSON file; a saved record only needs its recent tail refreshed, which costs
 * a fraction of one call.
 *
 * Failure policy: the disk is an optimization. Any problem (read-only folder, full
 * disk, corrupt file) is logged and treated as "nothing saved", never thrown.
 *
 * Privacy: file names contain the place's coordinates (rounded to 0.01 degrees), so
 * paths must never be logged; Node's error messages include them, so only error
 * codes are.
 */

import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import { mkdir, readFile, readdir, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

const FORMAT_VERSION = 1;
const FILE_SUFFIX = '.json.gz';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Default cap on the whole folder; a record is roughly 100-200 KB compressed */
export const DEFAULT_STORE_MAX_BYTES = 128 * 1024 * 1024;
/** Refuse implausible files: 110 years of days, and a few MB either side of compression */
const MAX_DAYS = 40_000;
const MAX_COMPRESSED_BYTES = 8 * 1024 * 1024;
const MAX_JSON_BYTES = 32 * 1024 * 1024;

/** One place's daily record. Days are consecutive from startDate, so dates are not stored. */
export interface DailyRecord {
  latitude: number;
  longitude: number;
  elevation: number;
  timezone: string;
  timezoneAbbreviation: string;
  utcOffsetSeconds: number;
  /** First day, YYYY-MM-DD */
  startDate: string;
  high: Array<number | null>;
  low: Array<number | null>;
  precipitation: Array<number | null>;
}

// ---------------------------------------------------------------------------
// Date helpers (UTC calendar days; no time zones involved)
// ---------------------------------------------------------------------------

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Milliseconds at UTC midnight for a YYYY-MM-DD day, or NaN if it isn't a real date */
export function dayToMs(day: string): number {
  const match = ISO_DAY.exec(day);
  if (!match) {
    return NaN;
  }
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Date(ms).toISOString().slice(0, 10) === day ? ms : NaN;
}

export function addDays(day: string, days: number): string {
  return new Date(dayToMs(day) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (negative if `to` is earlier) */
export function daysBetween(from: string, to: string): number {
  return Math.round((dayToMs(to) - dayToMs(from)) / DAY_MS);
}

/** Last day covered by a record */
export function recordEndDate(record: DailyRecord): string {
  return addDays(record.startDate, record.high.length - 1);
}

// ---------------------------------------------------------------------------
// Validation of what comes back from disk
// ---------------------------------------------------------------------------

function isSeries(value: unknown, length: number): value is Array<number | null> {
  return Array.isArray(value) && value.length === length && value.every((v) => v === null || (typeof v === 'number' && Number.isFinite(v)));
}

function parseRecord(value: unknown): DailyRecord | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const v = value as Record<string, unknown>;
  if (
    v.version !== FORMAT_VERSION ||
    typeof v.latitude !== 'number' || typeof v.longitude !== 'number' || typeof v.elevation !== 'number' ||
    typeof v.timezone !== 'string' || typeof v.timezoneAbbreviation !== 'string' || typeof v.utcOffsetSeconds !== 'number' ||
    typeof v.startDate !== 'string' || !Number.isFinite(dayToMs(v.startDate)) ||
    !Array.isArray(v.high) || v.high.length < 1 || v.high.length > MAX_DAYS
  ) {
    return null;
  }
  const n = v.high.length;
  if (!isSeries(v.high, n) || !isSeries(v.low, n) || !isSeries(v.precipitation, n)) {
    return null;
  }
  return {
    latitude: v.latitude,
    longitude: v.longitude,
    elevation: v.elevation,
    timezone: v.timezone,
    timezoneAbbreviation: v.timezoneAbbreviation,
    utcOffsetSeconds: v.utcOffsetSeconds,
    startDate: v.startDate,
    high: v.high,
    low: v.low,
    precipitation: v.precipitation,
  };
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class DailyRecordStore {
  private readonly maxBytes: number;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string, options: { maxBytes?: number } = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_STORE_MAX_BYTES;
  }

  /** The saved record for a place and first day, or null if none (or it is unusable) */
  async load(latitude: number, longitude: number, startDate: string): Promise<DailyRecord | null> {
    let file: string;
    try {
      file = this.fileFor(latitude, longitude, startDate);
    } catch {
      return null; // not a key we could ever have saved
    }
    try {
      const info = await stat(file);
      if (info.size > MAX_COMPRESSED_BYTES) {
        throw new Error('too large');
      }
      const json = await gunzipAsync(await readFile(file), { maxOutputLength: MAX_JSON_BYTES });
      const record = parseRecord(JSON.parse(json.toString('utf8')));
      if (!record || record.startDate !== startDate) {
        throw new Error('unusable');
      }
      // Mark as recently used so pruning drops the places you open least
      const now = new Date();
      utimes(file, now, now).catch(() => undefined);
      return record;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        // Corrupt, truncated, an old format, or unreadable: forget it so it gets rebuilt
        logger.warn('Saved climate record unusable; it will be downloaded again', { code: errorCode(error) });
        await unlink(file).catch(() => undefined);
      }
      return null;
    }
  }

  /**
   * Save a record (replacing any earlier one for that place), then trim the folder to its size limit.
   *
   * @param latitude - The coordinates the place was REQUESTED with, which are the key.
   *   The record's own coordinates are where the weather model snapped them to, and differ.
   */
  save(latitude: number, longitude: number, record: DailyRecord): Promise<void> {
    // One write at a time, so a trim never races a save
    this.writes = this.writes.then(() => this.write(latitude, longitude, record)).catch(() => undefined);
    return this.writes;
  }

  private async write(latitude: number, longitude: number, record: DailyRecord): Promise<void> {
    let temp: string | undefined;
    try {
      const file = this.fileFor(latitude, longitude, record.startDate);
      temp = `${file}.${process.pid}.tmp`;
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const body = JSON.stringify({ version: FORMAT_VERSION, ...record, savedAt: new Date().toISOString() });
      await writeFile(temp, await gzipAsync(body), { mode: 0o600 });
      await rename(temp, file); // atomic: readers see the old file or the new one, never half of one
      await this.trim();
    } catch (error) {
      logger.warn('Could not save climate record to disk; continuing without it', { code: errorCode(error) });
      if (temp) {
        await unlink(temp).catch(() => undefined);
      }
    }
  }

  /** Delete the least recently used files until the folder fits its limit */
  private async trim(): Promise<void> {
    const names = (await readdir(this.dir)).filter((name) => name.endsWith(FILE_SUFFIX));
    const files = await Promise.all(
      names.map(async (name) => {
        const info = await stat(join(this.dir, name));
        return { name, size: info.size, used: info.mtimeMs };
      })
    );
    let total = files.reduce((sum, f) => sum + f.size, 0);
    for (const file of files.sort((a, b) => a.used - b.used)) {
      if (total <= this.maxBytes) {
        break;
      }
      await unlink(join(this.dir, file.name)).catch(() => undefined);
      total -= file.size;
    }
  }

  /** Coordinates rounded to 0.01 degrees, matching how the explorer asks for places */
  private fileFor(latitude: number, longitude: number, startDate: string): string {
    // Built only from numbers and a validated date, so it can never point outside the folder
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(dayToMs(startDate))) {
      throw new RangeError('Invalid climate record key');
    }
    return join(this.dir, `${latitude.toFixed(2)}_${longitude.toFixed(2)}_${startDate}${FILE_SUFFIX}`);
  }
}
