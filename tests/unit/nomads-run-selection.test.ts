/**
 * Choosing which NOMADS model run to use.
 *
 * NOAA posts a run's files over an hour or two, earliest forecast hours first. The service
 * used to accept a run once its 3-hour file existed, so a run still being posted was chosen
 * and the request then failed on a later hour ("Requested NOMADS model file was not found";
 * seen live with NAM at 02:07 UTC, when the 00Z run had hours up to 36 but not 72). It now
 * checks the last hour the request needs, and falls back to the previous complete run.
 *
 * The file fetch is replaced by a stub that knows which hours each run has posted.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type Fetch = (date: string, cycle: string, hour: number) => Promise<unknown[]>;

async function loadService() {
  vi.resetModules();
  // A decoder that loads; the stubbed fetch below never hands it real GRIB data
  vi.doMock('@mattnucc/gribberish', () => ({ parseMessagesFromBuffer: () => [] }));
  const nomads = await import('../../src/services/nomads.js');
  nomads.resetGribParserForTesting();
  return nomads;
}

describe('NOMADS run selection', () => {
  /** Last forecast hour posted, per "<yyyymmdd><cycle>" run; missing runs have nothing */
  let posted: Record<string, number>;
  let fetched: Array<{ run: string; hour: number }>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-28T02:07:00Z'));
    posted = {};
    fetched = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock('@mattnucc/gribberish');
    vi.resetModules();
  });

  async function serviceWithPostedRuns() {
    const { NOMADSService } = await loadService();
    const service = new NOMADSService();
    const internals = service as unknown as {
      fetchForecastMessages: Fetch;
      extractPointData: (messages: unknown[], lat: number, lon: number, ref: Date, hour: number) => unknown;
    };
    vi.spyOn(internals, 'fetchForecastMessages').mockImplementation(async (date, cycle, hour) => {
      const run = `${date}${cycle}`;
      fetched.push({ run, hour });
      if (hour > (posted[run] ?? -1)) {
        throw new Error('404 not posted yet');
      }
      return [{}];
    });
    vi.spyOn(internals, 'extractPointData').mockImplementation((_m, _lat, _lon, ref, hour) => ({
      timestamp: new Date(ref.getTime() + hour * 3600_000),
      temperatureF: 60,
    }));
    return service;
  }

  it('skips a NAM run that is still being posted and uses the previous complete one', async () => {
    posted = { '2026102800': 36, '2026102718': 84 };
    const service = await serviceWithPostedRuns();

    const forecast = await service.getNamForecast(39.1, -94.58, 3);

    expect(forecast.model_run).toBe('2026-10-27T18:00:00.000Z');
    // Every hour actually downloaded came from the complete run
    const downloads = fetched.filter((f) => f.run === '2026102718');
    expect(downloads.length).toBeGreaterThan(20);
    expect(fetched.filter((f) => f.run === '2026102800').every((f) => f.hour === 72)).toBe(true);
  });

  it('uses the newest run when it already has every hour the request needs', async () => {
    posted = { '2026102800': 36, '2026102718': 84 };
    const service = await serviceWithPostedRuns();

    // One day needs only hours 0-24, which the new 00Z run already has
    const forecast = await service.getNamForecast(39.1, -94.58, 1);

    expect(forecast.model_run).toBe('2026-10-28T00:00:00.000Z');
  });

  it('probes the last hour needed, capped at the model horizon', async () => {
    posted = { '2026102718': 84 };
    const service = await serviceWithPostedRuns();

    await service.getNamForecast(39.1, -94.58, 10); // NAM stops at 84 h

    const probes = fetched.filter((f) => f.run === '2026102800');
    expect(probes).toEqual([{ run: '2026102800', hour: 84 }]);
  });
});
