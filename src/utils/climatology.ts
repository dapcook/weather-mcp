/**
 * Day-of-year climatology for the web console's Climate Explorer.
 *
 * Turns a long daily record (Open-Meteo archive, 1940-present) into:
 * - Per-calendar-day percentile curves for daily highs and lows over a
 *   baseline period (the shaded bands on a WeatherSpark-style chart)
 * - Per-calendar-day records over the whole record
 * - The daily series itself, packed as flat arrays for the browser
 *
 * Calendar days are indexed 0-365 on a leap-year calendar (Feb 29 = 59), so
 * every date maps to the same slot in every year.
 */

/** Percentile levels sent to the browser: 0, 5, 10, ... 100 */
export const QUANTILE_STEP = 5;
const QUANTILE_LEVELS = Array.from({ length: 100 / QUANTILE_STEP + 1 }, (_, i) => i * QUANTILE_STEP);

/** Days either side of a calendar day pooled into its sample (±7 = 15-day window) */
export const DEFAULT_WINDOW_DAYS = 7;
/** Extra circular moving-average half-width applied to the finished curves */
const SMOOTHING_DAYS = 3;
const CALENDAR_DAYS = 366;
/** Fewer samples than this for a calendar day and its curves are left empty */
const MIN_SAMPLES = 20;

const MONTH_STARTS = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];

export interface Baseline {
  startYear: number;
  endYear: number;
}

export interface DailyRecordInput {
  /** ISO dates (YYYY-MM-DD), consecutive days */
  time: string[];
  high: ReadonlyArray<number | null | undefined>;
  low: ReadonlyArray<number | null | undefined>;
  precipitation?: ReadonlyArray<number | null | undefined>;
}

export interface VariableNormals {
  /** Mean per calendar day */
  mean: Array<number | null>;
  /** Quantiles per calendar day at QUANTILE_STEP intervals (21 values, 0th-100th) */
  quantiles: Array<number[] | null>;
}

export interface CalendarRecord {
  value: number;
  year: number;
}

export interface Climatology {
  baseline: Baseline;
  windowDays: number;
  quantileStep: number;
  high: VariableNormals;
  low: VariableNormals;
  /** Mean daily precipitation per calendar day over the baseline */
  precipitationMean: Array<number | null>;
  recordHigh: Array<CalendarRecord | null>;
  recordLow: Array<CalendarRecord | null>;
}

/** Leap-year calendar index (0-365) for an ISO date; -1 if it can't be parsed */
export function calendarDayIndex(isoDate: string): number {
  const month = Number(isoDate.slice(5, 7));
  const day = Number(isoDate.slice(8, 10));
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day) || day < 1 || day > 31) {
    return -1;
  }
  return MONTH_STARTS[month - 1] + day - 1;
}

/** Parse "1991-2020" into a baseline, or null if malformed or outside [minYear, maxYear] */
export function parseBaseline(value: string, minYear: number, maxYear: number): Baseline | null {
  const match = /^(\d{4})-(\d{4})$/.exec(value.trim());
  if (!match) {
    return null;
  }
  const startYear = Number(match[1]);
  const endYear = Number(match[2]);
  if (startYear < minYear || endYear > maxYear || endYear - startYear < 9) {
    return null;
  }
  return { startYear, endYear };
}

/** Linear-interpolated quantile of an ascending-sorted array (p in 0-100) */
export function quantileSorted(sorted: ReadonlyArray<number>, p: number): number {
  if (sorted.length === 0) {
    return NaN;
  }
  const pos = (sorted.length - 1) * (p / 100);
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  if (lower === upper) {
    return sorted[lower];
  }
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (pos - lower);
}

function isNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Circular moving average of a per-calendar-day series, skipping gaps */
function smoothCircular(values: Array<number | null>, halfWidth: number): Array<number | null> {
  return values.map((value, index) => {
    if (value === null) {
      return null;
    }
    let sum = 0;
    let count = 0;
    for (let offset = -halfWidth; offset <= halfWidth; offset++) {
      const neighbor = values[(index + offset + CALENDAR_DAYS) % CALENDAR_DAYS];
      if (neighbor !== null) {
        sum += neighbor;
        count++;
      }
    }
    return sum / count;
  });
}

function bucketByCalendarDay(
  input: DailyRecordInput,
  values: ReadonlyArray<number | null | undefined>,
  baseline: Baseline
): number[][] {
  const buckets: number[][] = Array.from({ length: CALENDAR_DAYS }, () => []);
  for (let i = 0; i < input.time.length; i++) {
    const year = Number(input.time[i].slice(0, 4));
    const value = values[i];
    if (year < baseline.startYear || year > baseline.endYear || !isNumber(value)) {
      continue;
    }
    const slot = calendarDayIndex(input.time[i]);
    if (slot >= 0) {
      buckets[slot].push(value);
    }
  }
  return buckets;
}

/** Pool each calendar day's ±windowDays neighbors (wrapping the year) */
function pooledSamples(buckets: number[][], slot: number, windowDays: number): number[] {
  const pooled: number[] = [];
  for (let offset = -windowDays; offset <= windowDays; offset++) {
    pooled.push(...buckets[(slot + offset + CALENDAR_DAYS) % CALENDAR_DAYS]);
  }
  return pooled;
}

function computeVariableNormals(buckets: number[][], windowDays: number): VariableNormals {
  const rawMean: Array<number | null> = [];
  const rawQuantiles: Array<number[] | null> = [];

  for (let slot = 0; slot < CALENDAR_DAYS; slot++) {
    const samples = pooledSamples(buckets, slot, windowDays);
    if (samples.length < MIN_SAMPLES) {
      rawMean.push(null);
      rawQuantiles.push(null);
      continue;
    }
    samples.sort((a, b) => a - b);
    rawMean.push(samples.reduce((sum, v) => sum + v, 0) / samples.length);
    rawQuantiles.push(QUANTILE_LEVELS.map((p) => quantileSorted(samples, p)));
  }

  // Smooth each quantile level on its own. Averaging the same days for every
  // level keeps the levels in order, so bands never cross.
  const smoothedLevels = QUANTILE_LEVELS.map((_, level) =>
    smoothCircular(rawQuantiles.map((q) => (q ? q[level] : null)), SMOOTHING_DAYS));

  return {
    mean: smoothCircular(rawMean, SMOOTHING_DAYS).map((v) => (v === null ? null : round1(v))),
    quantiles: rawQuantiles.map((q, slot) =>
      q ? QUANTILE_LEVELS.map((_, level) => round1(smoothedLevels[level][slot] as number)) : null),
  };
}

function computePrecipitationMean(buckets: number[][], windowDays: number): Array<number | null> {
  const means = buckets.map((_, slot) => {
    const samples = pooledSamples(buckets, slot, windowDays);
    return samples.length < MIN_SAMPLES ? null : samples.reduce((sum, v) => sum + v, 0) / samples.length;
  });
  return means.map((v) => (v === null ? null : Math.round(v * 1000) / 1000));
}

function computeRecords(
  input: DailyRecordInput,
  values: ReadonlyArray<number | null | undefined>,
  isBetter: (candidate: number, current: number) => boolean
): Array<CalendarRecord | null> {
  const records: Array<CalendarRecord | null> = Array.from({ length: CALENDAR_DAYS }, () => null);
  for (let i = 0; i < input.time.length; i++) {
    const value = values[i];
    const slot = calendarDayIndex(input.time[i]);
    if (!isNumber(value) || slot < 0) {
      continue;
    }
    const current = records[slot];
    // Strict comparison keeps the earliest year on ties, like official records
    if (!current || isBetter(value, current.value)) {
      records[slot] = { value: round1(value), year: Number(input.time[i].slice(0, 4)) };
    }
  }
  return records;
}

/**
 * Build percentile bands, means and records for every calendar day.
 *
 * @param input - Consecutive daily highs/lows (and optionally precipitation)
 * @param baseline - Years whose data define "normal" (records use all years)
 * @param windowDays - Days either side of each calendar day pooled into its sample
 */
export function computeClimatology(
  input: DailyRecordInput,
  baseline: Baseline,
  windowDays: number = DEFAULT_WINDOW_DAYS
): Climatology {
  const precipitation = input.precipitation ?? [];
  return {
    baseline,
    windowDays,
    quantileStep: QUANTILE_STEP,
    high: computeVariableNormals(bucketByCalendarDay(input, input.high, baseline), windowDays),
    low: computeVariableNormals(bucketByCalendarDay(input, input.low, baseline), windowDays),
    precipitationMean: computePrecipitationMean(bucketByCalendarDay(input, precipitation, baseline), windowDays),
    recordHigh: computeRecords(input, input.high, (candidate, current) => candidate > current),
    recordLow: computeRecords(input, input.low, (candidate, current) => candidate < current),
  };
}

/**
 * Percentile rank (0-100) of a value against a calendar day's quantile curve,
 * interpolating between levels. Values beyond the extremes clamp to 0 or 100.
 */
export function percentileRank(value: number, quantiles: ReadonlyArray<number>): number {
  const last = quantiles.length - 1;
  if (value <= quantiles[0]) {
    return 0;
  }
  if (value >= quantiles[last]) {
    return 100;
  }
  for (let i = 1; i <= last; i++) {
    if (value <= quantiles[i]) {
      const span = quantiles[i] - quantiles[i - 1];
      const fraction = span > 0 ? (value - quantiles[i - 1]) / span : 0.5;
      return ((i - 1 + fraction) / last) * 100;
    }
  }
  return 100;
}

/** Round a daily series to one decimal for a compact JSON payload */
export function packSeries(values: ReadonlyArray<number | null | undefined>, decimals = 1): Array<number | null> {
  const factor = 10 ** decimals;
  return values.map((v) => (isNumber(v) ? Math.round(v * factor) / factor : null));
}
