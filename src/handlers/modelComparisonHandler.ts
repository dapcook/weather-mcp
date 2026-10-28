import { DateTime } from 'luxon';
import { LocationStore } from '../services/locationStore.js';
import { ModelComparisonService } from '../services/modelComparison.js';
import { resolveLocation } from '../utils/locationResolver.js';
import { validateForecastDays } from '../utils/validation.js';
import { ALL_COMPARISON_MODELS, DEFAULT_COMPARISON_MODELS } from '../types/modelComparison.js';
import type { ComparisonModel } from '../types/modelComparison.js';

interface ModelComparisonArgs {
  latitude?: number;
  longitude?: number;
  location_name?: string;
  days?: number;
  models?: ComparisonModel[];
}

/**
 * Other names accepted for a model. "ecmwf_proxy" was the old name of the ECMWF row, when it
 * showed Open-Meteo's automatic blend; it now means the real ECMWF IFS.
 */
const MODEL_ALIASES: Record<string, ComparisonModel> = {
  ecmwf_proxy: 'ecmwf',
  ecmwf_ifs: 'ecmwf',
  ifs: 'ecmwf',
  aifs: 'ecmwf_aifs',
  ecmwf_aifs025: 'ecmwf_aifs',
  icon_global: 'icon',
  dwd_icon: 'icon',
  gem_global: 'gem',
  gdps: 'gem',
};

export function parseModels(models?: unknown): ComparisonModel[] {
  if (!Array.isArray(models)) {
    return [...DEFAULT_COMPARISON_MODELS];
  }

  const allowed = new Set<ComparisonModel>(ALL_COMPARISON_MODELS);
  const normalized = models
    .map((item) => String(item).trim().toLowerCase())
    .map((item) => MODEL_ALIASES[item] ?? item)
    .filter((item): item is ComparisonModel => allowed.has(item as ComparisonModel));

  return normalized.length > 0 ? Array.from(new Set(normalized)) : [...DEFAULT_COMPARISON_MODELS];
}

function formatValue(value: number | undefined, digits = 0, suffix = ''): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'N/A';
  }

  return `${value.toFixed(digits)}${suffix}`;
}

export async function handleGetModelComparisonForecast(
  args: unknown,
  modelComparisonService: ModelComparisonService,
  locationStore: LocationStore
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { latitude, longitude } = resolveLocation(args as ModelComparisonArgs, locationStore);
  const days = validateForecastDays(args);
  const models = parseModels((args as ModelComparisonArgs)?.models);

  const comparison = await modelComparisonService.compare(latitude, longitude, days, models);

  let output = '# Multi-Model Forecast Comparison\n\n';
  output += `**Location:** ${latitude.toFixed(4)}, ${longitude.toFixed(4)}\n`;
  output += `**Timezone:** ${comparison.timezone}\n`;
  output += `**Requested Window:** ${comparison.requestedDays} days\n\n`;

  output += '## Model Availability\n';
  for (const series of comparison.series) {
    const run = series.modelRun
      ? `run ${DateTime.fromISO(series.modelRun).toUTC().toFormat('yyyy-LL-dd HH:mm')}Z`
      : 'latest run (time not reported)';
    output += `- **${series.label}:** ${run}, horizon ${series.horizonHours}h\n`;
  }
  output += '\n';

  if (comparison.notes.length > 0) {
    output += '## Notes\n';
    for (const note of comparison.notes) {
      output += `- ${note}\n`;
    }
    output += '\n';
  }

  for (const dayKey of comparison.days) {
    const label = DateTime.fromISO(dayKey, { zone: comparison.timezone }).toLocaleString({
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    });

    output += `## ${label}\n`;

    for (const series of comparison.series) {
      const values = series.daily[dayKey];

      if (!values) {
        const pastHorizon = comparison.days.indexOf(dayKey) * 24 >= series.horizonHours - 24;
        output += pastHorizon
          ? `- **${series.label}:** N/A (beyond its ~${series.horizonHours}h horizon)\n`
          : `- **${series.label}:** N/A\n`;
        continue;
      }

      const tempHigh = formatValue(values.temperatureHighF, 0, '°F');
      const tempLow = formatValue(values.temperatureLowF, 0, '°F');
      const precipChance = formatValue(values.precipitationChancePct, 0, '%');
      const precipTotal = formatValue(values.precipitationTotalIn, 2, ' in');
      const wind = formatValue(values.windMaxMph, 0, ' mph');
      const humidity = formatValue(values.humidityMeanPct, 0, '%');

      output += `- **${series.label}:** High ${tempHigh} / Low ${tempLow}; Precip ${precipChance}; Total ${precipTotal}; Wind ${wind}; Humidity ${humidity}\n`;
    }

    output += '\n';
  }

  output += '---\n';
  output += '*GFS, NAM and HRRR are decoded from NOAA NOMADS model runs; ECMWF, AIFS, ICON and GEM are those models\' own forecasts served by Open-Meteo. HRRR is CONUS-only.*\n';

  return {
    content: [
      {
        type: 'text',
        text: output,
      },
    ],
  };
}
