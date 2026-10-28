/**
 * The model comparison's Open-Meteo models (ECMWF IFS, ECMWF AIFS, ICON, GEM).
 *
 * Runs the real OpenMeteoService and ModelComparisonService against a local server that
 * answers like Open-Meteo: /v1/forecast returns a daily series for the requested model
 * (nulls past that model's horizon, like the real API), and /data/<model>/static/meta.json
 * reports its latest run. NOMADS (GFS/NAM/HRRR) is replaced by a stub that fails, so only
 * the Open-Meteo rows are exercised; those failures also cover the "unavailable" notes.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenMeteoService } from '../../src/services/openmeteo.js';
import { ModelComparisonService } from '../../src/services/modelComparison.js';
import { NOMADSService } from '../../src/services/nomads.js';
import { LocationStore } from '../../src/services/locationStore.js';
import { ServiceUnavailableError } from '../../src/errors/ApiError.js';
import { handleGetModelComparisonForecast, parseModels } from '../../src/handlers/modelComparisonHandler.js';

/** Days of real output per model, as the live API returned them on 2026-10-28 */
const DAYS_WITH_DATA: Record<string, number> = {
  ecmwf_ifs: 15,
  ecmwf_aifs025_single: 15,
  icon_global: 7,
  gem_global: 10,
};
/** Each model gets a distinct high so rows can be told apart */
const HIGH: Record<string, number> = { ecmwf_ifs: 70, ecmwf_aifs025_single: 71, icon_global: 72, gem_global: 73 };

const failingNomads = {
  getForecast: async () => { throw new ServiceUnavailableError('NOMADS', 'stub: no GFS'); },
  getNamForecast: async () => { throw new ServiceUnavailableError('NOMADS', 'stub: no NAM'); },
  getHrrrForecast: async () => { throw new ServiceUnavailableError('NOMADS', 'stub: no HRRR'); },
} as unknown as NOMADSService;

describe('model comparison: Open-Meteo models', () => {
  let server: Server;
  let baseURL: string;
  let forecastRequests: URLSearchParams[];
  let metaRequests: string[];
  /** Run start reported in each model's metadata, in seconds; null means a 404 */
  let runSeconds: Record<string, number | null>;
  let failModel: string | null;
  let openMeteo: OpenMeteoService;
  let comparison: ModelComparisonService;
  let dir: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const meta = /^\/data\/([\w-]+)\/static\/meta\.json$/.exec(url.pathname);
      if (meta) {
        metaRequests.push(meta[1]);
        const seconds = runSeconds[meta[1]];
        if (seconds === null || seconds === undefined) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ last_run_initialisation_time: seconds, update_interval_seconds: 21600 }));
        return;
      }
      if (url.pathname === '/v1/forecast') {
        forecastRequests.push(url.searchParams);
        const model = url.searchParams.get('models') ?? '';
        if (model === failModel) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: true, reason: 'stub failure' }));
          return;
        }
        const n = Number(url.searchParams.get('forecast_days'));
        const today = new Date();
        const time = Array.from({ length: n }, (_, i) =>
          new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + i)).toISOString().slice(0, 10));
        const has = (i: number) => i < (DAYS_WITH_DATA[model] ?? 0);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          latitude: 39.1, longitude: -94.58, generationtime_ms: 1, utc_offset_seconds: 0,
          timezone: 'UTC', timezone_abbreviation: 'UTC', elevation: 250,
          daily: {
            time,
            temperature_2m_max: time.map((_, i) => (has(i) ? HIGH[model] : null)),
            temperature_2m_min: time.map((_, i) => (has(i) ? 50 : null)),
            // GEM reports a chance past its run, as the real API does; that alone must not make a day
            precipitation_probability_max: time.map((_, i) => (model === 'gem_global' || has(i) ? 40 : null)),
            precipitation_sum: time.map((_, i) => (has(i) ? 0.12 : null)),
            wind_speed_10m_max: time.map((_, i) => (has(i) ? 15 : null)),
            relative_humidity_2m_mean: time.map((_, i) => (has(i) ? 65 : null)),
          },
        }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    dir = mkdtempSync(join(tmpdir(), 'model-comparison-'));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    forecastRequests = [];
    metaRequests = [];
    failModel = null;
    const recent = Math.floor(Date.now() / 1000 / 21600) * 21600; // the latest 6-hourly cycle
    runSeconds = { ecmwf_ifs: recent, ecmwf_aifs025_single: recent, dwd_icon: recent, cmc_gem_gdps: recent };
    openMeteo = new OpenMeteoService({ forecastURL: baseURL, timeout: 5000 });
    comparison = new ModelComparisonService(failingNomads, openMeteo);
  });

  describe('OpenMeteoService.getModelForecast', () => {
    it('asks for that one model, in °F, mph and inches', async () => {
      await openMeteo.getModelForecast(39.1, -94.58, 10, 'ecmwf_ifs');
      expect(forecastRequests).toHaveLength(1);
      const params = forecastRequests[0];
      expect(params.get('models')).toBe('ecmwf_ifs');
      expect(params.get('forecast_days')).toBe('10');
      expect(params.get('temperature_unit')).toBe('fahrenheit');
      expect(params.get('wind_speed_unit')).toBe('mph');
      expect(params.get('precipitation_unit')).toBe('inch');
      expect(params.get('daily')?.split(',')).toEqual(expect.arrayContaining([
        'temperature_2m_max', 'temperature_2m_min', 'precipitation_probability_max',
        'precipitation_sum', 'wind_speed_10m_max', 'relative_humidity_2m_mean',
      ]));
    });

    it('caches each model separately', async () => {
      await openMeteo.getModelForecast(39.1, -94.58, 10, 'ecmwf_ifs');
      await openMeteo.getModelForecast(39.1, -94.58, 10, 'ecmwf_ifs');
      await openMeteo.getModelForecast(39.1, -94.58, 10, 'icon_global');
      expect(forecastRequests.map((p) => p.get('models'))).toEqual(['ecmwf_ifs', 'icon_global']);
    });

    it('refuses a model it does not know, without calling the API', async () => {
      await expect(openMeteo.getModelForecast(39.1, -94.58, 10, 'best_match' as never)).rejects.toThrow(/Unknown forecast model/);
      await expect(openMeteo.getModelForecast(39.1, -94.58, 17, 'ecmwf_ifs')).rejects.toThrow(/between 1 and 16/);
      expect(forecastRequests).toHaveLength(0);
    });
  });

  describe('OpenMeteoService.getModelRunTime', () => {
    it('reads the latest run from the model metadata', async () => {
      runSeconds.dwd_icon = Date.UTC(2026, 9, 27, 18) / 1000;
      const now = Date.now;
      Date.now = () => Date.UTC(2026, 9, 28, 2);
      try {
        expect(await openMeteo.getModelRunTime('icon_global')).toBe('2026-10-27T18:00:00.000Z');
        expect(metaRequests).toEqual(['dwd_icon']);
      } finally {
        Date.now = now;
      }
    });

    it('treats a run more than two days old as unknown (stale metadata)', async () => {
      runSeconds.cmc_gem_gdps = Date.UTC(2026, 4, 26) / 1000; // what the live GEM metadata said in Oct 2026
      expect(await openMeteo.getModelRunTime('gem_global')).toBeUndefined();
    });

    it('returns undefined, not an error, when the metadata is missing', async () => {
      runSeconds.ecmwf_ifs = null;
      expect(await openMeteo.getModelRunTime('ecmwf_ifs')).toBeUndefined();
    });
  });

  describe('ModelComparisonService', () => {
    it('defaults to GFS, NAM, ECMWF, ICON and GEM', async () => {
      const result = await comparison.compare(39.1, -94.58, 7, []);
      expect(result.series.map((s) => s.model)).toEqual(['ecmwf', 'icon', 'gem']);
      expect(result.notes).toEqual(expect.arrayContaining(['GFS unavailable: stub: no GFS', 'NAM unavailable: stub: no NAM']));
      expect(forecastRequests.map((p) => p.get('models')).sort()).toEqual(['ecmwf_ifs', 'gem_global', 'icon_global']);
    });

    it("gives each model its own values and run time", async () => {
      const result = await comparison.compare(39.1, -94.58, 3, ['ecmwf', 'ecmwf_aifs', 'icon', 'gem']);
      const today = result.days[0];
      const high = Object.fromEntries(result.series.map((s) => [s.model, s.daily[today]?.temperatureHighF]));
      expect(high).toEqual({ ecmwf: 70, ecmwf_aifs: 71, icon: 72, gem: 73 });
      const ecmwf = result.series.find((s) => s.model === 'ecmwf')!;
      expect(ecmwf.label).toBe('ECMWF IFS (Open-Meteo)');
      expect(ecmwf.modelRun).toMatch(/^\d{4}-\d\d-\d\dT\d\d:00:00\.000Z$/);
      expect(ecmwf.daily[today]).toEqual({
        temperatureHighF: 70, temperatureLowF: 50, precipitationChancePct: 40,
        precipitationTotalIn: 0.12, windMaxMph: 15, humidityMeanPct: 65,
      });
    });

    it("leaves out days past a model's horizon and says so", async () => {
      const result = await comparison.compare(39.1, -94.58, 10, ['ecmwf', 'icon', 'gem']);
      const days = (model: string) => Object.keys(result.series.find((s) => s.model === model)!.daily).length;
      expect(days('ecmwf')).toBe(10);
      expect(days('icon')).toBe(7);
      expect(days('gem')).toBe(10); // GEM's chance past day 10 doesn't count, and the window is 10 days
      expect(result.notes.some((n) => n.startsWith('ICON Global (DWD, via Open-Meteo) reaches about 7.5 days'))).toBe(true);
      expect(result.notes.some((n) => n.startsWith('ECMWF IFS (Open-Meteo) reaches'))).toBe(false);
    });

    it('keeps the other models when one fails', async () => {
      failModel = 'gem_global';
      const result = await comparison.compare(39.1, -94.58, 3, ['ecmwf', 'icon', 'gem']);
      expect(result.series.map((s) => s.model)).toEqual(['ecmwf', 'icon']);
      expect(result.notes.some((n) => n.startsWith('GEM Global (Canada, via Open-Meteo) unavailable:'))).toBe(true);
    });
  });

  describe('get_model_comparison_forecast', () => {
    const run = async (args: Record<string, unknown>) => {
      const store = new LocationStore(join(dir, 'locations.json'));
      const result = await handleGetModelComparisonForecast({ latitude: 39.1, longitude: -94.58, ...args }, comparison, store);
      return result.content[0].text;
    };

    it('accepts the old "ecmwf_proxy" name, and short names', () => {
      expect(parseModels(['ecmwf_proxy'])).toEqual(['ecmwf']);
      expect(parseModels(['AIFS', 'icon', 'gem', 'ecmwf'])).toEqual(['ecmwf_aifs', 'icon', 'gem', 'ecmwf']);
      expect(parseModels(['nonsense'])).toEqual(['gfs', 'nam', 'ecmwf', 'icon', 'gem']);
      expect(parseModels(undefined)).toEqual(['gfs', 'nam', 'ecmwf', 'icon', 'gem']);
    });

    it('labels each model, its run, and days past its horizon', async () => {
      runSeconds.cmc_gem_gdps = Date.UTC(2026, 4, 26) / 1000;
      const text = await run({ days: 9, models: ['ecmwf', 'icon', 'gem'] });
      expect(text).toMatch(/- \*\*ECMWF IFS \(Open-Meteo\):\*\* run \d{4}-\d\d-\d\d \d\d:00Z, horizon 360h/);
      expect(text).toContain('- **GEM Global (Canada, via Open-Meteo):** latest run (time not reported), horizon 240h');
      expect(text).toContain('- **ICON Global (DWD, via Open-Meteo):** N/A (beyond its ~180h horizon)');
      expect(text).toContain('- **ECMWF IFS (Open-Meteo):** High 70°F / Low 50°F; Precip 40%; Total 0.12 in; Wind 15 mph; Humidity 65%');
      expect(text).not.toMatch(/proxy/i);
    });
  });
});
