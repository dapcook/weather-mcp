/**
 * Type definitions for the Hourly Weather Meteogram
 * Multi-panel, time-aligned hourly forecast metrics across NOAA and Open-Meteo models.
 */

export type MeteogramModelId =
  | 'auto'
  | 'noaa'
  | 'ecmwf'
  | 'ecmwf_aifs'
  | 'gfs'
  | 'hrrr'
  | 'nam'
  | 'icon'
  | 'gem';

export interface MeteogramHour {
  /** ISO-8601 formatted timestamp in local or specified timezone */
  time: string;
  /** Unix epoch time in milliseconds */
  timeMs: number;
  /** Daytime vs nighttime for background shading */
  isDay: boolean;
  /** Temperature in °F */
  temperature: number;
  /** Dewpoint in °F */
  dewpoint: number | null;
  /** Apparent temperature / Heat Index / Wind Chill in °F */
  apparentTemperature: number | null;
  /** Sustained wind speed in mph */
  windSpeed: number;
  /** Peak wind gusts in mph */
  windGust: number | null;
  /** Wind direction in degrees (0 = North, 90 = East, 180 = South, 270 = West) */
  windDirection: number | null;
  /** Compass wind direction abbreviation (e.g. "SSE", "NNW") */
  windDirectionCompass?: string;
  /** Relative humidity percentage (0-100) */
  relativeHumidity: number | null;
  /** Probability of precipitation (0-100) */
  precipitationProbability: number | null;
  /** Sky cover / cloud cover percentage (0-100) */
  cloudCover: number | null;
  /** Liquid equivalent precipitation amount in inches */
  precipitation: number;
  /** Liquid rain amount in inches */
  rain: number | null;
  /** Snowfall amount in inches */
  snowfall: number | null;
  /** Probability of thunderstorm (0-100) */
  thunderProbability: number | null;
  /** WMO weather code if provided */
  weatherCode?: number;
  /** Short descriptive condition summary (e.g. "Chance Light Rain") */
  shortForecast?: string;
}

export interface MeteogramResponse {
  location: {
    latitude: number;
    longitude: number;
    name?: string;
    timezone: string;
    elevationM?: number;
  };
  model: {
    id: MeteogramModelId;
    label: string;
    source: 'noaa' | 'openmeteo';
    runTime?: string;
    description: string;
  };
  days: number;
  hours: MeteogramHour[];
  generatedAt: string;
}
