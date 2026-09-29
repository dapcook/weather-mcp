/**
 * Unit tests for the Climate Explorer's day-of-year climatology
 */

import { describe, it, expect } from 'vitest';
import {
  calendarDayIndex,
  computeClimatology,
  packSeries,
  parseBaseline,
  percentileRank,
  quantileSorted,
  QUANTILE_STEP,
  type DailyRecordInput,
} from '../../src/utils/climatology.js';

/** Consecutive ISO dates from start (inclusive) to end (inclusive) */
function dateRange(start: string, end: string): string[] {
  const dates: string[] = [];
  for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += 86_400_000) {
    dates.push(new Date(t).toISOString().slice(0, 10));
  }
  return dates;
}

/** Synthetic record: high = 50 + (year - 2000), low = high - 20, 0.1" rain daily */
function syntheticRecord(startYear: number, endYear: number): DailyRecordInput {
  const time = dateRange(`${startYear}-01-01`, `${endYear}-12-31`);
  const high = time.map((d) => 50 + (Number(d.slice(0, 4)) - 2000));
  return {
    time,
    high,
    low: high.map((h) => h - 20),
    precipitation: time.map(() => 0.1),
  };
}

describe('calendarDayIndex', () => {
  it('maps dates onto a leap-year calendar', () => {
    expect(calendarDayIndex('2023-01-01')).toBe(0);
    expect(calendarDayIndex('2024-02-29')).toBe(59);
    expect(calendarDayIndex('2023-03-01')).toBe(60);
    expect(calendarDayIndex('2024-03-01')).toBe(60);
    expect(calendarDayIndex('2023-12-31')).toBe(365);
  });

  it('returns -1 for malformed dates', () => {
    expect(calendarDayIndex('2023-13-01')).toBe(-1);
    expect(calendarDayIndex('nonsense')).toBe(-1);
  });
});

describe('parseBaseline', () => {
  it('accepts a valid range', () => {
    expect(parseBaseline('1991-2020', 1940, 2025)).toEqual({ startYear: 1991, endYear: 2020 });
  });

  it('rejects malformed, out-of-range and too-short baselines', () => {
    expect(parseBaseline('1991_2020', 1940, 2025)).toBeNull();
    expect(parseBaseline('1930-1960', 1940, 2025)).toBeNull();
    expect(parseBaseline('2000-2026', 1940, 2025)).toBeNull();
    expect(parseBaseline('2010-2015', 1940, 2025)).toBeNull();
    expect(parseBaseline('2020-1991', 1940, 2025)).toBeNull();
  });
});

describe('quantileSorted', () => {
  it('interpolates between samples', () => {
    const sorted = [0, 10, 20, 30, 40];
    expect(quantileSorted(sorted, 0)).toBe(0);
    expect(quantileSorted(sorted, 50)).toBe(20);
    expect(quantileSorted(sorted, 100)).toBe(40);
    expect(quantileSorted(sorted, 10)).toBeCloseTo(4);
  });

  it('returns NaN for an empty sample', () => {
    expect(quantileSorted([], 50)).toBeNaN();
  });
});

describe('percentileRank', () => {
  const quantiles = Array.from({ length: 100 / QUANTILE_STEP + 1 }, (_, i) => i * QUANTILE_STEP); // 0..100

  it('interpolates within the curve', () => {
    expect(percentileRank(50, quantiles)).toBeCloseTo(50);
    expect(percentileRank(92.5, quantiles)).toBeCloseTo(92.5);
  });

  it('clamps beyond the extremes', () => {
    expect(percentileRank(-5, quantiles)).toBe(0);
    expect(percentileRank(105, quantiles)).toBe(100);
  });
});

describe('computeClimatology', () => {
  const record = syntheticRecord(1990, 2021);
  const climatology = computeClimatology(record, { startYear: 1991, endYear: 2020 });

  it('returns a curve for every calendar day', () => {
    expect(climatology.high.mean).toHaveLength(366);
    expect(climatology.low.quantiles).toHaveLength(366);
    expect(climatology.recordHigh).toHaveLength(366);
    expect(climatology.quantileStep).toBe(QUANTILE_STEP);
  });

  it('only uses baseline years for normals', () => {
    // Baseline highs run 41 (1991) to 70 (2020); their mean is 55.5
    expect(climatology.high.mean[100]).toBeCloseTo(55.5, 1);
    expect(climatology.low.mean[100]).toBeCloseTo(35.5, 1);
    const q = climatology.high.quantiles[100]!;
    expect(q[0]).toBeCloseTo(41, 1);
    expect(q[q.length - 1]).toBeCloseTo(70, 1);
  });

  it('keeps quantile levels in ascending order', () => {
    for (const q of climatology.high.quantiles) {
      expect(q).not.toBeNull();
      for (let i = 1; i < q!.length; i++) {
        expect(q![i]).toBeGreaterThanOrEqual(q![i - 1]);
      }
    }
  });

  it('uses every year for records', () => {
    // 2021 is outside the baseline but holds the record high; 1990 the record low
    expect(climatology.recordHigh[0]).toEqual({ value: 71, year: 2021 });
    expect(climatology.recordLow[0]).toEqual({ value: 20, year: 1990 });
  });

  it('keeps the earliest year when a record is tied', () => {
    const time = ['2000-07-04', '2001-07-04', '2002-07-04'];
    const tied = computeClimatology({ time, high: [90, 90, 85], low: [60, 60, 65] }, { startYear: 2000, endYear: 2002 });
    const slot = calendarDayIndex('2000-07-04');
    expect(tied.recordHigh[slot]).toEqual({ value: 90, year: 2000 });
    expect(tied.recordLow[slot]).toEqual({ value: 60, year: 2000 });
  });

  it('records Feb 29 in its own slot', () => {
    const slot = calendarDayIndex('2020-02-29');
    expect(climatology.recordHigh[slot]).toEqual({ value: 70, year: 2020 });
  });

  it('averages precipitation per calendar day', () => {
    expect(climatology.precipitationMean[200]).toBeCloseTo(0.1, 3);
  });

  it('skips missing values', () => {
    const input = syntheticRecord(1991, 2020);
    const high = [...input.high] as Array<number | null>;
    high[10] = null;
    const result = computeClimatology({ ...input, high }, { startYear: 1991, endYear: 2020 });
    expect(result.high.mean[10]).not.toBeNull();
  });

  it('leaves curves empty when there are too few samples', () => {
    const sparse = computeClimatology(syntheticRecord(2020, 2020), { startYear: 2020, endYear: 2020 });
    expect(sparse.high.mean[100]).toBeNull();
    expect(sparse.high.quantiles[100]).toBeNull();
    expect(sparse.precipitationMean[100]).toBeNull();
    // Records don't need a minimum sample
    expect(sparse.recordHigh[100]).toEqual({ value: 70, year: 2020 });
  });
});

describe('packSeries', () => {
  it('rounds values and normalizes missing ones to null', () => {
    expect(packSeries([1.234, null, undefined, NaN, 5])).toEqual([1.2, null, null, null, 5]);
    expect(packSeries([0.126], 2)).toEqual([0.13]);
  });
});
