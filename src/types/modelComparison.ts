/**
 * gfs, nam and hrrr are decoded from NOAA's NOMADS model runs; ecmwf, ecmwf_aifs, icon and gem
 * are each model's own output served by Open-Meteo.
 */
export type ComparisonModel = 'gfs' | 'nam' | 'hrrr' | 'ecmwf' | 'ecmwf_aifs' | 'icon' | 'gem';

/** Used when the caller doesn't choose: HRRR (CONUS only) and AIFS are opt-in */
export const DEFAULT_COMPARISON_MODELS: ComparisonModel[] = ['gfs', 'nam', 'ecmwf', 'icon', 'gem'];

export const ALL_COMPARISON_MODELS: ComparisonModel[] = ['gfs', 'nam', 'hrrr', 'ecmwf', 'ecmwf_aifs', 'icon', 'gem'];

export interface ComparisonDayValues {
  temperatureHighF?: number;
  temperatureLowF?: number;
  precipitationChancePct?: number;
  precipitationTotalIn?: number;
  windMaxMph?: number;
  humidityMeanPct?: number;
}

export interface ComparisonModelSeries {
  model: ComparisonModel;
  label: string;
  /** Run (initialisation) time, ISO 8601 UTC; undefined when the source doesn't report it reliably */
  modelRun?: string;
  horizonHours: number;
  timezone: string;
  daily: Record<string, ComparisonDayValues>;
  note?: string;
}

export interface ModelComparisonResult {
  latitude: number;
  longitude: number;
  timezone: string;
  requestedDays: number;
  days: string[];
  series: ComparisonModelSeries[];
  notes: string[];
}
