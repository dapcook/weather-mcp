/**
 * NOMADS precipitation totals and partial days.
 *
 * Each GFS/NAM/HRRR file carries two precipitation (APCP) messages: the total since the run
 * started, and a "bucket" for the last few hours. The service used to take the larger one
 * (the run total) and add those up across the day, so totals grew with lead time (GFS showed
 * 6.19 in for a day other models put at 0-0.39 in). It now differences consecutive run totals.
 *
 * A run also starts partway through a day, so the first day's low (and the last day's high)
 * can be missing; those are left out instead of shown wrong.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { findRunTotalPrecipitation, precipitationFromRunTotals } from '../../src/services/nomads.js';

const RUN = new Date('2026-10-28T18:00:00Z'); // 1 pm in Kansas City (CDT, UTC-5)
const HOUR = 3600_000;

describe('findRunTotalPrecipitation', () => {
  const total = { varAbbrev: 'APCP', referenceDate: RUN, forecastDate: RUN };
  const bucket = { varAbbrev: 'APCP', referenceDate: RUN, forecastDate: new Date(RUN.getTime() + 6 * HOUR) };

  it('picks the message accumulated since the run started, whatever the order', () => {
    expect(findRunTotalPrecipitation([bucket, total], RUN)).toBe(total);
    expect(findRunTotalPrecipitation([total, bucket], RUN)).toBe(total);
  });

  it('uses the run start when the message has no reference time', () => {
    const noRef = { varAbbrev: 'APCP', forecastDate: RUN };
    expect(findRunTotalPrecipitation([noRef], RUN)).toBe(noRef);
  });

  it('finds nothing when only a bucket (or no precipitation) is present', () => {
    expect(findRunTotalPrecipitation([bucket], RUN)).toBeUndefined();
    expect(findRunTotalPrecipitation([{ varAbbrev: 'TMP', referenceDate: RUN, forecastDate: RUN }], RUN)).toBeUndefined();
  });
});

describe('precipitationFromRunTotals', () => {
  it('differences consecutive totals; the first step has no interval', () => {
    expect(precipitationFromRunTotals([undefined, 0.1, 0.25, 0.25, 0.4])).toEqual([undefined, 0.1, 0.15, 0, expect.closeTo(0.15, 10)]);
  });

  it('lets the next known total cover a missing step', () => {
    expect(precipitationFromRunTotals([undefined, 0.1, undefined, 0.4])).toEqual([undefined, 0.1, undefined, expect.closeTo(0.3, 10)]);
  });

  it('turns small negative differences (rounding) into zero', () => {
    expect(precipitationFromRunTotals([undefined, 0.2, 0.19999])).toEqual([undefined, 0.2, 0]);
  });
});

describe('NOMADS daily summary', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(RUN.getTime() + 2 * HOUR));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock('@mattnucc/gribberish');
    vi.resetModules();
  });

  /**
   * A NAM-like run where 1 mm falls in every 3-hour interval, so the run total at hour h is
   * h/3 mm. Each file carries the run total and the 3-hour bucket, as real files do.
   * Temperature follows the clock: 50 °F at 4 am local, 70 °F at 4 pm, 60 °F otherwise.
   */
  async function namWithSteadyRain() {
    vi.resetModules();
    vi.doMock('@mattnucc/gribberish', () => ({ parseMessagesFromBuffer: () => [] }));
    const nomads = await import('../../src/services/nomads.js');
    nomads.resetGribParserForTesting();
    const service = new nomads.NOMADSService();
    const internals = service as unknown as {
      fetchForecastMessages: (date: string, cycle: string, hour: number) => Promise<unknown[]>;
      extractNearestValue: (message: { data: number[] }) => number;
    };
    vi.spyOn(internals, 'fetchForecastMessages').mockImplementation(async (date, cycle, hour) => {
      if (`${date}${cycle}` !== '2026102818') {
        throw new Error('404');
      }
      const valid = new Date(RUN.getTime() + hour * HOUR);
      const localHour = (valid.getUTCHours() + 24 - 5) % 24;
      const tempF = localHour === 4 ? 50 : localHour === 16 ? 70 : 60;
      const messages: unknown[] = [
        { key: 'TMP:2 in above ground', varAbbrev: 'TMP', data: [((tempF - 32) * 5) / 9 + 273.15], referenceDate: RUN, forecastDate: valid },
      ];
      if (hour > 0) {
        messages.push({ key: 'APCP:total', varAbbrev: 'APCP', data: [hour / 3], referenceDate: RUN, forecastDate: RUN });
        messages.push({ key: 'APCP:bucket', varAbbrev: 'APCP', data: [1], referenceDate: RUN, forecastDate: new Date(valid.getTime() - 3 * HOUR) });
      }
      return messages;
    });
    vi.spyOn(internals, 'extractNearestValue').mockImplementation((message) => message.data[0]);
    return service;
  }

  it('adds up interval rain, not run totals', async () => {
    const service = await namWithSteadyRain();
    const forecast = await service.getNamForecast(39.1, -94.58, 3);
    const { time, precipitation_sum } = forecast.daily;

    // A whole day has eight 3-hour intervals of 1 mm = 0.31 in
    expect(time[1]).toBe('2026-10-29');
    expect(precipitation_sum[1]).toBe(0.31); // 8 mm, rounded to 2 decimals
    // Summing run totals instead would give tens of millimetres by day 2
    expect(Math.max(...precipitation_sum)).toBeLessThan(0.35);
  });

  it("leaves out the first day's low when the run starts after the early morning", async () => {
    const service = await namWithSteadyRain();
    const forecast = await service.getNamForecast(39.1, -94.58, 3);
    const { time, temperature_2m_max, temperature_2m_min } = forecast.daily;

    expect(time[0]).toBe('2026-10-28'); // starts at 1 pm local
    expect(temperature_2m_min[0]).toBeNaN();
    expect(temperature_2m_max[0]).toBe(70);
    // A whole day has both
    expect(temperature_2m_min[1]).toBe(50);
    expect(temperature_2m_max[1]).toBe(70);
  });
});
