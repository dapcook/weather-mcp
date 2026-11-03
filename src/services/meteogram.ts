/**
 * Service for generating Hourly Weather Meteograms
 * Integrates high-resolution hourly forecast time-series from NOAA NWS
 * and Open-Meteo multi-model API (ECMWF, GFS, HRRR, NAM, ICON, GEM).
 */

import { NOAAService } from './noaa.js';
import { OpenMeteoService, FORECAST_MODELS, OpenMeteoModelId } from './openmeteo.js';
import { Cache } from '../utils/cache.js';
import { CacheConfig } from '../config/cache.js';
import { validateLatitude, validateLongitude } from '../utils/validation.js';
import { parseValidTime } from '../utils/precipType.js';
import { logger } from '../utils/logger.js';
import { InvalidLocationError } from '../errors/ApiError.js';
import {
  MeteogramHour,
  MeteogramModelId,
  MeteogramResponse,
} from '../types/meteogram.js';
import type { GridpointDataSeries, GridpointProperties } from '../types/noaa.js';

const COMPASS_TO_DEGREES: Record<string, number> = {
  N: 0,
  NNE: 22.5,
  NE: 45,
  ENE: 67.5,
  E: 90,
  ESE: 112.5,
  SE: 135,
  SSE: 157.5,
  S: 180,
  SSW: 202.5,
  SW: 225,
  WSW: 247.5,
  W: 270,
  WNW: 292.5,
  NW: 315,
  NNW: 337.5,
};

function degreesToCompass(deg: number): string {
  const directions = [
    'N',
    'NNE',
    'NE',
    'ENE',
    'E',
    'ESE',
    'SE',
    'SSE',
    'S',
    'SSW',
    'SW',
    'WSW',
    'W',
    'WNW',
    'NW',
    'NNW',
  ];
  const index = Math.round(deg / 22.5) % 16;
  return directions[index];
}

function parseWindSpeedMph(str: string | undefined): number {
  if (!str) return 0;
  const match = /(\d+)(?:\s*to\s*(\d+))?/.exec(str);
  if (!match) return 0;
  if (match[2]) {
    return Math.round((Number(match[1]) + Number(match[2])) / 2);
  }
  return Number(match[1]);
}

function lookupIntervalValue(
  series: GridpointDataSeries | undefined,
  timeMs: number
): number | null {
  if (!series || !series.values || !Array.isArray(series.values)) return null;
  for (const entry of series.values) {
    const span = parseValidTime(entry.validTime);
    if (
      span &&
      timeMs >= span.start &&
      timeMs < span.end &&
      entry.value !== null &&
      Number.isFinite(entry.value)
    ) {
      return entry.value;
    }
  }
  return null;
}

export class MeteogramService {
  private readonly noaaService: NOAAService;
  private readonly openMeteoService: OpenMeteoService;
  private readonly cache: Cache<MeteogramResponse>;

  constructor(options?: {
    noaaService?: NOAAService;
    openMeteoService?: OpenMeteoService;
  }) {
    this.noaaService = options?.noaaService ?? new NOAAService();
    this.openMeteoService = options?.openMeteoService ?? new OpenMeteoService();
    this.cache = new Cache<MeteogramResponse>(CacheConfig.maxSize);
  }

  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Determine if coordinates are within NOAA NWS coverage
   */
  isNoaaCovered(latitude: number, longitude: number): boolean {
    const inConus =
      latitude >= 24.5 && latitude <= 49.4 && longitude >= -125 && longitude <= -66.9;
    const inAlaska =
      latitude >= 51 && latitude <= 71.4 && longitude >= -180 && longitude <= -129.9;
    const inHawaii =
      latitude >= 18.9 && latitude <= 28.5 && longitude >= -178.4 && longitude <= -154.8;
    const inPuertoRico =
      latitude >= 17.9 && latitude <= 18.5 && longitude >= -67.3 && longitude <= -65.2;
    return inConus || inAlaska || inHawaii || inPuertoRico;
  }

  /**
   * Fetch normalized hourly meteogram dataset
   */
  async getMeteogram(
    latitude: number,
    longitude: number,
    days = 2,
    requestedModel: MeteogramModelId = 'auto'
  ): Promise<MeteogramResponse> {
    validateLatitude(latitude);
    validateLongitude(longitude);

    const clampedDays = Math.max(1, Math.min(7, Math.round(days)));
    const cacheKey = Cache.generateKey(
      'meteogram',
      Math.round(latitude * 100) / 100,
      Math.round(longitude * 100) / 100,
      clampedDays,
      requestedModel
    );

    if (CacheConfig.enabled) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return cached;
      }
    }

    const inUS = this.isNoaaCovered(latitude, longitude);

    // Resolve model
    let modelId: MeteogramModelId = requestedModel;
    if (modelId === 'auto') {
      modelId = inUS ? 'noaa' : 'ecmwf';
    }

    let response: MeteogramResponse;
    if (modelId === 'noaa') {
      if (!inUS) {
        throw new InvalidLocationError(
          'NOAA',
          'NOAA NWS hourly forecast only covers the United States, Alaska, Hawaii, and Puerto Rico. Please select another model (e.g. ECMWF, GFS, ICON).'
        );
      }
      response = await this.fetchNoaaMeteogram(latitude, longitude, clampedDays);
    } else {
      response = await this.fetchOpenMeteoMeteogram(
        latitude,
        longitude,
        clampedDays,
        modelId
      );
    }

    if (CacheConfig.enabled) {
      this.cache.set(cacheKey, response, CacheConfig.ttl.forecast);
    }

    return response;
  }

  private async fetchNoaaMeteogram(
    latitude: number,
    longitude: number,
    days: number
  ): Promise<MeteogramResponse> {
    const pointData = await this.noaaService.getPointData(latitude, longitude);
    const { gridId, gridX, gridY, timeZone } = pointData.properties;

    const [hourlyForecast, gridpointData] = await Promise.all([
      this.noaaService.getHourlyForecast(gridId, gridX, gridY),
      this.noaaService
        .getGridpointData(gridId, gridX, gridY)
        .catch((err) => {
          logger.warn('Failed to fetch NOAA gridpoint properties for meteogram', {
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        }),
    ]);

    const periods = hourlyForecast.properties.periods ?? [];
    const maxHours = days * 24;
    const selectedPeriods = periods.slice(0, maxHours);
    const gridProps: GridpointProperties | null = gridpointData?.properties ?? null;

    const hours: MeteogramHour[] = selectedPeriods.map((period) => {
      const timeMs = Date.parse(period.startTime);

      let temp = period.temperature;
      if (period.temperatureUnit === 'C') {
        temp = Math.round((temp * 9) / 5 + 32);
      }

      let dewpoint: number | null = null;
      if (period.dewpoint?.value !== null && Number.isFinite(period.dewpoint?.value)) {
        dewpoint = Math.round((period.dewpoint.value * 9) / 5 + 32);
      }

      const rh =
        period.relativeHumidity?.value !== null &&
        Number.isFinite(period.relativeHumidity?.value)
          ? Math.round(period.relativeHumidity.value)
          : null;

      const pop =
        period.probabilityOfPrecipitation?.value !== null &&
        Number.isFinite(period.probabilityOfPrecipitation?.value)
          ? Math.round(period.probabilityOfPrecipitation.value)
          : 0;

      const windSpeed = parseWindSpeedMph(period.windSpeed);
      const compass = period.windDirection || 'N';
      const windDir = COMPASS_TO_DEGREES[compass] ?? null;

      // Extract detailed gridpoint metrics if available
      let apparentTemp: number | null = null;
      let windGust: number | null = null;
      let cloudCover: number | null = null;
      let qpfInches = 0;
      let thunderProb: number | null = null;

      if (gridProps) {
        const appC = lookupIntervalValue(gridProps.apparentTemperature, timeMs);
        if (appC !== null) {
          apparentTemp = Math.round((appC * 9) / 5 + 32);
        } else {
          const hiC = lookupIntervalValue(gridProps.heatIndex, timeMs);
          const wcC = lookupIntervalValue(gridProps.windChill, timeMs);
          const chosenC = hiC !== null ? hiC : wcC;
          if (chosenC !== null) {
            apparentTemp = Math.round((chosenC * 9) / 5 + 32);
          }
        }

        const gustKmh = lookupIntervalValue(gridProps.windGust, timeMs);
        if (gustKmh !== null) {
          windGust = Math.round(gustKmh * 0.621371);
        }

        const sky = lookupIntervalValue(gridProps.skyCover, timeMs);
        if (sky !== null) {
          cloudCover = Math.round(sky);
        }

        const qpfMm = lookupIntervalValue(gridProps.quantitativePrecipitation, timeMs);
        if (qpfMm !== null && qpfMm > 0) {
          qpfInches = Math.round((qpfMm / 25.4) * 100) / 100;
        }

        const thunder = lookupIntervalValue(gridProps.probabilityOfThunder, timeMs);
        if (thunder !== null) {
          thunderProb = Math.round(thunder);
        }
      }

      return {
        time: period.startTime,
        timeMs,
        isDay: period.isDaytime,
        temperature: temp,
        dewpoint,
        apparentTemperature: apparentTemp ?? temp,
        windSpeed,
        windGust: windGust && windGust > windSpeed ? windGust : null,
        windDirection: windDir,
        windDirectionCompass: compass,
        relativeHumidity: rh,
        precipitationProbability: pop,
        cloudCover,
        precipitation: qpfInches,
        rain: qpfInches,
        snowfall: null,
        thunderProbability: thunderProb,
        shortForecast: period.shortForecast,
      };
    });

    return {
      location: {
        latitude,
        longitude,
        timezone: timeZone || 'America/New_York',
      },
      model: {
        id: 'noaa',
        label: 'NOAA NWS High-Resolution Grid (NDFD)',
        source: 'noaa',
        description: 'Official National Weather Service high-resolution blended consensus',
      },
      days,
      hours,
      generatedAt: new Date().toISOString(),
    };
  }

  private async fetchOpenMeteoMeteogram(
    latitude: number,
    longitude: number,
    days: number,
    modelId: MeteogramModelId
  ): Promise<MeteogramResponse> {
    const isNamedModel =
      modelId !== 'auto' &&
      modelId !== 'noaa' &&
      Object.prototype.hasOwnProperty.call(FORECAST_MODELS, modelId);

    const modelConfig = isNamedModel
      ? FORECAST_MODELS[modelId as keyof typeof FORECAST_MODELS]
      : null;

    const openMeteoModelKey: OpenMeteoModelId | undefined = modelConfig?.id;

    // Check regional model domain constraints
    if (
      (modelId === 'nam' || modelId === 'hrrr') &&
      !this.isNoaaCovered(latitude, longitude)
    ) {
      throw new InvalidLocationError(
        'OpenMeteo',
        `The ${modelId.toUpperCase()} model is only available for the continental United States.`
      );
    }

    const forecast = await this.openMeteoService.getForecast(
      latitude,
      longitude,
      days,
      true, // hourly
      openMeteoModelKey
    );

    const h = forecast.hourly;
    if (!h || !h.time || h.time.length === 0) {
      throw new Error('No hourly forecast series returned for this location.');
    }

    const maxHours = days * 24;
    const totalCount = Math.min(h.time.length, maxHours);
    const hours: MeteogramHour[] = [];

    for (let i = 0; i < totalCount; i++) {
      const timeStr = h.time[i];
      const timeMs = Date.parse(timeStr);
      const temp = Math.round(h.temperature_2m?.[i] ?? 0);
      const dewpoint =
        h.dewpoint_2m?.[i] !== undefined ? Math.round(h.dewpoint_2m[i]) : null;
      const appTemp =
        h.apparent_temperature?.[i] !== undefined
          ? Math.round(h.apparent_temperature[i])
          : temp;
      const windSpeed = Math.round(h.wind_speed_10m?.[i] ?? 0);
      const windGustRaw = h.wind_gusts_10m?.[i];
      const windGust =
        windGustRaw !== undefined && windGustRaw > windSpeed
          ? Math.round(windGustRaw)
          : null;
      const windDir =
        h.wind_direction_10m?.[i] !== undefined
          ? Math.round(h.wind_direction_10m[i])
          : null;
      const compass = windDir !== null ? degreesToCompass(windDir) : undefined;
      const rh =
        h.relative_humidity_2m?.[i] !== undefined
          ? Math.round(h.relative_humidity_2m[i])
          : null;
      const pop =
        h.precipitation_probability?.[i] !== undefined
          ? Math.round(h.precipitation_probability[i])
          : null;
      const cloudCover =
        h.cloud_cover?.[i] !== undefined ? Math.round(h.cloud_cover[i]) : null;
      const precip = h.precipitation?.[i] !== undefined ? h.precipitation[i] : 0;
      const rain = h.rain?.[i] !== undefined ? h.rain[i] : null;
      const snowfall = h.snowfall?.[i] !== undefined ? h.snowfall[i] : null;

      const code = h.weather_code?.[i];
      const isThunder = code === 95 || code === 96 || code === 99;
      const thunderProb = isThunder ? 80 : null;

      const isDay = h.is_day?.[i] === 1;

      hours.push({
        time: timeStr,
        timeMs,
        isDay,
        temperature: temp,
        dewpoint,
        apparentTemperature: appTemp,
        windSpeed,
        windGust,
        windDirection: windDir,
        windDirectionCompass: compass,
        relativeHumidity: rh,
        precipitationProbability: pop,
        cloudCover,
        precipitation: Math.round(precip * 100) / 100,
        rain: rain !== null ? Math.round(rain * 100) / 100 : null,
        snowfall: snowfall !== null ? Math.round(snowfall * 100) / 100 : null,
        thunderProbability: thunderProb,
        weatherCode: code,
        shortForecast:
          code !== undefined
            ? this.openMeteoService.getWeatherDescription(code)
            : undefined,
      });
    }

    let runTime: string | undefined;
    if (openMeteoModelKey) {
      runTime = await this.openMeteoService
        .getModelRunTime(openMeteoModelKey)
        .catch(() => undefined);
    }

    return {
      location: {
        latitude,
        longitude,
        timezone: forecast.timezone || 'auto',
        elevationM: forecast.elevation,
      },
      model: {
        id: modelId,
        label: modelConfig?.label ?? 'Open-Meteo Best Match Blend',
        source: 'openmeteo',
        runTime,
        description: modelConfig?.reach
          ? `Forecast reach: ${modelConfig.reach}`
          : 'Multi-model blended forecast',
      },
      days,
      hours,
      generatedAt: new Date().toISOString(),
    };
  }
}
