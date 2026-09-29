/**
 * Precipitation type (rain, snow, sleet, freezing rain, ...) for forecasts.
 *
 * NOAA gridpoint `weather` data names each type with a likelihood per time
 * interval. Open-Meteo gives rain, shower and snowfall amounts plus a WMO
 * weather code. Both are reduced to a short list of mentions that forecast
 * output shows only when precipitation is expected.
 */

import type { GridpointProperties } from '../types/noaa.js';
import { logger } from './logger.js';

export type PrecipType =
  | 'freezing_rain'
  | 'freezing_drizzle'
  | 'sleet'
  | 'snow'
  | 'hail'
  | 'rain'
  | 'drizzle';

export interface PrecipTypeMention {
  type: PrecipType;
  /** Likelihood ("likely") for NOAA, or amount ("0.25 in") for Open-Meteo */
  detail?: string;
}

/** Display order when likelihoods tie: most hazardous first */
const TYPE_ORDER: PrecipType[] = ['freezing_rain', 'freezing_drizzle', 'sleet', 'snow', 'hail', 'rain', 'drizzle'];

const TYPE_LABELS: Record<PrecipType, string> = {
  freezing_rain: 'freezing rain',
  freezing_drizzle: 'freezing drizzle',
  sleet: 'sleet',
  snow: 'snow',
  hail: 'hail',
  rain: 'rain',
  drizzle: 'drizzle',
};

/** Types that glaze roads, trees and power lines */
const ICING_TYPES: ReadonlySet<PrecipType> = new Set(['freezing_rain', 'freezing_drizzle', 'sleet']);
const FROZEN_TYPES: ReadonlySet<PrecipType> = new Set(['snow', 'sleet', 'freezing_rain', 'freezing_drizzle']);
const LIQUID_TYPES: ReadonlySet<PrecipType> = new Set(['rain', 'drizzle']);

/**
 * NWS gridpoint weather values that are a precipitation type. Others (fog,
 * haze, smoke, blowing snow, thunderstorms, ...) describe conditions, not what
 * falls, and are left to the period's text forecast.
 */
const NWS_WEATHER_TYPES: Record<string, PrecipType> = {
  rain: 'rain',
  rain_showers: 'rain',
  drizzle: 'drizzle',
  snow: 'snow',
  snow_showers: 'snow',
  sleet: 'sleet',
  freezing_rain: 'freezing_rain',
  freezing_drizzle: 'freezing_drizzle',
  hail: 'hail',
};

/** NWS coverage terms ranked by how likely/extensive they are */
const COVERAGE_RANK: Record<string, number> = {
  slight_chance: 1,
  isolated: 1,
  patchy: 1,
  brief: 1,
  chance: 2,
  scattered: 2,
  areas: 2,
  periods: 2,
  occasional: 2,
  intermittent: 2,
  likely: 3,
  numerous: 3,
  frequent: 3,
  definite: 4,
  widespread: 4,
};
const UNKNOWN_COVERAGE_RANK = 2;

/** Open-Meteo amounts below these are trace and not worth naming (inches) */
const LIQUID_TRACE_IN = 0.01;
const SNOW_TRACE_IN = 0.1;

/**
 * Parse an NWS validTime interval ("2026-09-30T08:00:00+00:00/PT4H")
 * into epoch-millisecond bounds.
 */
export function parseValidTime(validTime: string): { start: number; end: number } | null {
  const [startIso, duration] = validTime.split('/');
  const start = Date.parse(startIso);
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(duration ?? '');
  if (!Number.isFinite(start) || !match) {
    return null;
  }
  const minutes = Number(match[1] ?? 0) * 24 * 60 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  return { start, end: start + minutes * 60_000 };
}

function coverageLabel(coverage: string | null): string | undefined {
  if (!coverage) {
    return undefined;
  }
  return coverage === 'definite' ? 'expected' : coverage.replace(/_/g, ' ');
}

/**
 * Precipitation types NOAA forecasts during [start, end), each with the
 * highest likelihood it reaches in that window.
 *
 * @param maxEntries - Defense-in-depth cap on intervals processed
 */
export function getNoaaPrecipTypes(
  properties: GridpointProperties,
  start: Date | string,
  end: Date | string,
  maxEntries: number = 500
): PrecipTypeMention[] {
  let values = properties.weather?.values ?? [];
  if (values.length > maxEntries) {
    logger.warn('Gridpoint weather series exceeds max entries', {
      length: values.length,
      maxEntries,
      securityEvent: true,
    });
    // Local copy only; the gridpoint response is cached and shared
    values = values.slice(0, maxEntries);
  }

  const windowStart = new Date(start).getTime();
  const windowEnd = new Date(end).getTime();
  const best = new Map<PrecipType, { coverage: string | null; rank: number }>();

  for (const entry of values) {
    const interval = parseValidTime(entry.validTime);
    if (!interval || interval.end <= windowStart || interval.start >= windowEnd) {
      continue;
    }
    for (const condition of entry.value ?? []) {
      const type = condition.weather ? NWS_WEATHER_TYPES[condition.weather] : undefined;
      if (!type) {
        continue;
      }
      const rank = (condition.coverage && COVERAGE_RANK[condition.coverage]) || UNKNOWN_COVERAGE_RANK;
      const current = best.get(type);
      if (!current || rank > current.rank) {
        best.set(type, { coverage: condition.coverage, rank });
      }
    }
  }

  return [...best.entries()]
    .sort(([typeA, a], [typeB, b]) => b.rank - a.rank || TYPE_ORDER.indexOf(typeA) - TYPE_ORDER.indexOf(typeB))
    .map(([type, { coverage }]) => ({ type, detail: coverageLabel(coverage) }));
}

export interface OpenMeteoPrecipInput {
  /** Rain amount (inches) */
  rain?: number;
  /** Convective shower amount (inches) */
  showers?: number;
  /** Snowfall depth (inches of snow, not water equivalent) */
  snowfall?: number;
  /** WMO weather code */
  weatherCode?: number;
}

/**
 * Precipitation types from Open-Meteo amounts and WMO weather code.
 *
 * Open-Meteo has no sleet category. Freezing rain/drizzle and hail are only
 * known from the weather code, which for daily data is the day's single most
 * significant condition, so a day with both snow and freezing rain reports snow.
 */
export function getOpenMeteoPrecipTypes(input: OpenMeteoPrecipInput): PrecipTypeMention[] {
  const liquid = (input.rain ?? 0) + (input.showers ?? 0);
  const snow = input.snowfall ?? 0;
  const code = input.weatherCode;
  const mentions: PrecipTypeMention[] = [];

  if (snow >= SNOW_TRACE_IN) {
    mentions.push({ type: 'snow', detail: `${snow.toFixed(1)} in` });
  }

  if (liquid >= LIQUID_TRACE_IN) {
    let type: PrecipType = 'rain';
    if (code === 66 || code === 67) {
      type = 'freezing_rain';
    } else if (code === 56 || code === 57) {
      type = 'freezing_drizzle';
    } else if (code === 51 || code === 53 || code === 55) {
      type = 'drizzle';
    }
    mentions.push({ type, detail: `${liquid.toFixed(2)} in` });
  }

  if (code === 96 || code === 99) {
    mentions.push({ type: 'hail' });
  }

  return mentions.sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type));
}

/**
 * Format mentions as markdown lines, or '' when there is nothing to show.
 * Adds a wintry-mix note and an icing warning where they apply.
 */
export function formatPrecipTypes(mentions: PrecipTypeMention[]): string {
  if (mentions.length === 0) {
    return '';
  }

  const parts = mentions.map(({ type, detail }, index) => {
    const label = index === 0 ? TYPE_LABELS[type].replace(/^./, (c) => c.toUpperCase()) : TYPE_LABELS[type];
    return detail ? `${label} (${detail})` : label;
  });

  const types = new Set(mentions.map((m) => m.type));
  const isMix = [...types].some((t) => FROZEN_TYPES.has(t)) && [...types].some((t) => LIQUID_TYPES.has(t));

  let output = `**Precipitation Type:** ${parts.join(', ')}${isMix ? ' (wintry mix)' : ''}\n`;

  const icing = mentions.filter((m) => ICING_TYPES.has(m.type)).map((m) => TYPE_LABELS[m.type]);
  if (icing.length > 0) {
    output += `⚠️ **Icing Risk:** ${icing.join(' and ')} can glaze roads, trees, and power lines\n`;
  }

  return output;
}
