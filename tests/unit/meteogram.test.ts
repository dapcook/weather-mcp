/**
 * Unit tests for MeteogramService and /api/meteogram endpoint
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, Server, IncomingMessage, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { MeteogramService } from '../../src/services/meteogram.js';
import { NOAAService } from '../../src/services/noaa.js';
import { OpenMeteoService } from '../../src/services/openmeteo.js';

describe('MeteogramService', () => {
  let server: Server;
  let baseUrl: string;
  let meteogramService: MeteogramService;

  beforeAll(async () => {
    // Stub server simulating NOAA and Open-Meteo hourly endpoints
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');

      // 1. NOAA /points stub
      if (url.pathname.startsWith('/points/')) {
        res.writeHead(200, { 'Content-Type': 'application/geo+json' });
        res.end(
          JSON.stringify({
            properties: {
              gridId: 'EAX',
              gridX: 44,
              gridY: 51,
              timeZone: 'America/Chicago',
            },
          })
        );
        return;
      }

      // 2. NOAA /gridpoints/EAX/44,51/forecast/hourly stub
      if (url.pathname === '/gridpoints/EAX/44,51/forecast/hourly') {
        const periods = [];
        const baseMs = Date.parse('2026-11-01T20:00:00-06:00');
        for (let i = 0; i < 48; i++) {
          const t = new Date(baseMs + i * 3600_000).toISOString();
          periods.push({
            number: i + 1,
            name: '',
            startTime: t,
            endTime: new Date(baseMs + (i + 1) * 3600_000).toISOString(),
            isDaytime: i % 24 >= 7 && i % 24 <= 19,
            temperature: 60 + Math.round(10 * Math.sin((i / 24) * 2 * Math.PI)),
            temperatureUnit: 'F',
            probabilityOfPrecipitation: { unitCode: 'wmoUnit:percent', value: (i * 2) % 100 },
            dewpoint: { unitCode: 'wmoUnit:degC', value: 10 + (i % 5) },
            relativeHumidity: { unitCode: 'wmoUnit:percent', value: 70 + (i % 20) },
            windSpeed: `${5 + (i % 10)} mph`,
            windDirection: 'SSE',
            shortForecast: 'Partly Cloudy',
          });
        }
        res.writeHead(200, { 'Content-Type': 'application/geo+json' });
        res.end(JSON.stringify({ properties: { periods } }));
        return;
      }

      // 3. NOAA /gridpoints/EAX/44,51 stub (gridpoint properties)
      if (url.pathname === '/gridpoints/EAX/44,51') {
        res.writeHead(200, { 'Content-Type': 'application/geo+json' });
        res.end(
          JSON.stringify({
            properties: {
              apparentTemperature: {
                values: [{ validTime: '2026-11-01T00:00:00+00:00/P3D', value: 16.5 }],
              },
              windGust: {
                values: [{ validTime: '2026-11-01T00:00:00+00:00/P3D', value: 24 }],
              },
              skyCover: {
                values: [{ validTime: '2026-11-01T00:00:00+00:00/P3D', value: 65 }],
              },
              quantitativePrecipitation: {
                values: [{ validTime: '2026-11-01T00:00:00+00:00/P3D', value: 2.5 }],
              },
              probabilityOfThunder: {
                values: [{ validTime: '2026-11-01T00:00:00+00:00/P3D', value: 20 }],
              },
            },
          })
        );
        return;
      }

      // 4. Open-Meteo /forecast stub
      if (url.pathname === '/v1/forecast' || url.pathname === '/forecast') {
        const hours = 48;
        const time = [];
        const temp = [];
        const dew = [];
        const app = [];
        const wind = [];
        const gusts = [];
        const dir = [];
        const rh = [];
        const pop = [];
        const cloud = [];
        const precip = [];
        const isDay = [];
        const weatherCode = [];

        const baseMs = Date.parse('2026-11-01T00:00:00Z');
        for (let i = 0; i < hours; i++) {
          time.push(new Date(baseMs + i * 3600_000).toISOString().slice(0, 16));
          temp.push(58 + (i % 12));
          dew.push(52 + (i % 8));
          app.push(57 + (i % 12));
          wind.push(8 + (i % 6));
          gusts.push(16 + (i % 10));
          dir.push((180 + i * 10) % 360);
          rh.push(65 + (i % 25));
          pop.push((i * 5) % 100);
          cloud.push(40 + (i % 50));
          precip.push(i % 6 === 0 ? 0.15 : 0);
          isDay.push(i % 24 >= 7 && i % 24 <= 19 ? 1 : 0);
          weatherCode.push(i % 12 === 0 ? 95 : 3);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            latitude: 39.1,
            longitude: -94.58,
            elevation: 250,
            timezone: 'America/Chicago',
            daily: {
              time: ['2026-11-01', '2026-11-02'],
              temperature_2m_max: [70, 72],
              temperature_2m_min: [50, 52],
            },
            hourly: {
              time,
              temperature_2m: temp,
              dewpoint_2m: dew,
              apparent_temperature: app,
              wind_speed_10m: wind,
              wind_gusts_10m: gusts,
              wind_direction_10m: dir,
              relative_humidity_2m: rh,
              precipitation_probability: pop,
              cloud_cover: cloud,
              precipitation: precip,
              rain: precip,
              snowfall: new Array(hours).fill(0),
              is_day: isDay,
              weather_code: weatherCode,
            },
          })
        );
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    const noaaService = new NOAAService({ baseURL: baseUrl });
    const openMeteoService = new OpenMeteoService({ forecastURL: baseUrl });
    meteogramService = new MeteogramService({ noaaService, openMeteoService });
  });

  it('determines US coverage correctly', () => {
    expect(meteogramService.isNoaaCovered(39.0997, -94.5786)).toBe(true); // Kansas City
    expect(meteogramService.isNoaaCovered(61.2181, -149.9003)).toBe(true); // Anchorage AK
    expect(meteogramService.isNoaaCovered(21.3069, -157.8583)).toBe(true); // Honolulu HI
    expect(meteogramService.isNoaaCovered(18.4655, -66.1057)).toBe(true); // San Juan PR
    expect(meteogramService.isNoaaCovered(51.5074, -0.1278)).toBe(false); // London
    expect(meteogramService.isNoaaCovered(35.6762, 139.6503)).toBe(false); // Tokyo
  });

  it('generates NOAA hourly meteogram data with all panels populated', async () => {
    const data = await meteogramService.getMeteogram(39.0997, -94.5786, 2, 'noaa');

    expect(data).toBeDefined();
    expect(data.model.id).toBe('noaa');
    expect(data.model.source).toBe('noaa');
    expect(data.hours.length).toBe(48);

    const h0 = data.hours[0];
    expect(h0.temperature).toBeGreaterThan(0);
    expect(h0.dewpoint).not.toBeNull();
    expect(h0.windSpeed).toBeGreaterThanOrEqual(0);
    expect(h0.windDirectionCompass).toBe('SSE');
    expect(h0.cloudCover).toBe(65);
    expect(h0.windGust).toBe(15); // 24 km/h -> ~15 mph
    expect(h0.thunderProbability).toBe(20);
    expect(h0.precipitation).toBeGreaterThan(0);
  });

  it('generates Open-Meteo multi-model meteogram data (ECMWF, GFS, ICON, etc.)', async () => {
    const data = await meteogramService.getMeteogram(39.0997, -94.5786, 2, 'ecmwf');

    expect(data).toBeDefined();
    expect(data.model.id).toBe('ecmwf');
    expect(data.model.source).toBe('openmeteo');
    expect(data.hours.length).toBe(48);

    const h0 = data.hours[0];
    expect(h0.temperature).toBe(58);
    expect(h0.dewpoint).toBe(52);
    expect(h0.windSpeed).toBe(8);
    expect(h0.windGust).toBe(16);
    expect(h0.relativeHumidity).toBe(65);
    expect(h0.cloudCover).toBe(40);
    expect(h0.thunderProbability).toBe(80); // WMO code 95
  });

  it('rejects NOAA requests for international locations', async () => {
    await expect(
      meteogramService.getMeteogram(51.5074, -0.1278, 2, 'noaa')
    ).rejects.toThrow('NOAA NWS hourly forecast only covers the United States');
  });

  it('routes auto mode to NOAA in US and ECMWF internationally', async () => {
    const usData = await meteogramService.getMeteogram(39.0997, -94.5786, 2, 'auto');
    expect(usData.model.id).toBe('noaa');

    const intlData = await meteogramService.getMeteogram(51.5074, -0.1278, 2, 'auto');
    expect(intlData.model.id).toBe('ecmwf');
  });
});
