/**
 * get_forecast's `model` option: one weather model's own forecast from Open-Meteo.
 *
 * Runs the real OpenMeteoService and forecast handler against a local server that answers like
 * Open-Meteo: a chosen model returns nulls for variables it doesn't provide and for days past its
 * run (as the live API does), and a regional model asked about a place outside its area gets
 * HTTP 400 "No data is available for this location".
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenMeteoService } from '../../src/services/openmeteo.js';
import { LocationStore } from '../../src/services/locationStore.js';
import { NOAAService } from '../../src/services/noaa.js';
import { NOMADSService } from '../../src/services/nomads.js';
import { DataNotFoundError } from '../../src/errors/ApiError.js';
import { handleGetForecast, parseForecastModel } from '../../src/handlers/forecastHandler.js';

/** Days of data per model (the rest come back null); ICON's is short, like the real one */
const DAYS_WITH_DATA: Record<string, number> = { icon_global: 7, ecmwf_ifs: 15, best_match: 16 };

describe("get_forecast's model option", () => {
  let server: Server;
  let baseURL: string;
  let requests: URLSearchParams[];
  let dir: string;
  let openMeteo: OpenMeteoService;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname.startsWith('/data/')) {
        res.writeHead(404).end();
        return;
      }
      requests.push(url.searchParams);
      const model = url.searchParams.get('models') ?? 'best_match';
      if (model === 'ncep_hrrr_conus') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: true, reason: 'No data is available for this location' }));
        return;
      }
      const n = Number(url.searchParams.get('forecast_days'));
      const time = Array.from({ length: n }, (_, i) => new Date(Date.UTC(2026, 9, 28 + i)).toISOString().slice(0, 10));
      const has = (i: number) => i < (DAYS_WITH_DATA[model] ?? n);
      const series = (value: number) => time.map((_, i) => (has(i) ? value : null));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        latitude: 39.1, longitude: -94.58, generationtime_ms: 1, utc_offset_seconds: 0,
        timezone: 'UTC', timezone_abbreviation: 'UTC', elevation: 276,
        daily: {
          time,
          weather_code: series(3),
          temperature_2m_max: series(70),
          temperature_2m_min: series(50),
          apparent_temperature_max: series(68),
          apparent_temperature_min: series(47),
          sunrise: time.map((d) => `${d}T07:40`),
          sunset: time.map((d) => `${d}T18:20`),
          // Single models (and sometimes best match) have no UV index: always null here
          uv_index_max: time.map(() => null),
          precipitation_probability_max: series(30),
          precipitation_sum: series(0.1),
          wind_speed_10m_max: series(12),
          wind_gusts_10m_max: time.map(() => null),
          wind_direction_10m_dominant: series(180),
        },
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    dir = mkdtempSync(join(tmpdir(), 'forecast-model-'));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    requests = [];
    openMeteo = new OpenMeteoService({ forecastURL: baseURL, timeout: 5000 });
  });

  const forecast = async (args: Record<string, unknown>) => {
    const result = await handleGetForecast(
      { latitude: 39.1, longitude: -94.58, ...args },
      {} as NOAAService, // never reached when a model is chosen
      openMeteo,
      {} as NOMADSService,
      new LocationStore(join(dir, 'locations.json'))
    );
    return result.content[0].text;
  };

  it('asks Open-Meteo for that model, even for a US location', async () => {
    const text = await forecast({ model: 'ecmwf', days: 3 });
    expect(requests).toHaveLength(1);
    expect(requests[0].get('models')).toBe('ecmwf_ifs');
    expect(text).toContain('**Model:** ECMWF IFS (European Centre), latest run (time not reported)');
    expect(text).toContain('*Data source: ECMWF IFS (European Centre) via Open-Meteo, this model only (not blended with others)*');
  });

  it("shows only the days the model reaches, and says so", async () => {
    const text = await forecast({ model: 'icon', days: 10 });
    expect(text.match(/^## /gm)).toHaveLength(7);
    expect(text).toContain('ICON Global (Germany, DWD) reaches about 7.5 days; showing 7 of the 10 days requested.');
  });

  it('leaves out fields the model does not provide instead of printing zeros or crashing', async () => {
    const text = await forecast({ model: 'icon', days: 10 });
    expect(text).not.toMatch(/UV Index|Wind Gusts|NaN|null|undefined| 0°F/);
    expect(text).toContain('**Temperature:** High 70°F / Low 50°F');
  });

  it('caches each model separately from the default blend', async () => {
    await openMeteo.getForecast(39.1, -94.58, 3, false);
    await openMeteo.getForecast(39.1, -94.58, 3, false, 'ecmwf_ifs');
    await openMeteo.getForecast(39.1, -94.58, 3, false, 'ecmwf_ifs');
    expect(requests.map((p) => p.get('models'))).toEqual([null, 'ecmwf_ifs']);
  });

  it('explains a regional model asked about a place outside its area', async () => {
    const error = await openMeteo.getForecast(51.5, -0.12, 2, false, 'ncep_hrrr_conus').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DataNotFoundError);
    expect((error as DataNotFoundError).userMessage).toMatch(/NAM and HRRR cover the continental US only/);
    expect((error as DataNotFoundError).userMessage).not.toMatch(/1940/);
  });

  it('refuses a model with a source that cannot provide it', async () => {
    await expect(forecast({ model: 'gfs', source: 'noaa' })).rejects.toThrow(/use source "auto" or "openmeteo"/);
    await expect(forecast({ model: 'gfs', source: 'nomads' })).rejects.toThrow(/use source "auto" or "openmeteo"/);
    expect(requests).toHaveLength(0);
  });

  it('accepts short names and rejects unknown models', () => {
    expect(parseForecastModel(undefined)).toBeUndefined();
    expect(parseForecastModel('auto')).toBeUndefined();
    expect(parseForecastModel('AIFS')).toBe('ecmwf_aifs');
    expect(parseForecastModel(' hrrr ')).toBe('hrrr');
    expect(() => parseForecastModel('ukmo')).toThrow(/Must be one of: ecmwf, ecmwf_aifs, icon, gem, gfs, nam, hrrr/);
    expect(() => parseForecastModel(5)).toThrow(/must be a string/);
  });

  it('without a model, still uses the blend and survives a missing UV index', async () => {
    const text = await forecast({ source: 'openmeteo', days: 2 });
    expect(requests[0].get('models')).toBeNull();
    expect(text).toContain('*Data source: Open-Meteo (Global)*');
    expect(text).not.toMatch(/UV Index|NaN|null/);
    expect(text.match(/^## /gm)).toHaveLength(2);
  });
});
