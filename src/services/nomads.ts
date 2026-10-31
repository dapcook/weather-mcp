import axios, { AxiosError, AxiosInstance } from 'axios';
import { DateTime } from 'luxon';
import { Cache } from '../utils/cache.js';
import { CacheConfig } from '../config/cache.js';
import { validateLatitude, validateLongitude } from '../utils/validation.js';
import { guessTimezoneFromCoords } from '../utils/timezone.js';
import { findNearestGridIndex, GridShape, GridLatLng } from '../utils/gribGrid.js';
import {
  ApiError,
  DataNotFoundError,
  InvalidLocationError,
  RateLimitError,
  ServiceUnavailableError,
} from '../errors/ApiError.js';
import type { NomadsForecastResponse } from '../types/nomads.js';
import { logger } from '../utils/logger.js';

interface NomadsServiceConfig {
  timeout?: number;
  maxRetries?: number;
  userAgent?: string;
}

interface GribMessage {
  key: string;
  varAbbrev?: string;
  varName?: string;
  units?: string;
  data: number[];
  gridShape?: GridShape;
  latlng?: GridLatLng;
  referenceDate?: Date;
  forecastDate?: Date;
}

interface TimeStepData {
  timestamp: Date;
  temperatureF?: number;
  humidityPct?: number;
  windMph?: number;
  /** Precipitation since the run started, as the file reports it */
  precipTotalSinceRunIn?: number;
  /** Precipitation in the interval ending at this step (from consecutive run totals) */
  precipitationIn?: number;
}

/**
 * The APCP message holding precipitation accumulated since the run started.
 *
 * Most NOMADS files carry two APCP messages: that run total, and a "bucket" for the last
 * few hours (GFS 3 or 6 h, NAM 3 h, HRRR 1 h). The decoder reports each message's
 * forecastDate as the start of its accumulation period, so the run total is the one that
 * starts at the run's reference time. (Taking the larger of the two, as this code once did,
 * picked the run total and then summed run totals, inflating daily totals more and more with
 * lead time: 6 in for a day other models put under 0.4 in.)
 */
export function findRunTotalPrecipitation<T extends Pick<GribMessage, 'varAbbrev' | 'forecastDate' | 'referenceDate'>>(
  messages: T[],
  runStart: Date
): T | undefined {
  return messages.find((m) =>
    m.varAbbrev === 'APCP' &&
    m.forecastDate instanceof Date &&
    m.forecastDate.getTime() === (m.referenceDate ?? runStart).getTime()
  );
}

/**
 * Precipitation in each interval from the run totals at consecutive steps (the first
 * step, the analysis, has none). A missing total leaves that step unknown and the next
 * known total covers both intervals. Small negative differences from rounding become 0.
 */
export function precipitationFromRunTotals(totals: Array<number | undefined>): Array<number | undefined> {
  let previous = 0;
  return totals.map((total, i) => {
    if (i === 0) {
      previous = total ?? 0;
      return undefined;
    }
    if (typeof total !== 'number' || !Number.isFinite(total)) {
      return undefined;
    }
    const interval = Math.max(0, total - previous);
    previous = total;
    return interval;
  });
}

interface ModelFetchConfig {
  cachePrefix: string;
  modelLabel: string;
  endpointUrl: string;
  horizonHours: number;
  stepHours: number;
  availableCycles: string[];
  candidateLookbackDays: number;
  fileNameBuilder: (cycle: string, forecastHour: number) => string;
  directoryBuilder: (date: string, cycle: string) => string;
}

type GribParser = (buffer: Buffer) => GribMessage[];

let gribParserPromise: Promise<GribParser> | null = null;

/**
 * Load the GRIB decoder on first use.
 *
 * @mattnucc/gribberish is a native module with prebuilt binaries for only some
 * platforms (none for linux-arm64, e.g. a Raspberry Pi). Importing it at module
 * load would stop the whole MCP server from starting there; loading it lazily
 * limits the failure to NOMADS requests. The result, success or failure, is
 * cached because the platform won't change while the process runs.
 */
export function loadGribParser(): Promise<GribParser> {
  gribParserPromise ??= import('@mattnucc/gribberish')
    .then((grib) => (buffer: Buffer) => grib.parseMessagesFromBuffer(buffer) as unknown as GribMessage[])
    .catch((error: unknown) => {
      const cause = error instanceof Error ? error : new Error(String(error));
      logger.error('GRIB decoder unavailable; NOMADS model data disabled', cause, {
        platform: `${process.platform}-${process.arch}`,
      });
      throw new ServiceUnavailableError(
        'NOMADS',
        `NOMADS model data is unavailable on this platform (${process.platform}-${process.arch}): ` +
          'the GRIB decoder could not be loaded. Other forecast sources still work.',
        cause
      );
    });
  return gribParserPromise;
}

/** Test hook: forget a cached load result */
export function resetGribParserForTesting(): void {
  gribParserPromise = null;
}

const NOMADS_URL = 'https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_1p00.pl';
const NAM_URL = 'https://nomads.ncep.noaa.gov/cgi-bin/filter_nam.pl';
const HRRR_URL = 'https://nomads.ncep.noaa.gov/cgi-bin/filter_hrrr_2d.pl';
const HOURS_PER_STEP = 6;
const NAM_HOURS_PER_STEP = 3;
const HRRR_HOURS_PER_STEP = 3;
const MPS_TO_MPH = 2.2369362921;
const MM_TO_IN = 0.0393701;

/**
 * Local hours a day's samples must reach for its low and high to count. Lows usually come
 * around dawn and highs mid-afternoon; with 3-hourly steps a whole day always has a sample
 * by 6 am and samples on both sides of 1-5 pm.
 */
const LOW_NEEDS_SAMPLE_BY_HOUR = 6;
const HIGH_WINDOW_START_HOUR = 13;
const HIGH_WINDOW_END_HOUR = 17;

// HRRR's CONUS domain, approximated as a bounding box for a cheap pre-check.
// The actual grid is a Lambert Conformal Conic projection, not a rectangle,
// so this is intentionally generous rather than exact.
const HRRR_DOMAIN = {
  minLatitude: 21,
  maxLatitude: 53,
  minLongitude: -134,
  maxLongitude: -60,
};

export class NOMADSService {
  private readonly client: AxiosInstance;
  private readonly maxRetries: number;
  private readonly cache: Cache;

  constructor(config: NomadsServiceConfig = {}) {
    const {
      timeout = CacheConfig.apiTimeoutMs,
      maxRetries = 3,
      userAgent = 'weather-mcp/nomads-gfs',
    } = config;

    this.maxRetries = maxRetries;
    this.cache = new Cache(CacheConfig.maxSize);
    this.client = axios.create({
      timeout,
      headers: {
        'User-Agent': userAgent,
      },
      responseType: 'arraybuffer',
    });
  }

  clearCache(): void {
    this.cache.clear();
  }

  async getForecast(latitude: number, longitude: number, days: number): Promise<NomadsForecastResponse> {
    return this.getModelForecast(latitude, longitude, days, {
      cachePrefix: 'nomads-gfs-forecast',
      modelLabel: 'NCEP GFS 1.0 deg',
      endpointUrl: NOMADS_URL,
      horizonHours: 240,
      stepHours: HOURS_PER_STEP,
      availableCycles: ['18', '12', '06', '00'],
      candidateLookbackDays: 2,
      fileNameBuilder: (cycle: string, forecastHour: number) =>
        `gfs.t${cycle}z.pgrb2.1p00.f${forecastHour.toString().padStart(3, '0')}`,
      directoryBuilder: (date: string, cycle: string) => `/gfs.${date}/${cycle}/atmos`,
    });
  }

  async getNamForecast(latitude: number, longitude: number, days: number): Promise<NomadsForecastResponse> {
    return this.getModelForecast(latitude, longitude, days, {
      cachePrefix: 'nomads-nam-forecast',
      modelLabel: 'NCEP NAM (84h deterministic)',
      endpointUrl: NAM_URL,
      horizonHours: 84,
      stepHours: NAM_HOURS_PER_STEP,
      availableCycles: ['18', '12', '06', '00'],
      candidateLookbackDays: 2,
      fileNameBuilder: (cycle: string, forecastHour: number) =>
        `nam.t${cycle}z.awphys${forecastHour.toString().padStart(2, '0')}.tm00.grib2`,
      directoryBuilder: (date: string) => `/nam.${date}`,
    });
  }

  async getHrrrForecast(latitude: number, longitude: number, days: number): Promise<NomadsForecastResponse> {
    validateLatitude(latitude);
    validateLongitude(longitude);

    if (
      latitude < HRRR_DOMAIN.minLatitude ||
      latitude > HRRR_DOMAIN.maxLatitude ||
      longitude < HRRR_DOMAIN.minLongitude ||
      longitude > HRRR_DOMAIN.maxLongitude
    ) {
      throw new InvalidLocationError(
        'NOMADS',
        'HRRR is limited to the continental US (CONUS) domain. Use GFS or NAM for this location.'
      );
    }

    return this.getModelForecast(latitude, longitude, days, {
      cachePrefix: 'nomads-hrrr-forecast',
      modelLabel: 'NCEP HRRR 3km (CONUS)',
      endpointUrl: HRRR_URL,
      // HRRR posts a full 48h horizon only on the synoptic cycles (00/06/12/18Z),
      // which is all availableCycles probes below — the intermediate hourly
      // cycles only go out to 18h and are intentionally not used here.
      horizonHours: 48,
      stepHours: HRRR_HOURS_PER_STEP,
      availableCycles: ['18', '12', '06', '00'],
      candidateLookbackDays: 1,
      fileNameBuilder: (cycle: string, forecastHour: number) =>
        `hrrr.t${cycle}z.wrfsfcf${forecastHour.toString().padStart(2, '0')}.grib2`,
      directoryBuilder: (date: string) => `/hrrr.${date}/conus`,
    });
  }

  private async getModelForecast(
    latitude: number,
    longitude: number,
    days: number,
    model: ModelFetchConfig
  ): Promise<NomadsForecastResponse> {
    validateLatitude(latitude);
    validateLongitude(longitude);

    const maxDaysForModel = Math.max(1, Math.ceil(model.horizonHours / 24));
    const clampedDays = Math.max(1, Math.min(days, maxDaysForModel));
    const cacheKey = Cache.generateKey(model.cachePrefix, latitude.toFixed(2), longitude.toFixed(2), clampedDays);

    if (CacheConfig.enabled) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return cached as NomadsForecastResponse;
      }
    }

    // Fail fast with a clear error if the decoder can't load; otherwise the run
    // probe below would swallow each decode failure and report runs unreachable
    const parseGrib = await loadGribParser();
    const maxForecastHour = Math.min(clampedDays * 24, model.horizonHours);
    // The last forecast hour this request will download
    const lastHour = Math.max(model.stepHours, Math.floor(maxForecastHour / model.stepHours) * model.stepHours);
    const run = await this.findLatestAvailableRun(latitude, longitude, model, parseGrib, lastHour);
    const points: TimeStepData[] = [];

    for (let hour = 0; hour <= maxForecastHour; hour += model.stepHours) {
      const messages = await this.fetchForecastMessages(run.date, run.cycle, hour, latitude, longitude, model, parseGrib);
      const point = this.extractPointData(messages, latitude, longitude, run.referenceDate, hour);
      points.push(point);
    }
    const intervals = precipitationFromRunTotals(points.map((point) => point.precipTotalSinceRunIn));
    points.forEach((point, i) => {
      point.precipitationIn = intervals[i];
    });

    const timezone = guessTimezoneFromCoords(latitude, longitude);
    const daily = this.aggregateDaily(points, timezone, clampedDays);

    const response: NomadsForecastResponse = {
      latitude,
      longitude,
      timezone,
      model: model.modelLabel,
      model_run: run.referenceDate.toISOString(),
      forecast_step_hours: model.stepHours,
      daily,
    };

    if (CacheConfig.enabled) {
      this.cache.set(cacheKey, response, CacheConfig.ttl.forecast);
    }

    return response;
  }

  private async findLatestAvailableRun(
    latitude: number,
    longitude: number,
    model: ModelFetchConfig,
    parseGrib: GribParser,
    probeHour: number
  ): Promise<{ date: string; cycle: string; referenceDate: Date }> {
    const now = DateTime.utc();
    const candidateDates = Array.from({ length: model.candidateLookbackDays + 1 }, (_, idx) =>
      now.minus({ days: idx })
    );

    for (const candidateDate of candidateDates) {
      const dateStr = candidateDate.toFormat('yyyyLLdd');

      for (const cycle of model.availableCycles) {
        // Probe the LAST hour the request needs, not the first: NOAA posts a run's files over
        // an hour or two, so a run still being posted has its early hours but not its later
        // ones. Probing an early hour picked such runs and then failed with "file not found";
        // probing the last one skips to the previous complete run instead.
        try {
          const messages = await this.fetchForecastMessages(dateStr, cycle, probeHour, latitude, longitude, model, parseGrib);

          if (messages.length > 0) {
            const referenceDate = DateTime.fromFormat(`${dateStr}${cycle}`, 'yyyyLLddHH', { zone: 'utc' }).toJSDate();
            return { date: dateStr, cycle, referenceDate };
          }
        } catch (error) {
          // Continue probing older runs.
        }
      }
    }

    throw new ServiceUnavailableError(
      'NOMADS',
      `${model.modelLabel} runs were not reachable. Please try again shortly.`
    );
  }

  private async fetchForecastMessages(
    date: string,
    cycle: string,
    forecastHour: number,
    latitude: number,
    longitude: number,
    model: ModelFetchConfig,
    parseGrib: GribParser
  ): Promise<GribMessage[]> {
    const file = model.fileNameBuilder(cycle, forecastHour);

    const params = {
      file,
      dir: model.directoryBuilder(date, cycle),
      lev_2_m_above_ground: 'on',
      lev_10_m_above_ground: 'on',
      lev_surface: 'on',
      var_TMP: 'on',
      var_RH: 'on',
      var_APCP: 'on',
      var_UGRD: 'on',
      var_VGRD: 'on',
      subregion: '',
      leftlon: (longitude - 2).toFixed(2),
      rightlon: (longitude + 2).toFixed(2),
      toplat: Math.min(90, latitude + 2).toFixed(2),
      bottomlat: Math.max(-90, latitude - 2).toFixed(2),
    };

    const raw = await this.requestWithRetry(model.endpointUrl, params);

    if (!raw || raw.length < 5 || raw.subarray(0, 4).toString('utf8') !== 'GRIB') {
      throw new DataNotFoundError('NOMADS', `NOMADS data file unavailable for ${file}`);
    }

    return parseGrib(raw);
  }

  private async requestWithRetry(endpointUrl: string, params: Record<string, string>, retries = 0): Promise<Buffer> {
    try {
      const response = await this.client.get<ArrayBuffer>(endpointUrl, { params });
      return Buffer.from(response.data);
    } catch (error) {
      const axiosError = error as AxiosError;

      if (axiosError.response?.status === 429) {
        throw new RateLimitError('NOMADS', 'NOMADS rate limit reached. Retry in a moment.');
      }

      if (axiosError.response?.status === 404 || axiosError.response?.status === 403) {
        throw new DataNotFoundError('NOMADS', 'Requested NOMADS model file was not found.');
      }

      if (retries < this.maxRetries) {
        const delayMs = Math.round((2 ** retries) * 500 + Math.random() * 250);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return this.requestWithRetry(endpointUrl, params, retries + 1);
      }

      if (axiosError.code === 'ECONNABORTED' || axiosError.code === 'ENOTFOUND') {
        throw new ServiceUnavailableError('NOMADS', 'NOMADS endpoint timeout or DNS failure.');
      }

      throw new ApiError(
        `NOMADS request failed: ${(error as Error).message}`,
        500,
        'NOMADS',
        'NOMADS request failed. Please retry.',
        [],
        true
      );
    }
  }

  private extractPointData(
    messages: GribMessage[],
    latitude: number,
    longitude: number,
    referenceDate: Date,
    forecastHour: number
  ): TimeStepData {
    if (messages.length === 0) {
      throw new InvalidLocationError('NOMADS', 'No NOMADS messages returned for point extraction.');
    }

    const surfaceTemp = messages.find((m) => m.varAbbrev === 'TMP' && m.key.includes('2 in above ground'));
    const humidity = messages.find((m) => m.varAbbrev === 'RH' && m.key.includes('2 in above ground'));
    const ugrd = messages.find((m) => m.varAbbrev === 'UGRD' && m.key.includes('10 in above ground'));
    const vgrd = messages.find((m) => m.varAbbrev === 'VGRD' && m.key.includes('10 in above ground'));
    const runTotalPrecip = findRunTotalPrecipitation(messages, referenceDate);

    const timestamp = surfaceTemp?.forecastDate ?? new Date(referenceDate.getTime() + forecastHour * 3600 * 1000);

    const runTotalMm = runTotalPrecip ? this.extractNearestValue(runTotalPrecip, latitude, longitude) : undefined;

    const temperatureK = surfaceTemp ? this.extractNearestValue(surfaceTemp, latitude, longitude) : undefined;
    const humidityPct = humidity ? this.extractNearestValue(humidity, latitude, longitude) : undefined;

    const u = ugrd ? this.extractNearestValue(ugrd, latitude, longitude) : undefined;
    const v = vgrd ? this.extractNearestValue(vgrd, latitude, longitude) : undefined;

    const windMph = typeof u === 'number' && typeof v === 'number'
      ? Math.sqrt((u * u) + (v * v)) * MPS_TO_MPH
      : undefined;

    return {
      timestamp,
      temperatureF: typeof temperatureK === 'number' ? ((temperatureK - 273.15) * 9) / 5 + 32 : undefined,
      humidityPct,
      windMph,
      precipTotalSinceRunIn: typeof runTotalMm === 'number' ? runTotalMm * MM_TO_IN : undefined,
    };
  }

  private extractNearestValue(message: GribMessage, latitude: number, longitude: number): number | undefined {
    const flatIndex = findNearestGridIndex(message.latlng, message.gridShape, latitude, longitude);

    if (flatIndex === undefined) {
      return undefined;
    }

    const value = message.data[flatIndex];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  private aggregateDaily(points: TimeStepData[], timezone: string, days: number): NomadsForecastResponse['daily'] {
    const buckets = new Map<string, {
      highs: number[];
      lows: number[];
      precipIn: number;
      precipSteps: number;
      totalSteps: number;
      humidity: number[];
      wind: number[];
      /** Earliest and latest local hour sampled, to tell a whole day from a partial one */
      firstHour: number;
      lastHour: number;
    }>();

    for (const point of points) {
      const local = DateTime.fromJSDate(point.timestamp, { zone: 'utc' }).setZone(timezone);
      const dayKey = local.toISODate();
      if (!dayKey) {
        continue;
      }

      let bucket = buckets.get(dayKey);
      if (!bucket) {
        bucket = {
          highs: [],
          lows: [],
          precipIn: 0,
          precipSteps: 0,
          totalSteps: 0,
          humidity: [],
          wind: [],
          firstHour: local.hour,
          lastHour: local.hour,
        };
        buckets.set(dayKey, bucket);
      }
      bucket.firstHour = Math.min(bucket.firstHour, local.hour);
      bucket.lastHour = Math.max(bucket.lastHour, local.hour);

      if (typeof point.temperatureF === 'number') {
        bucket.highs.push(point.temperatureF);
        bucket.lows.push(point.temperatureF);
      }

      if (typeof point.precipitationIn === 'number') {
        // The interval ends at this step, so it belongs to the day it fell in: one ending
        // exactly at local midnight counts for the day before
        const precipDayKey = DateTime.fromMillis(point.timestamp.getTime() - 1, { zone: 'utc' }).setZone(timezone).toISODate();
        const precipBucket = precipDayKey && precipDayKey !== dayKey ? buckets.get(precipDayKey) : bucket;
        if (precipBucket) {
          precipBucket.precipIn += point.precipitationIn;
          if (point.precipitationIn >= 0.01) {
            precipBucket.precipSteps += 1;
          }
        }
      }

      if (typeof point.humidityPct === 'number') {
        bucket.humidity.push(point.humidityPct);
      }

      if (typeof point.windMph === 'number') {
        bucket.wind.push(point.windMph);
      }

      bucket.totalSteps += 1;
    }

    const allSortedDays = Array.from(buckets.keys()).sort();
    const todayKey = DateTime.now().setZone(timezone).toISODate();
    const futureDays = todayKey
      ? allSortedDays.filter((day) => day >= todayKey)
      : allSortedDays;
    const sortedDays = (futureDays.length > 0 ? futureDays : allSortedDays).slice(0, days);

    // A run starts and ends partway through a day (an 18Z run starts at 1 pm in Kansas City),
    // so the first and last days can be missing their night or afternoon. A low that misses
    // the early morning, or a high that misses the afternoon, would be wrong (a 72 °F "low"
    // next to other models' 61 °F), so those are left out (NaN) rather than shown.
    const coversLow = (day: string) => (buckets.get(day)?.firstHour ?? 24) <= LOW_NEEDS_SAMPLE_BY_HOUR;
    const coversHigh = (day: string) => {
      const bucket = buckets.get(day);
      return !!bucket && bucket.firstHour <= HIGH_WINDOW_START_HOUR && bucket.lastHour >= HIGH_WINDOW_END_HOUR;
    };

    return {
      time: sortedDays,
      temperature_2m_max: sortedDays.map((day) => {
        const values = buckets.get(day)?.highs ?? [];
        return values.length > 0 && coversHigh(day) ? Math.round(Math.max(...values)) : NaN;
      }),
      temperature_2m_min: sortedDays.map((day) => {
        const values = buckets.get(day)?.lows ?? [];
        return values.length > 0 && coversLow(day) ? Math.round(Math.min(...values)) : NaN;
      }),
      precipitation_probability_max: sortedDays.map((day) => {
        const bucket = buckets.get(day);
        if (!bucket || bucket.totalSteps === 0) {
          return 0;
        }

        return Math.round((bucket.precipSteps / bucket.totalSteps) * 100);
      }),
      precipitation_sum: sortedDays.map((day) => {
        const bucket = buckets.get(day);
        return bucket ? Number(bucket.precipIn.toFixed(2)) : 0;
      }),
      wind_speed_10m_max: sortedDays.map((day) => {
        const values = buckets.get(day)?.wind ?? [];
        return values.length > 0 ? Math.round(Math.max(...values)) : NaN;
      }),
      relative_humidity_2m_mean: sortedDays.map((day) => {
        const values = buckets.get(day)?.humidity ?? [];
        if (values.length === 0) {
          return NaN;
        }

        const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
        return Math.round(avg);
      }),
    };
  }
}
