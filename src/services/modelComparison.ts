import { DateTime } from 'luxon';
import { NOMADSService } from './nomads.js';
import { OpenMeteoService, OpenMeteoModelId } from './openmeteo.js';
import { ApiError } from '../errors/ApiError.js';
import { DEFAULT_COMPARISON_MODELS } from '../types/modelComparison.js';
import type {
  ComparisonModel,
  ComparisonModelSeries,
  ComparisonDayValues,
  ModelComparisonResult,
} from '../types/modelComparison.js';
import type { OpenMeteoForecastResponse } from '../types/openmeteo.js';

type OpenMeteoComparisonModel = 'ecmwf' | 'ecmwf_aifs' | 'icon' | 'gem';

/**
 * Models served by Open-Meteo. Horizons are how far each one's free output reaches
 * (checked against the live API on 2026-10-28: ICON 7 days, GEM 10, both ECMWF 15).
 */
const OPEN_METEO_SERIES: Record<OpenMeteoComparisonModel, { id: OpenMeteoModelId; label: string; horizonHours: number }> = {
  ecmwf: { id: 'ecmwf_ifs', label: 'ECMWF IFS (Open-Meteo)', horizonHours: 360 },
  ecmwf_aifs: { id: 'ecmwf_aifs025_single', label: 'ECMWF AIFS (Open-Meteo)', horizonHours: 360 },
  icon: { id: 'icon_global', label: 'ICON Global (DWD, via Open-Meteo)', horizonHours: 180 },
  gem: { id: 'gem_global', label: 'GEM Global (Canada, via Open-Meteo)', horizonHours: 240 },
};

const finite = (value: number | null | undefined): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

export class ModelComparisonService {
  constructor(
    private readonly nomadsService: NOMADSService,
    private readonly openMeteoService: OpenMeteoService
  ) {}

  async compare(
    latitude: number,
    longitude: number,
    days: number,
    models: ComparisonModel[]
  ): Promise<ModelComparisonResult> {
    const requestedDays = Math.max(1, Math.min(days, 10));

    const requestedModels = models.length > 0
      ? Array.from(new Set(models))
      : DEFAULT_COMPARISON_MODELS;

    const notes: string[] = [];
    const series: ComparisonModelSeries[] = [];

    const modelFetches = requestedModels.map(async (model) => {
      try {
        switch (model) {
          case 'gfs':
            return await this.fetchGfsSeries(latitude, longitude, requestedDays);
          case 'nam':
            return await this.fetchNamSeries(latitude, longitude, requestedDays);
          case 'hrrr':
            return await this.fetchHrrrSeries(latitude, longitude, requestedDays);
          case 'ecmwf':
          case 'ecmwf_aifs':
          case 'icon':
          case 'gem':
            return await this.fetchOpenMeteoSeries(model, latitude, longitude, requestedDays);
          default:
            return null;
        }
      } catch (error) {
        // ApiError.message is a generic summary; userMessage says what went wrong
        const reason = error instanceof ApiError ? error.userMessage
          : error instanceof Error ? error.message
          : 'Unknown error';
        notes.push(`${labelFor(model)} unavailable: ${reason}`);
        return null;
      }
    });

    const fetchedSeries = await Promise.all(modelFetches);
    for (const item of fetchedSeries) {
      if (item) {
        series.push(item);
      }
    }

    const timezone = series[0]?.timezone || 'UTC';
    const dayKeys = this.buildDayKeys(timezone, requestedDays);

    // Say which models stop before the end of the window, rather than leaving bare N/As
    for (const item of series) {
      if (item.horizonHours < requestedDays * 24) {
        notes.push(`${item.label} reaches about ${formatHorizon(item.horizonHours)}; later days are shown as N/A.`);
      }
    }
    if (series.some((item) => item.model === 'hrrr')) {
      notes.push('HRRR covers the continental US only; requests elsewhere fail for this model.');
    }

    const openMeteoLabels = series.filter((item) => item.model in OPEN_METEO_SERIES).map((item) => item.label);
    if (openMeteoLabels.length > 0) {
      notes.push(
        `${openMeteoLabels.join(', ')}: each model's own forecast, interpolated to this point by Open-Meteo ` +
        '(GFS, NAM and HRRR are read directly from NOAA\'s files, so small differences can come from processing as well as the models). ' +
        'A single model run has no precipitation chance; Open-Meteo adds one where it can' +
        (series.some((item) => item.model === 'ecmwf_aifs') ? ', and AIFS has none.' : '.')
      );
    }

    return {
      latitude,
      longitude,
      timezone,
      requestedDays,
      days: dayKeys,
      series,
      notes,
    };
  }

  private async fetchGfsSeries(latitude: number, longitude: number, days: number): Promise<ComparisonModelSeries> {
    const forecast = await this.nomadsService.getForecast(latitude, longitude, days);

    return {
      model: 'gfs',
      label: 'GFS (NOMADS)',
      modelRun: forecast.model_run,
      horizonHours: 240,
      timezone: forecast.timezone,
      daily: this.convertNomadsDailyToMap(forecast.daily),
    };
  }

  private async fetchNamSeries(latitude: number, longitude: number, days: number): Promise<ComparisonModelSeries> {
    const forecast = await this.nomadsService.getNamForecast(latitude, longitude, days);

    return {
      model: 'nam',
      label: 'NAM (NOMADS)',
      modelRun: forecast.model_run,
      horizonHours: 84,
      timezone: forecast.timezone,
      daily: this.convertNomadsDailyToMap(forecast.daily),
      note: 'Limited deterministic horizon (~84h).',
    };
  }

  private async fetchHrrrSeries(latitude: number, longitude: number, days: number): Promise<ComparisonModelSeries> {
    const forecast = await this.nomadsService.getHrrrForecast(latitude, longitude, days);

    return {
      model: 'hrrr',
      label: 'HRRR (NOMADS)',
      modelRun: forecast.model_run,
      horizonHours: 48,
      timezone: forecast.timezone,
      daily: this.convertNomadsDailyToMap(forecast.daily),
      note: 'CONUS-only, limited deterministic horizon (48h).',
    };
  }

  private async fetchOpenMeteoSeries(
    model: OpenMeteoComparisonModel,
    latitude: number,
    longitude: number,
    days: number
  ): Promise<ComparisonModelSeries> {
    const { id, label, horizonHours } = OPEN_METEO_SERIES[model];
    const [forecast, modelRun] = await Promise.all([
      this.openMeteoService.getModelForecast(latitude, longitude, days, id),
      this.openMeteoService.getModelRunTime(id),
    ]);

    return {
      model,
      label,
      modelRun,
      horizonHours,
      timezone: forecast.timezone,
      daily: this.convertOpenMeteoDailyToMap(forecast),
    };
  }

  /** Days past the model's horizon come back as nulls; they are left out so they show as N/A */
  private convertOpenMeteoDailyToMap(forecast: OpenMeteoForecastResponse): Record<string, ComparisonDayValues> {
    const daily = forecast.daily;
    const mapped: Record<string, ComparisonDayValues> = {};
    if (!daily) {
      return mapped;
    }

    for (let i = 0; i < daily.time.length; i++) {
      const values: ComparisonDayValues = {
        temperatureHighF: finite(daily.temperature_2m_max?.[i]),
        temperatureLowF: finite(daily.temperature_2m_min?.[i]),
        precipitationChancePct: finite(daily.precipitation_probability_max?.[i]),
        precipitationTotalIn: finite(daily.precipitation_sum?.[i]),
        windMaxMph: finite(daily.wind_speed_10m_max?.[i]),
        humidityMeanPct: finite(daily.relative_humidity_2m_mean?.[i]),
      };
      // Precipitation chance alone doesn't make a day (GEM reports it past its 10-day run)
      if (values.temperatureHighF !== undefined || values.temperatureLowF !== undefined || values.precipitationTotalIn !== undefined) {
        mapped[daily.time[i]] = values;
      }
    }
    return mapped;
  }

  private convertNomadsDailyToMap(daily: {
    time: string[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_probability_max: number[];
    precipitation_sum: number[];
    wind_speed_10m_max: number[];
    relative_humidity_2m_mean: number[];
  }): Record<string, ComparisonDayValues> {
    const mapped: Record<string, ComparisonDayValues> = {};

    for (let i = 0; i < daily.time.length; i++) {
      const key = daily.time[i];
      mapped[key] = {
        temperatureHighF: Number.isFinite(daily.temperature_2m_max[i]) ? daily.temperature_2m_max[i] : undefined,
        temperatureLowF: Number.isFinite(daily.temperature_2m_min[i]) ? daily.temperature_2m_min[i] : undefined,
        precipitationChancePct: Number.isFinite(daily.precipitation_probability_max[i]) ? daily.precipitation_probability_max[i] : undefined,
        precipitationTotalIn: Number.isFinite(daily.precipitation_sum[i]) ? daily.precipitation_sum[i] : undefined,
        windMaxMph: Number.isFinite(daily.wind_speed_10m_max[i]) ? daily.wind_speed_10m_max[i] : undefined,
        humidityMeanPct: Number.isFinite(daily.relative_humidity_2m_mean[i]) ? daily.relative_humidity_2m_mean[i] : undefined,
      };
    }

    return mapped;
  }

  private buildDayKeys(timezone: string, days: number): string[] {
    const start = DateTime.now().setZone(timezone).startOf('day');
    const keys: string[] = [];

    for (let i = 0; i < days; i++) {
      const key = start.plus({ days: i }).toISODate();
      if (key) {
        keys.push(key);
      }
    }

    return keys;
  }
}

const NOMADS_LABELS: Record<'gfs' | 'nam' | 'hrrr', string> = { gfs: 'GFS', nam: 'NAM', hrrr: 'HRRR' };

function labelFor(model: ComparisonModel): string {
  return model in OPEN_METEO_SERIES
    ? OPEN_METEO_SERIES[model as OpenMeteoComparisonModel].label
    : NOMADS_LABELS[model as 'gfs' | 'nam' | 'hrrr'];
}

function formatHorizon(hours: number): string {
  return hours % 24 === 0 ? `${hours / 24} days` : `${(hours / 24).toFixed(1)} days (${hours} h)`;
}
