/**
 * Service for interacting with the Open-Meteo APIs
 * Documentation:
 * - Historical Weather: https://open-meteo.com/en/docs/historical-weather-api
 * - Forecast: https://open-meteo.com/en/docs
 * - Geocoding: https://open-meteo.com/en/docs/geocoding-api
 * - Air Quality: https://open-meteo.com/en/docs/air-quality-api
 * - Marine: https://open-meteo.com/en/docs/marine-weather-api
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import type {
  OpenMeteoHistoricalResponse,
  OpenMeteoErrorResponse,
  GeocodingResponse,
  OpenMeteoForecastResponse,
  OpenMeteoAirQualityResponse,
  OpenMeteoMarineResponse,
  ClimateNormals
} from '../types/openmeteo.js';
import { Cache } from '../utils/cache.js';
import { ByteBudgetCache } from '../utils/byteBudgetCache.js';
import { DailyRecordStore, DailyRecord, addDays, daysBetween, recordEndDate } from './dailyRecordStore.js';
import { CacheConfig, getHistoricalDataTTL } from '../config/cache.js';
import { validateLatitude, validateLongitude } from '../utils/validation.js';
import { logger, redactCoordinatesForLogging } from '../utils/logger.js';
import { computeNormalsFrom30YearData, getNormalsCacheKey } from '../utils/normals.js';
import { getUserAgent } from '../utils/version.js';
import {
  RateLimitError,
  ServiceUnavailableError,
  InvalidLocationError,
  DataNotFoundError,
  ApiError
} from '../errors/ApiError.js';

export interface OpenMeteoServiceConfig {
  baseURL?: string;
  geocodingURL?: string;
  forecastURL?: string;
  airQualityURL?: string;
  marineURL?: string;
  timeout?: number;
  maxRetries?: number;
  /** Memory budget, in bytes, for cached full daily records (see getDailyTemperatureRecord) */
  dailyRecordCacheBytes?: number;
  /**
   * Folder where full daily records are also saved, so a restart does not download them
   * again. Unset means memory only.
   */
  dailyRecordStoreDir?: string;
  /** Size limit for that folder, in bytes */
  dailyRecordStoreMaxBytes?: number;
}

/**
 * When a saved record is topped up, this many days at its end are fetched again along
 * with the new days. The newest days start as preliminary values that Open-Meteo
 * revises over the following weeks, so re-reading them keeps the saved copy accurate.
 * (100 days of three variables costs about 2 calls, against about 680 for a full record.)
 */
export const DAILY_RECORD_REFRESH_OVERLAP_DAYS = 100;

/**
 * Individual forecast models Open-Meteo serves on /forecast (via its `models` parameter), used
 * by the model comparison and by get_forecast's `model` option, each with the name of the
 * metadata file that reports its latest run. Names checked against the live API on 2026-10-28;
 * Open-Meteo renames models occasionally.
 */
export const OPEN_METEO_MODELS = {
  ecmwf_ifs: { metadata: 'ecmwf_ifs' },
  ecmwf_aifs025_single: { metadata: 'ecmwf_aifs025_single' },
  icon_global: { metadata: 'dwd_icon' },
  gem_global: { metadata: 'cmc_gem_gdps' },
  gfs_global: { metadata: 'ncep_gfs013' },
  ncep_nam_conus: { metadata: 'ncep_nam_conus' },
  ncep_hrrr_conus: { metadata: 'ncep_hrrr_conus' },
} as const;

export type OpenMeteoModelId = keyof typeof OPEN_METEO_MODELS;

/**
 * Models a user can ask get_forecast for, by the same short names the model comparison uses.
 * Reach is how far each model's free output goes (checked against the live API on 2026-10-28).
 */
export const FORECAST_MODELS = {
  ecmwf: { id: 'ecmwf_ifs', label: 'ECMWF IFS (European Centre)', reach: '15 days' },
  ecmwf_aifs: { id: 'ecmwf_aifs025_single', label: 'ECMWF AIFS (European Centre AI model)', reach: '15 days' },
  icon: { id: 'icon_global', label: 'ICON Global (Germany, DWD)', reach: 'about 7.5 days' },
  gem: { id: 'gem_global', label: 'GEM Global (Canada, ECCC)', reach: '10 days' },
  gfs: { id: 'gfs_global', label: 'GFS (NOAA)', reach: '16 days' },
  nam: { id: 'ncep_nam_conus', label: 'NAM CONUS (NOAA)', reach: 'about 3 days, continental US only' },
  hrrr: { id: 'ncep_hrrr_conus', label: 'HRRR (NOAA)', reach: 'about 2 days, continental US only' },
} as const satisfies Record<string, { id: OpenMeteoModelId; label: string; reach: string }>;

export type ForecastModel = keyof typeof FORECAST_MODELS;

const OUTSIDE_MODEL_AREA =
  'This model has no forecast for this location; it may not cover it (NAM and HRRR cover the continental US only). ' +
  'Try "gfs", "ecmwf", "icon" or "gem", which are global.';

/**
 * Turn the API's nulls (a variable a model doesn't provide, or hours past its run) into missing
 * entries, which is what the forecast formatter checks for. Without this, a model with no UV
 * index (most single models) would crash the formatter, and a null temperature would print as 0°F.
 */
function nullsToMissing(block: object | undefined): void {
  if (!block) {
    return;
  }
  for (const values of Object.values(block)) {
    if (Array.isArray(values)) {
      for (let i = 0; i < values.length; i++) {
        if (values[i] === null) {
          delete values[i];
        }
      }
    }
  }
}

/** Cut every series in a block to its first `length` entries */
function truncateSeries(block: object, length: number): void {
  for (const [key, values] of Object.entries(block)) {
    if (Array.isArray(values)) {
      (block as Record<string, unknown[]>)[key] = values.slice(0, length);
    }
  }
}

/** Entries up to the last one where `values` has data, i.e. how far a model's run reaches */
function lengthWithData(values: unknown[] | undefined): number {
  if (!values) {
    return 0;
  }
  for (let i = values.length - 1; i >= 0; i--) {
    if (typeof values[i] === 'number') {
      return i + 1;
    }
  }
  return 0;
}

/**
 * A reported run older than this is treated as unknown. Every model here runs at least twice a
 * day, so an older time means the metadata file is stale (GEM's was months old when checked),
 * and showing it would mislabel the forecast.
 */
const MODEL_RUN_MAX_AGE_MS = 48 * 60 * 60 * 1000;

/** A full daily record, plus a note if a saved one could not be brought up to date */
export interface DailyRecordResult {
  record: OpenMeteoHistoricalResponse;
  /** Why a saved record was returned without being refreshed (e.g. Open-Meteo is rate limiting) */
  refreshError?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Rebuild the API's response shape from a saved record (days are consecutive, so dates are derived) */
function responseFromRecord(saved: DailyRecord): OpenMeteoHistoricalResponse {
  const first = Date.parse(`${saved.startDate}T00:00:00Z`);
  const time = saved.high.map((_, i) => new Date(first + i * DAY_MS).toISOString().slice(0, 10));
  return {
    latitude: saved.latitude,
    longitude: saved.longitude,
    generationtime_ms: 0,
    utc_offset_seconds: saved.utcOffsetSeconds,
    timezone: saved.timezone,
    timezone_abbreviation: saved.timezoneAbbreviation,
    elevation: saved.elevation,
    daily: {
      time,
      temperature_2m_max: saved.high as number[],
      temperature_2m_min: saved.low as number[],
      precipitation_sum: saved.precipitation as number[],
    },
  };
}

/** The compact form to save, or null if the days are not consecutive (so dates could not be rebuilt) */
function recordFromResponse(response: OpenMeteoHistoricalResponse): DailyRecord | null {
  const daily = response.daily;
  if (!daily || daily.time.length === 0) {
    return null;
  }
  const n = daily.time.length;
  const first = Date.parse(`${daily.time[0]}T00:00:00Z`);
  if (!Number.isFinite(first)) {
    return null;
  }
  for (let i = 0; i < n; i++) {
    if (new Date(first + i * DAY_MS).toISOString().slice(0, 10) !== daily.time[i]) {
      return null;
    }
  }
  const series = (values: number[] | undefined): Array<number | null> =>
    values && values.length === n
      ? values.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null))
      : new Array<number | null>(n).fill(null);
  return {
    latitude: response.latitude,
    longitude: response.longitude,
    elevation: response.elevation,
    timezone: response.timezone,
    timezoneAbbreviation: response.timezone_abbreviation,
    utcOffsetSeconds: response.utc_offset_seconds,
    startDate: daily.time[0],
    high: series(daily.temperature_2m_max),
    low: series(daily.temperature_2m_min),
    precipitation: series(daily.precipitation_sum),
  };
}

/** A short, single-line reason for showing to the user */
function describeRefreshError(error: unknown): string {
  const text = error instanceof ApiError ? error.userMessage : error instanceof Error ? error.message : 'Unknown error';
  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}

/**
 * Default budget for cached full daily records. One 86-year record is about 2 MB
 * once parsed, so this keeps roughly 50 places before the oldest-used are dropped,
 * well inside a 768 MB container.
 */
export const DEFAULT_DAILY_RECORD_CACHE_BYTES = 96 * 1024 * 1024;

/**
 * Approximate memory held by a parsed daily record: per day, three numbers
 * (8 bytes each) plus a date string and its slot in the array (about 40 bytes).
 * Measured at about 2 MB for 31,708 days, which this matches.
 */
export function estimateDailyRecordBytes(record: OpenMeteoHistoricalResponse): number {
  return (record.daily?.time.length ?? 0) * 64;
}

/**
 * Open-Meteo's own explanation of a rate limit (e.g. "Minutely API request limit
 * exceeded. Please try again in one minute."), cleaned up because it is shown to
 * users and logged: control characters removed, whitespace collapsed, length capped.
 */
function rateLimitReason(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) {
    return undefined;
  }
  const reason = (data as { reason?: unknown }).reason;
  if (typeof reason !== 'string') {
    return undefined;
  }
  const cleaned = reason.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  return cleaned || undefined;
}

/** Seconds from a Retry-After header (the HTTP-date form is not used by Open-Meteo and is ignored) */
function retryAfterSeconds(header: unknown): number | undefined {
  const seconds = Number(Array.isArray(header) ? header[0] : header);
  return Number.isFinite(seconds) && seconds >= 1 && seconds <= 3600 ? Math.ceil(seconds) : undefined;
}

export class OpenMeteoService {
  private client: AxiosInstance;
  private geocodingClient: AxiosInstance;
  private forecastClient: AxiosInstance;
  private airQualityClient: AxiosInstance;
  private marineClient: AxiosInstance;
  private maxRetries: number;
  private cache: Cache;
  /** Full daily records are large, so they are limited by memory rather than by entry count */
  private dailyRecordCache: ByteBudgetCache<OpenMeteoHistoricalResponse>;
  /** The same records on disk, if configured, so they survive a restart */
  private dailyRecordStore: DailyRecordStore | null;
  /** Loads in progress, so two requests for one place share a single download */
  private dailyRecordLoads = new Map<string, Promise<DailyRecordResult>>();

  constructor(config: OpenMeteoServiceConfig = {}) {
    const {
      baseURL = 'https://archive-api.open-meteo.com/v1',
      geocodingURL = 'https://geocoding-api.open-meteo.com/v1',
      forecastURL = 'https://api.open-meteo.com/v1',
      airQualityURL = 'https://air-quality-api.open-meteo.com/v1',
      marineURL = 'https://marine-api.open-meteo.com/v1',
      timeout = CacheConfig.apiTimeoutMs,
      maxRetries = 3
    } = config;

    this.maxRetries = maxRetries;
    this.cache = new Cache(CacheConfig.maxSize);
    this.dailyRecordCache = new ByteBudgetCache(config.dailyRecordCacheBytes ?? DEFAULT_DAILY_RECORD_CACHE_BYTES);
    this.dailyRecordStore = config.dailyRecordStoreDir
      ? new DailyRecordStore(config.dailyRecordStoreDir, { maxBytes: config.dailyRecordStoreMaxBytes })
      : null;

    // Historical weather client
    this.client = axios.create({
      baseURL,
      timeout,
      headers: {
        'Accept': 'application/json',
        'User-Agent': getUserAgent()
      }
    });

    // Geocoding client
    this.geocodingClient = axios.create({
      baseURL: geocodingURL,
      timeout,
      headers: {
        'Accept': 'application/json',
        'User-Agent': getUserAgent()
      }
    });

    // Forecast client
    this.forecastClient = axios.create({
      baseURL: forecastURL,
      timeout,
      headers: {
        'Accept': 'application/json',
        'User-Agent': getUserAgent()
      }
    });

    // Air quality client
    this.airQualityClient = axios.create({
      baseURL: airQualityURL,
      timeout,
      headers: {
        'Accept': 'application/json',
        'User-Agent': getUserAgent()
      }
    });

    // Marine client
    this.marineClient = axios.create({
      baseURL: marineURL,
      timeout,
      headers: {
        'Accept': 'application/json',
        'User-Agent': getUserAgent()
      }
    });

    // Add response interceptor for error handling
    this.client.interceptors.response.use(
      response => response,
      error => this.handleError(error)
    );

    this.geocodingClient.interceptors.response.use(
      response => response,
      error => this.handleError(error)
    );

    this.forecastClient.interceptors.response.use(
      response => response,
      error => this.handleError(error)
    );

    this.airQualityClient.interceptors.response.use(
      response => response,
      error => this.handleError(error)
    );

    this.marineClient.interceptors.response.use(
      response => response,
      error => this.handleError(error)
    );
  }

  /**
   * Handle API errors with helpful status information
   */
  private async handleError(error: AxiosError): Promise<never> {
    if (error.response) {
      const status = error.response.status;
      const data = error.response.data as OpenMeteoErrorResponse;

      // Bad request
      if (status === 400) {
        const reason = data.reason || 'Invalid request parameters';
        logger.warn('Invalid request parameters', {
          service: 'OpenMeteo',
          reason,
          securityEvent: true
        });
        throw new InvalidLocationError(
          'OpenMeteo',
          `${reason}\n\nPlease verify:\n` +
          `- Coordinates are valid (latitude: -90 to 90, longitude: -180 to 180)\n` +
          `- Date range is valid (1940 to 5 days ago)\n` +
          `- Parameters are correctly formatted`
        );
      }

      // Rate limit error. Open-Meteo says which limit was hit (per minute, hour or day),
      // which decides how long to wait, so pass its explanation on.
      if (status === 429) {
        const reason = rateLimitReason(data);
        const retryAfter = retryAfterSeconds(error.response.headers?.['retry-after']);
        logger.warn('Rate limit exceeded', {
          service: 'OpenMeteo',
          reason,
          securityEvent: true
        });
        const explanation = reason
          ? `Open-Meteo says: "${reason}"`
          : 'Open-Meteo is limiting requests from this connection. Wait about a minute and try again.';
        throw new RateLimitError(
          'OpenMeteo',
          `Rate limit exceeded. ${explanation}${retryAfter ? ` Retry after ${retryAfter} seconds.` : ''} ` +
            'Requests that cover many days count as several calls against its free limits, ' +
            'so loading a long history can use them up quickly.',
          retryAfter
        );
      }

      // Server errors
      if (status >= 500) {
        throw new ServiceUnavailableError('OpenMeteo', error);
      }

      // Other errors
      throw new ApiError(
        `Open-Meteo API error (${status})`,
        status,
        'OpenMeteo',
        data.reason || 'Request failed',
        [
          'https://open-meteo.com/en/docs',
          'https://github.com/open-meteo/open-meteo/issues'
        ]
      );
    }

    // Network errors
    if (error.code === 'ECONNABORTED') {
      throw new ServiceUnavailableError('OpenMeteo', error);
    }

    if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      throw new ServiceUnavailableError('OpenMeteo', error);
    }

    // Generic error
    throw new ApiError(
      `Open-Meteo API request failed: ${error.message}`,
      500,
      'OpenMeteo',
      `Request failed: ${error.message}`,
      [
        'https://github.com/open-meteo/open-meteo/issues',
        'https://open-meteo.com/en/docs'
      ],
      true
    );
  }

  /**
   * Make request with retry logic
   */
  private async makeRequest<T>(
    url: string,
    params: Record<string, string | number>,
    retries = 0
  ): Promise<T> {
    try {
      const response = await this.client.get<T>(url, { params });
      return response.data;
    } catch (error) {
      // Retry on rate limit or server errors
      if (retries < this.maxRetries) {
        const shouldRetry =
          (error as Error).message.includes('rate limit') ||
          (error as Error).message.includes('server error') ||
          (error as Error).message.includes('timed out');

        if (shouldRetry) {
          // Exponential backoff with jitter to prevent thundering herd
          const baseDelay = Math.pow(2, retries) * 1000;
          const delay = baseDelay * (0.5 + Math.random() * 0.5);
          await new Promise(resolve => setTimeout(resolve, delay));
          return this.makeRequest<T>(url, params, retries + 1);
        }
      }
      throw error;
    }
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    return this.cache.getStats();
  }

  /**
   * Clear the cache
   */
  clearCache(): void {
    this.cache.clear();
    this.dailyRecordCache.clear();
  }

  /**
   * Check if the Open-Meteo API is operational
   * Performs a lightweight health check by requesting a simple query
   * @returns Object with status information
   */
  async checkServiceStatus(): Promise<{
    operational: boolean;
    message: string;
    statusPage: string;
    timestamp: string;
  }> {
    try {
      // Use a simple request for a recent date at a known location (London, UK)
      // Using a 1-day range from 30 days ago to avoid the 5-day delay issue
      const testDate = new Date();
      testDate.setDate(testDate.getDate() - 30);
      const dateStr = testDate.toISOString().split('T')[0];

      const response = await this.client.get('/archive', {
        params: {
          latitude: 51.5074,
          longitude: -0.1278,
          start_date: dateStr,
          end_date: dateStr,
          daily: 'temperature_2m_max',
          timezone: 'UTC'
        },
        timeout: 10000 // Shorter timeout for health check
      });

      if (response.status === 200 && response.data) {
        return {
          operational: true,
          message: 'Open-Meteo API is operational',
          statusPage: 'https://open-meteo.com/en/docs/model-updates',
          timestamp: new Date().toISOString()
        };
      }

      return {
        operational: false,
        message: `Open-Meteo API returned unexpected status: ${response.status}`,
        statusPage: 'https://open-meteo.com/en/docs/model-updates',
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      const axiosError = error as AxiosError;
      let message = 'Open-Meteo API may be experiencing issues';
      let operational = false;

      if (axiosError.response) {
        const status = axiosError.response.status;
        if (status === 429) {
          operational = true; // API is up, just rate limited
          message = 'Open-Meteo API is operational but rate limited';
        } else if (status >= 500) {
          message = 'Open-Meteo API is experiencing server errors (possible outage)';
        } else if (status === 400) {
          operational = true; // Bad request might indicate API is up but our test is wrong
          message = 'Open-Meteo API is responding (health check may need adjustment)';
        }
      } else if (axiosError.code === 'ECONNABORTED') {
        message = 'Open-Meteo API is not responding (timeout)';
      } else if (axiosError.code === 'ENOTFOUND' || axiosError.code === 'ECONNREFUSED') {
        message = 'Cannot connect to Open-Meteo API (DNS or connection failure)';
      }

      return {
        operational,
        message,
        statusPage: 'https://open-meteo.com/en/docs/model-updates',
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Get historical weather data for a location
   *
   * @param latitude - Latitude coordinate (-90 to 90)
   * @param longitude - Longitude coordinate (-180 to 180)
   * @param startDate - Start date in ISO format (YYYY-MM-DD)
   * @param endDate - End date in ISO format (YYYY-MM-DD)
   * @param useHourly - Whether to request hourly data (default: true)
   * @returns Historical weather data
   */
  async getHistoricalWeather(
    latitude: number,
    longitude: number,
    startDate: string,
    endDate: string,
    useHourly: boolean = true
  ): Promise<OpenMeteoHistoricalResponse> {
    // Validate coordinates (checks for NaN, Infinity, and range)
    validateLatitude(latitude);
    validateLongitude(longitude);

    // Build parameters once
    const params = this.buildHistoricalParams(latitude, longitude, startDate, endDate, useHourly);

    // Check cache first (if enabled)
    if (CacheConfig.enabled) {
      const cacheKey = Cache.generateKey('openmeteo-historical', latitude, longitude, startDate, endDate, useHourly);
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return cached as OpenMeteoHistoricalResponse;
      }

      const response = await this.makeRequest<OpenMeteoHistoricalResponse>('/archive', params);
      this.validateResponse(response, startDate, endDate, useHourly);

      // Use smart TTL based on date range
      const ttl = getHistoricalDataTTL(startDate);
      this.cache.set(cacheKey, response, ttl);

      return response;
    }

    // No caching
    const response = await this.makeRequest<OpenMeteoHistoricalResponse>('/archive', params);
    this.validateResponse(response, startDate, endDate, useHourly);
    return response;
  }

  /**
   * Get daily high, low and precipitation only, for long ranges such as the
   * whole 1940-present record. Much lighter than getHistoricalWeather, which
   * requests a dozen daily variables.
   *
   * @param latitude - Latitude coordinate (-90 to 90)
   * @param longitude - Longitude coordinate (-180 to 180)
   * @param startDate - Start date (YYYY-MM-DD)
   * @param endDate - End date (YYYY-MM-DD)
   * @returns Daily data in °F and inches, in the location's local timezone
   */
  async getDailyTemperatureRecord(
    latitude: number,
    longitude: number,
    startDate: string,
    endDate: string
  ): Promise<OpenMeteoHistoricalResponse> {
    return (await this.getDailyTemperatureRecordWithStatus(latitude, longitude, startDate, endDate)).record;
  }

  /**
   * Like getDailyTemperatureRecord, but says when a saved record had to be returned
   * without bringing it up to date (for example because Open-Meteo is rate limiting).
   *
   * Records are looked up in memory, then in the data folder, then downloaded. A saved
   * record only needs its newest days fetched, which costs a fraction of a download.
   */
  async getDailyTemperatureRecordWithStatus(
    latitude: number,
    longitude: number,
    startDate: string,
    endDate: string
  ): Promise<DailyRecordResult> {
    validateLatitude(latitude);
    validateLongitude(longitude);

    if (!CacheConfig.enabled) {
      return { record: await this.downloadDailyRecord(latitude, longitude, startDate, endDate) };
    }

    // Kept in a cache limited by memory, not entry count: a record is about 2 MB, so
    // counting entries would let browsing many places grow memory without bound.
    // The key includes the end date, so each new day's record is a new entry; the
    // least recently used records are dropped to stay inside the budget.
    const cacheKey = Cache.generateKey('openmeteo-daily-record', latitude, longitude, startDate, endDate);
    const cached = this.dailyRecordCache.get(cacheKey);
    if (cached) {
      return { record: cached };
    }

    // Two requests for one place at once share a single download
    const inFlight = this.dailyRecordLoads.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }
    const load = this.loadDailyRecord(cacheKey, latitude, longitude, startDate, endDate).finally(() => {
      this.dailyRecordLoads.delete(cacheKey);
    });
    this.dailyRecordLoads.set(cacheKey, load);
    return load;
  }

  /** Fetch one range of daily values from the archive */
  private async downloadDailyRecord(
    latitude: number,
    longitude: number,
    startDate: string,
    endDate: string
  ): Promise<OpenMeteoHistoricalResponse> {
    const params: Record<string, string | number> = {
      latitude,
      longitude,
      start_date: startDate,
      end_date: endDate,
      daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum',
      temperature_unit: 'fahrenheit',
      precipitation_unit: 'inch',
      timezone: 'auto'
    };
    const response = await this.makeRequest<OpenMeteoHistoricalResponse>('/archive', params);
    this.validateResponse(response, startDate, endDate, false);
    return response;
  }

  private rememberDailyRecord(cacheKey: string, response: OpenMeteoHistoricalResponse): void {
    this.dailyRecordCache.set(cacheKey, response, estimateDailyRecordBytes(response));
  }

  /** Memory missed: use the saved record if there is one, else download */
  private async loadDailyRecord(
    cacheKey: string,
    latitude: number,
    longitude: number,
    startDate: string,
    endDate: string
  ): Promise<DailyRecordResult> {
    const store = this.dailyRecordStore;
    const saved = store ? await store.load(latitude, longitude, startDate) : null;

    if (!store || !saved) {
      const response = await this.downloadDailyRecord(latitude, longitude, startDate, endDate);
      this.rememberDailyRecord(cacheKey, response);
      const toSave = recordFromResponse(response);
      if (store && toSave) {
        await store.save(latitude, longitude, toSave);
      }
      return { record: response };
    }

    const wantedDays = daysBetween(startDate, endDate) + 1;
    if (wantedDays >= 1 && saved.high.length >= wantedDays) {
      // Already covers the range (a record ending later is simply cut short)
      const response = responseFromRecord({
        ...saved,
        high: saved.high.slice(0, wantedDays),
        low: saved.low.slice(0, wantedDays),
        precipitation: saved.precipitation.slice(0, wantedDays),
      });
      this.rememberDailyRecord(cacheKey, response);
      return { record: response };
    }

    // The saved record stops short of the range: fetch its recent end again plus whatever is new
    const from = addDays(recordEndDate(saved), -(DAILY_RECORD_REFRESH_OVERLAP_DAYS - 1));
    const tailStart = daysBetween(startDate, from) > 0 ? from : startDate;
    try {
      const tailResponse = await this.downloadDailyRecord(latitude, longitude, tailStart, endDate);
      const tail = recordFromResponse(tailResponse);
      if (!tail || tail.startDate !== tailStart) {
        throw new ServiceUnavailableError('OpenMeteo', 'Open-Meteo returned an unexpected date range.');
      }
      const keep = daysBetween(saved.startDate, tailStart);
      const merged: DailyRecord = {
        ...tail,
        startDate: saved.startDate,
        high: saved.high.slice(0, keep).concat(tail.high),
        low: saved.low.slice(0, keep).concat(tail.low),
        precipitation: saved.precipitation.slice(0, keep).concat(tail.precipitation),
      };
      const response = responseFromRecord(merged);
      this.rememberDailyRecord(cacheKey, response);
      await store.save(latitude, longitude, merged);
      return { record: response };
    } catch (error) {
      // Better an out-of-date record than none. It is not remembered in memory, so the
      // next request tries the refresh again.
      logger.warn('Could not refresh saved climate record; using the saved copy', {
        service: 'OpenMeteo',
        error: error instanceof Error ? error.name : 'unknown'
      });
      return { record: responseFromRecord(saved), refreshError: describeRefreshError(error) };
    }
  }

  /**
   * Build request parameters for historical weather data
   * @private
   */
  private buildHistoricalParams(
    latitude: number,
    longitude: number,
    startDate: string,
    endDate: string,
    useHourly: boolean
  ): Record<string, string | number> {
    const params: Record<string, string | number> = {
      latitude,
      longitude,
      start_date: startDate,
      end_date: endDate,
      temperature_unit: 'fahrenheit',
      wind_speed_unit: 'mph',
      precipitation_unit: 'inch',
      timezone: 'auto'
    };

    // Request appropriate data granularity
    if (useHourly) {
      // Hourly data for detailed observations
      params.hourly = [
        'temperature_2m',
        'relative_humidity_2m',
        'dewpoint_2m',
        'apparent_temperature',
        'precipitation',
        'rain',
        'snowfall',
        'weather_code',
        'pressure_msl',
        'cloud_cover',
        'wind_speed_10m',
        'wind_direction_10m',
        'wind_gusts_10m'
      ].join(',');
    } else {
      // Daily summaries for longer time periods
      params.daily = [
        'temperature_2m_max',
        'temperature_2m_min',
        'temperature_2m_mean',
        'apparent_temperature_max',
        'apparent_temperature_min',
        'precipitation_sum',
        'rain_sum',
        'snowfall_sum',
        'precipitation_hours',
        'weather_code',
        'wind_speed_10m_max',
        'wind_gusts_10m_max',
        'wind_direction_10m_dominant'
      ].join(',');
    }

    return params;
  }

  /**
   * Validate that the response contains the expected data
   * @private
   */
  private validateResponse(
    response: OpenMeteoHistoricalResponse,
    startDate: string,
    endDate: string,
    useHourly: boolean
  ): void {
    if (useHourly && (!response.hourly || !response.hourly.time || response.hourly.time.length === 0)) {
      throw new Error(
        `No historical weather data available for the specified date range (${startDate} to ${endDate}).\n\n` +
        'This may occur because:\n' +
        '- The dates are too recent (data has a 5-day delay for most models)\n' +
        '- The dates are before 1940 (earliest available data)\n\n' +
        'Please try adjusting your date range.'
      );
    }

    if (!useHourly && (!response.daily || !response.daily.time || response.daily.time.length === 0)) {
      throw new Error(
        `No historical weather data available for the specified date range (${startDate} to ${endDate}).\n\n` +
        'Please try adjusting your date range.'
      );
    }
  }

  /**
   * Get weather description from WMO weather code
   * WMO Weather interpretation codes (WW): https://open-meteo.com/en/docs
   */
  getWeatherDescription(code: number): string {
    const weatherCodes: { [key: number]: string } = {
      0: 'Clear sky',
      1: 'Mainly clear',
      2: 'Partly cloudy',
      3: 'Overcast',
      45: 'Foggy',
      48: 'Depositing rime fog',
      51: 'Light drizzle',
      53: 'Moderate drizzle',
      55: 'Dense drizzle',
      56: 'Light freezing drizzle',
      57: 'Dense freezing drizzle',
      61: 'Slight rain',
      63: 'Moderate rain',
      65: 'Heavy rain',
      66: 'Light freezing rain',
      67: 'Heavy freezing rain',
      71: 'Slight snow',
      73: 'Moderate snow',
      75: 'Heavy snow',
      77: 'Snow grains',
      80: 'Slight rain showers',
      81: 'Moderate rain showers',
      82: 'Violent rain showers',
      85: 'Slight snow showers',
      86: 'Heavy snow showers',
      95: 'Thunderstorm',
      96: 'Thunderstorm with slight hail',
      99: 'Thunderstorm with heavy hail'
    };

    return weatherCodes[code] || `Unknown (code: ${code})`;
  }

  /**
   * Search for locations by name using the Open-Meteo Geocoding API
   *
   * @param query - Location name to search for (e.g., "Paris", "New York, NY", "Tokyo")
   * @param limit - Maximum number of results to return (default: 5, max: 100)
   * @param language - Language for results (default: 'en')
   * @returns Geocoding results with coordinates and metadata
   */
  async searchLocation(
    query: string,
    limit: number = 5,
    language: string = 'en'
  ): Promise<GeocodingResponse> {
    if (!query || query.trim().length === 0) {
      throw new InvalidLocationError(
        'OpenMeteo',
        'Search query cannot be empty'
      );
    }

    if (query.trim().length === 1) {
      throw new InvalidLocationError(
        'OpenMeteo',
        'Search query must be at least 2 characters long'
      );
    }

    // Validate limit
    if (limit < 1 || limit > 100) {
      throw new InvalidLocationError(
        'OpenMeteo',
        'Limit must be between 1 and 100'
      );
    }

    // Check cache first (locations don't move, so cache indefinitely)
    if (CacheConfig.enabled) {
      const cacheKey = Cache.generateKey('openmeteo-geocoding', query, limit, language);
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return cached as GeocodingResponse;
      }

      const params = {
        name: query.trim(),
        count: limit,
        language,
        format: 'json'
      };

      const response = await this.geocodingClient.get<GeocodingResponse>('/search', { params });

      // Cache indefinitely (locations don't change)
      // Using 30 days as TTL to keep cache from growing unbounded
      this.cache.set(cacheKey, response.data, 30 * 24 * 60 * 60 * 1000);

      return response.data;
    }

    // No caching
    const params = {
      name: query.trim(),
      count: limit,
      language,
      format: 'json'
    };

    const response = await this.geocodingClient.get<GeocodingResponse>('/search', { params });
    return response.data;
  }

  /**
   * Get weather forecast from Open-Meteo Forecast API
   *
   * @param latitude - Latitude coordinate (-90 to 90)
   * @param longitude - Longitude coordinate (-180 to 180)
   * @param days - Number of forecast days (1-16, default: 7)
   * @param hourly - Whether to include hourly data (default: false)
   * @returns Weather forecast data
   */
  async getForecast(
    latitude: number,
    longitude: number,
    days: number = 7,
    hourly: boolean = false,
    model?: OpenMeteoModelId
  ): Promise<OpenMeteoForecastResponse> {
    // Validate coordinates
    validateLatitude(latitude);
    validateLongitude(longitude);

    // Validate days
    if (days < 1 || days > 16) {
      throw new InvalidLocationError(
        'OpenMeteo',
        'Forecast days must be between 1 and 16'
      );
    }

    if (model !== undefined && !Object.prototype.hasOwnProperty.call(OPEN_METEO_MODELS, model)) {
      throw new InvalidLocationError('OpenMeteo', `Unknown forecast model "${String(model)}"`);
    }

    // Build parameters; without a model, Open-Meteo picks and blends models itself ("best match")
    const params = this.buildForecastParams(latitude, longitude, days, hourly);
    if (model) {
      params.models = model;
    }

    const cacheKey = Cache.generateKey('openmeteo-forecast', latitude, longitude, days, hourly, model ?? 'best_match');
    if (CacheConfig.enabled) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return cached as OpenMeteoForecastResponse;
      }
    }

    let response: OpenMeteoForecastResponse;
    try {
      response = await this.makeRequestToForecast<OpenMeteoForecastResponse>('/forecast', params);
    } catch (error) {
      // A regional model asked for a place outside its area: Open-Meteo answers 400 "No data is
      // available for this location", which the shared handler words for the historical archive
      if (model && error instanceof ApiError && /No data is available for this location/i.test(error.userMessage)) {
        throw new DataNotFoundError('OpenMeteo', OUTSIDE_MODEL_AREA);
      }
      throw error;
    }
    this.validateForecastResponse(response, hourly);
    nullsToMissing(response.daily);
    nullsToMissing(response.hourly);

    if (model) {
      // A single model stops at its horizon (ICON ~7.5 days, NAM ~3); drop the empty tail
      // rather than printing days with no forecast. No data at all means the place is outside
      // the model's area (NAM and HRRR cover the continental US only).
      const dayCount = lengthWithData(response.daily?.temperature_2m_max);
      if (response.daily) {
        truncateSeries(response.daily, dayCount);
      }
      if (response.hourly) {
        truncateSeries(response.hourly, lengthWithData(response.hourly.temperature_2m));
      }
      if (dayCount === 0 && lengthWithData(response.hourly?.temperature_2m) === 0) {
        throw new DataNotFoundError('OpenMeteo', OUTSIDE_MODEL_AREA);
      }
    }

    if (CacheConfig.enabled) {
      // Cache for 2 hours (forecasts update regularly)
      this.cache.set(cacheKey, response, 2 * 60 * 60 * 1000);
    }
    return response;
  }

  /**
   * Daily forecast from one specific model, rather than Open-Meteo's automatic blend
   * (used by the model comparison). Days past the model's horizon come back as nulls.
   *
   * @param days - Forecast days (1-16)
   * @param model - One of OPEN_METEO_MODELS
   */
  async getModelForecast(
    latitude: number,
    longitude: number,
    days: number,
    model: OpenMeteoModelId
  ): Promise<OpenMeteoForecastResponse> {
    validateLatitude(latitude);
    validateLongitude(longitude);
    if (!Object.prototype.hasOwnProperty.call(OPEN_METEO_MODELS, model)) {
      throw new InvalidLocationError('OpenMeteo', `Unknown forecast model "${String(model)}"`);
    }
    if (!Number.isInteger(days) || days < 1 || days > 16) {
      throw new InvalidLocationError('OpenMeteo', 'Forecast days must be between 1 and 16');
    }

    const params: Record<string, string | number> = {
      latitude,
      longitude,
      forecast_days: days,
      models: model,
      daily: [
        'temperature_2m_max',
        'temperature_2m_min',
        'precipitation_probability_max',
        'precipitation_sum',
        'wind_speed_10m_max',
        'relative_humidity_2m_mean',
      ].join(','),
      temperature_unit: 'fahrenheit',
      wind_speed_unit: 'mph',
      precipitation_unit: 'inch',
      timezone: 'auto',
    };

    const cacheKey = Cache.generateKey('openmeteo-model-forecast', latitude, longitude, days, model);
    if (CacheConfig.enabled) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return cached as OpenMeteoForecastResponse;
      }
    }

    const response = await this.makeRequestToForecast<OpenMeteoForecastResponse>('/forecast', params);
    this.validateForecastResponse(response, false);

    if (CacheConfig.enabled) {
      // Same 2 hours as other forecasts; models publish new runs every 6-12 hours
      this.cache.set(cacheKey, response, 2 * 60 * 60 * 1000);
    }
    return response;
  }

  /**
   * When the latest run of a model started (ISO 8601 UTC), from Open-Meteo's model metadata.
   * Returns undefined if the metadata can't be read or looks stale, rather than guessing.
   */
  async getModelRunTime(model: OpenMeteoModelId): Promise<string | undefined> {
    if (!Object.prototype.hasOwnProperty.call(OPEN_METEO_MODELS, model)) {
      return undefined;
    }
    const cacheKey = Cache.generateKey('openmeteo-model-run', model);
    if (CacheConfig.enabled) {
      const cached = this.cache.get(cacheKey);
      if (cached !== undefined) {
        return (cached as { run?: string }).run;
      }
    }

    let run: string | undefined;
    try {
      // The metadata lives beside the API, at <host>/data/<model>/static/meta.json
      const origin = new URL(this.forecastClient.defaults.baseURL ?? '').origin;
      const response = await this.forecastClient.get<{ last_run_initialisation_time?: unknown }>(
        `${origin}/data/${OPEN_METEO_MODELS[model].metadata}/static/meta.json`
      );
      const seconds = response.data?.last_run_initialisation_time;
      if (typeof seconds === 'number' && Number.isFinite(seconds)) {
        const ms = seconds * 1000;
        const age = Date.now() - ms;
        if (age >= -60 * 60 * 1000 && age <= MODEL_RUN_MAX_AGE_MS) {
          run = new Date(ms).toISOString();
        }
      }
    } catch {
      run = undefined; // the forecast itself still works; only the label loses its run time
    }

    if (CacheConfig.enabled) {
      this.cache.set(cacheKey, { run }, 15 * 60 * 1000);
    }
    return run;
  }

  /**
   * Build request parameters for forecast data
   * @private
   */
  private buildForecastParams(
    latitude: number,
    longitude: number,
    days: number,
    hourly: boolean
  ): Record<string, string | number> {
    const params: Record<string, string | number> = {
      latitude,
      longitude,
      forecast_days: days,
      temperature_unit: 'fahrenheit',
      wind_speed_unit: 'mph',
      precipitation_unit: 'inch',
      timezone: 'auto'
    };

    // Always include daily data with sunrise/sunset
    params.daily = [
      'weather_code',
      'temperature_2m_max',
      'temperature_2m_min',
      'apparent_temperature_max',
      'apparent_temperature_min',
      'sunrise',
      'sunset',
      'daylight_duration',
      'sunshine_duration',
      'uv_index_max',
      'precipitation_sum',
      'rain_sum',
      'showers_sum',
      'snowfall_sum',
      'precipitation_hours',
      'precipitation_probability_max',
      'wind_speed_10m_max',
      'wind_gusts_10m_max',
      'wind_direction_10m_dominant'
    ].join(',');

    // Optionally include hourly data
    if (hourly) {
      params.hourly = [
        'temperature_2m',
        'relative_humidity_2m',
        'dewpoint_2m',
        'apparent_temperature',
        'precipitation_probability',
        'precipitation',
        'rain',
        'showers',
        'snowfall',
        'snow_depth',
        'weather_code',
        'pressure_msl',
        'cloud_cover',
        'visibility',
        'wind_speed_10m',
        'wind_direction_10m',
        'wind_gusts_10m',
        'uv_index',
        'is_day'
      ].join(',');
    }

    return params;
  }

  /**
   * Make request to forecast API with retry logic
   * @private
   */
  private async makeRequestToForecast<T>(
    url: string,
    params: Record<string, string | number>,
    retries = 0
  ): Promise<T> {
    try {
      const response = await this.forecastClient.get<T>(url, { params });
      return response.data;
    } catch (error) {
      // Retry on rate limit or server errors
      if (retries < this.maxRetries) {
        const shouldRetry =
          (error as Error).message.includes('rate limit') ||
          (error as Error).message.includes('server error') ||
          (error as Error).message.includes('timed out');

        if (shouldRetry) {
          const baseDelay = Math.pow(2, retries) * 1000;
          const delay = baseDelay * (0.5 + Math.random() * 0.5);
          await new Promise(resolve => setTimeout(resolve, delay));
          return this.makeRequestToForecast<T>(url, params, retries + 1);
        }
      }
      throw error;
    }
  }

  /**
   * Validate that the forecast response contains the expected data
   * @private
   */
  private validateForecastResponse(
    response: OpenMeteoForecastResponse,
    hourly: boolean
  ): void {
    if (hourly && (!response.hourly || !response.hourly.time || response.hourly.time.length === 0)) {
      throw new DataNotFoundError(
        'OpenMeteo',
        'No hourly forecast data available for the specified location'
      );
    }

    if (!response.daily || !response.daily.time || response.daily.time.length === 0) {
      throw new DataNotFoundError(
        'OpenMeteo',
        'No daily forecast data available for the specified location'
      );
    }
  }

  /**
   * Get air quality data from Open-Meteo Air Quality API
   *
   * @param latitude - Latitude coordinate (-90 to 90)
   * @param longitude - Longitude coordinate (-180 to 180)
   * @param forecast - Whether to include hourly forecast (default: false, returns current only)
   * @param forecastDays - Number of forecast days (1-7, default: 5)
   * @returns Air quality data including AQI, pollutants, and UV index
   */
  async getAirQuality(
    latitude: number,
    longitude: number,
    forecast: boolean = false,
    forecastDays: number = 5
  ): Promise<OpenMeteoAirQualityResponse> {
    // Validate coordinates
    validateLatitude(latitude);
    validateLongitude(longitude);

    // Validate forecast days
    if (forecastDays < 1 || forecastDays > 7) {
      throw new InvalidLocationError(
        'OpenMeteo',
        'Air quality forecast days must be between 1 and 7'
      );
    }

    // Build parameters
    const params = this.buildAirQualityParams(latitude, longitude, forecast, forecastDays);

    // Check cache first
    if (CacheConfig.enabled) {
      const cacheKey = Cache.generateKey('openmeteo-airquality', latitude, longitude, forecast, forecastDays);
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return cached as OpenMeteoAirQualityResponse;
      }

      const response = await this.makeRequestToAirQuality<OpenMeteoAirQualityResponse>('/air-quality', params);
      this.validateAirQualityResponse(response, forecast);

      // Cache for 1 hour (air quality updates hourly)
      this.cache.set(cacheKey, response, 60 * 60 * 1000);

      return response;
    }

    // No caching
    const response = await this.makeRequestToAirQuality<OpenMeteoAirQualityResponse>('/air-quality', params);
    this.validateAirQualityResponse(response, forecast);
    return response;
  }

  /**
   * Build request parameters for air quality data
   * @private
   */
  private buildAirQualityParams(
    latitude: number,
    longitude: number,
    forecast: boolean,
    forecastDays: number
  ): Record<string, string | number> {
    const params: Record<string, string | number> = {
      latitude,
      longitude,
      timezone: 'auto'
    };

    // Always include current data
    params.current = [
      'pm10',
      'pm2_5',
      'carbon_monoxide',
      'nitrogen_dioxide',
      'sulphur_dioxide',
      'ozone',
      'aerosol_optical_depth',
      'dust',
      'uv_index',
      'uv_index_clear_sky',
      'ammonia',
      'european_aqi',
      'european_aqi_pm2_5',
      'european_aqi_pm10',
      'european_aqi_nitrogen_dioxide',
      'european_aqi_ozone',
      'european_aqi_sulphur_dioxide',
      'us_aqi',
      'us_aqi_pm2_5',
      'us_aqi_pm10',
      'us_aqi_nitrogen_dioxide',
      'us_aqi_ozone',
      'us_aqi_sulphur_dioxide',
      'us_aqi_carbon_monoxide'
    ].join(',');

    // Optionally include hourly forecast data
    if (forecast) {
      params.forecast_days = forecastDays;
      params.hourly = [
        'pm10',
        'pm2_5',
        'carbon_monoxide',
        'nitrogen_dioxide',
        'sulphur_dioxide',
        'ozone',
        'aerosol_optical_depth',
        'dust',
        'uv_index',
        'uv_index_clear_sky',
        'ammonia',
        'european_aqi',
        'european_aqi_pm2_5',
        'european_aqi_pm10',
        'european_aqi_nitrogen_dioxide',
        'european_aqi_ozone',
        'european_aqi_sulphur_dioxide',
        'us_aqi',
        'us_aqi_pm2_5',
        'us_aqi_pm10',
        'us_aqi_nitrogen_dioxide',
        'us_aqi_ozone',
        'us_aqi_sulphur_dioxide',
        'us_aqi_carbon_monoxide'
      ].join(',');
    }

    return params;
  }

  /**
   * Make request to air quality API with retry logic
   * @private
   */
  private async makeRequestToAirQuality<T>(
    url: string,
    params: Record<string, string | number>,
    retries = 0
  ): Promise<T> {
    try {
      const response = await this.airQualityClient.get<T>(url, { params });
      return response.data;
    } catch (error) {
      // Retry on rate limit or server errors
      if (retries < this.maxRetries) {
        const shouldRetry =
          (error as Error).message.includes('rate limit') ||
          (error as Error).message.includes('server error') ||
          (error as Error).message.includes('timed out');

        if (shouldRetry) {
          const baseDelay = Math.pow(2, retries) * 1000;
          const delay = baseDelay * (0.5 + Math.random() * 0.5);
          await new Promise(resolve => setTimeout(resolve, delay));
          return this.makeRequestToAirQuality<T>(url, params, retries + 1);
        }
      }
      throw error;
    }
  }

  /**
   * Validate that the air quality response contains the expected data
   * @private
   */
  private validateAirQualityResponse(
    response: OpenMeteoAirQualityResponse,
    forecast: boolean
  ): void {
    if (!response.current || !response.current.time) {
      throw new DataNotFoundError(
        'OpenMeteo',
        'No current air quality data available for the specified location'
      );
    }

    if (forecast && (!response.hourly || !response.hourly.time || response.hourly.time.length === 0)) {
      throw new DataNotFoundError(
        'OpenMeteo',
        'No hourly air quality forecast data available for the specified location'
      );
    }
  }

  /**
   * Get marine conditions data from Open-Meteo Marine API
   *
   * @param latitude - Latitude coordinate (-90 to 90)
   * @param longitude - Longitude coordinate (-180 to 180)
   * @param forecast - Whether to include hourly forecast (default: false, returns current only)
   * @param forecastDays - Number of forecast days (1-7, default: 5)
   * @returns Marine conditions including waves, swell, and currents
   */
  async getMarine(
    latitude: number,
    longitude: number,
    forecast: boolean = false,
    forecastDays: number = 5
  ): Promise<OpenMeteoMarineResponse> {
    // Validate coordinates
    validateLatitude(latitude);
    validateLongitude(longitude);

    // Validate forecast days
    if (forecastDays < 1 || forecastDays > 7) {
      throw new InvalidLocationError(
        'OpenMeteo',
        'Marine forecast days must be between 1 and 7'
      );
    }

    // Build parameters
    const params = this.buildMarineParams(latitude, longitude, forecast, forecastDays);

    // Check cache first
    if (CacheConfig.enabled) {
      const cacheKey = Cache.generateKey('openmeteo-marine', latitude, longitude, forecast, forecastDays);
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return cached as OpenMeteoMarineResponse;
      }

      const response = await this.makeRequestToMarine<OpenMeteoMarineResponse>('/marine', params);
      this.validateMarineResponse(response, forecast);

      // Cache for 1 hour (marine conditions update hourly)
      this.cache.set(cacheKey, response, 60 * 60 * 1000);

      return response;
    }

    // No caching
    const response = await this.makeRequestToMarine<OpenMeteoMarineResponse>('/marine', params);
    this.validateMarineResponse(response, forecast);
    return response;
  }

  /**
   * Build request parameters for marine data
   * @private
   */
  private buildMarineParams(
    latitude: number,
    longitude: number,
    forecast: boolean,
    forecastDays: number
  ): Record<string, string | number> {
    const params: Record<string, string | number> = {
      latitude,
      longitude,
      timezone: 'auto'
    };

    // Always include current data
    params.current = [
      'wave_height',
      'wave_direction',
      'wave_period',
      'wind_wave_height',
      'wind_wave_direction',
      'wind_wave_period',
      'wind_wave_peak_period',
      'swell_wave_height',
      'swell_wave_direction',
      'swell_wave_period',
      'swell_wave_peak_period',
      'ocean_current_velocity',
      'ocean_current_direction'
    ].join(',');

    // Optionally include hourly forecast data
    if (forecast) {
      params.forecast_days = forecastDays;
      params.hourly = [
        'wave_height',
        'wave_direction',
        'wave_period',
        'wind_wave_height',
        'wind_wave_direction',
        'wind_wave_period',
        'wind_wave_peak_period',
        'swell_wave_height',
        'swell_wave_direction',
        'swell_wave_period',
        'swell_wave_peak_period',
        'ocean_current_velocity',
        'ocean_current_direction'
      ].join(',');

      // Also include daily aggregates
      params.daily = [
        'wave_height_max',
        'wave_direction_dominant',
        'wave_period_max',
        'wind_wave_height_max',
        'wind_wave_direction_dominant',
        'wind_wave_period_max',
        'wind_wave_peak_period_max',
        'swell_wave_height_max',
        'swell_wave_direction_dominant',
        'swell_wave_period_max',
        'swell_wave_peak_period_max'
      ].join(',');
    }

    return params;
  }

  /**
   * Make request to marine API with retry logic
   * @private
   */
  private async makeRequestToMarine<T>(
    url: string,
    params: Record<string, string | number>,
    retries = 0
  ): Promise<T> {
    try {
      const response = await this.marineClient.get<T>(url, { params });
      return response.data;
    } catch (error) {
      // Retry on rate limit or server errors
      if (retries < this.maxRetries) {
        const shouldRetry =
          (error as Error).message.includes('rate limit') ||
          (error as Error).message.includes('server error') ||
          (error as Error).message.includes('timed out');

        if (shouldRetry) {
          const baseDelay = Math.pow(2, retries) * 1000;
          const delay = baseDelay * (0.5 + Math.random() * 0.5);
          await new Promise(resolve => setTimeout(resolve, delay));
          return this.makeRequestToMarine<T>(url, params, retries + 1);
        }
      }
      throw error;
    }
  }

  /**
   * Validate that the marine response contains the expected data
   * @private
   */
  private validateMarineResponse(
    response: OpenMeteoMarineResponse,
    forecast: boolean
  ): void {
    if (!response.current || !response.current.time) {
      throw new DataNotFoundError(
        'OpenMeteo',
        'No current marine conditions data available for the specified location'
      );
    }

    if (forecast && (!response.hourly || !response.hourly.time || response.hourly.time.length === 0)) {
      throw new DataNotFoundError(
        'OpenMeteo',
        'No hourly marine forecast data available for the specified location'
      );
    }
  }

  /**
   * Compute climate normals (30-year averages) for a specific date
   *
   * Fetches 30 years of historical data (1991-2020) and computes averages
   * for the specified month/day. Results are cached indefinitely since
   * climate normals don't change.
   *
   * @param latitude - Latitude (-90 to 90)
   * @param longitude - Longitude (-180 to 180)
   * @param month - Month (1-12)
   * @param day - Day of month (1-31)
   * @returns Climate normals (30-year averages) in Fahrenheit and inches
   * @throws {InvalidLocationError} If coordinates are invalid
   * @throws {DataNotFoundError} If no historical data available
   * @throws {ServiceUnavailableError} If Open-Meteo API is unavailable
   */
  async getClimateNormals(
    latitude: number,
    longitude: number,
    month: number,
    day: number
  ): Promise<ClimateNormals> {
    validateLatitude(latitude);
    validateLongitude(longitude);

    // Check cache first (normals don't change, so cache forever)
    const cacheKey = getNormalsCacheKey(latitude, longitude, month, day);
    if (CacheConfig.enabled) {
      const cached = this.cache.get(cacheKey) as ClimateNormals | undefined;
      if (cached) {
        const redacted = redactCoordinatesForLogging(latitude, longitude);
        logger.info('Climate normals cache hit', { ...redacted, month, day });
        return cached;
      }
    }

    const redacted = redactCoordinatesForLogging(latitude, longitude);
    logger.info('Computing climate normals from 30-year historical data', {
      ...redacted,
      month,
      day
    });

    // Fetch 30 years of historical data (1991-2020 climate normals period)
    // Optimization: Fetch only the target month ±1 month across 30 years
    // to reduce data transfer while ensuring we capture all occurrences
    const startYear = 1991;
    const endYear = 2020;

    // Determine month range to fetch (target month ±1 to handle edge cases)
    const startMonth = month === 1 ? 12 : month - 1;
    const endMonth = month === 12 ? 1 : month + 1;

    const startDate = `${startYear}-${String(startMonth).padStart(2, '0')}-01`;
    const endDate = `${endYear}-${String(endMonth).padStart(2, '0')}-${this.getLastDayOfMonth(endYear, endMonth)}`;

    // Build request parameters
    const params: Record<string, string | number> = {
      latitude,
      longitude,
      start_date: startDate,
      end_date: endDate,
      daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum',
      timezone: 'UTC' // Use UTC for consistency
    };

    try {
      // Make request to historical API
      const response = await this.makeRequest<OpenMeteoHistoricalResponse>('/archive', params);

      // Compute normals from 30-year data
      const normals = computeNormalsFrom30YearData(response, month, day);

      // Cache indefinitely (normals don't change) if caching is enabled
      if (CacheConfig.enabled) {
        this.cache.set(cacheKey, normals, Infinity);
      }

      const successRedacted = redactCoordinatesForLogging(latitude, longitude);
      logger.info('Climate normals computed successfully', {
        ...successRedacted,
        month,
        day,
        tempHigh: normals.tempHigh,
        tempLow: normals.tempLow,
        precipitation: normals.precipitation
      });

      return normals;
    } catch (error) {
      logger.error('Failed to compute climate normals', error as Error);
      throw error;
    }
  }

  /**
   * Get the last day of a given month
   * @private
   */
  private getLastDayOfMonth(year: number, month: number): string {
    // Create date at start of next month, then go back 1 day
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    const lastDay = new Date(nextYear, nextMonth - 1, 0).getDate();
    return String(lastDay).padStart(2, '0');
  }
}
