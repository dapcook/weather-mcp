import { DateTime } from 'luxon';
import { LocationStore } from '../services/locationStore.js';
import { ModelComparisonService } from '../services/modelComparison.js';
import { resolveLocation } from '../utils/locationResolver.js';
import { validateForecastDays } from '../utils/validation.js';
import { ALL_COMPARISON_MODELS, DEFAULT_COMPARISON_MODELS } from '../types/modelComparison.js';
import type { ComparisonModel, ComparisonDayValues } from '../types/modelComparison.js';

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

/** Names for the table's Model column; the full source labels are listed above the tables */
const SHORT_NAMES: Record<ComparisonModel, string> = {
  gfs: 'GFS',
  nam: 'NAM',
  hrrr: 'HRRR',
  ecmwf: 'ECMWF IFS',
  ecmwf_aifs: 'ECMWF AIFS',
  icon: 'ICON',
  gem: 'GEM',
};

const NOMADS_MODELS = new Set<ComparisonModel>(['gfs', 'nam', 'hrrr']);

/** "min–max" across models, or one value when they agree; blank when fewer than two have it */
function formatRange(values: Array<number | undefined>, digits: number, suffix: string): string {
  const present = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (present.length < 2) {
    return '';
  }
  const lo = Math.min(...present).toFixed(digits);
  const hi = Math.max(...present).toFixed(digits);
  return lo === hi ? `${lo}${suffix}` : `${lo}–${hi}${suffix}`;
}

function formatValue(value: number | undefined, digits = 0, suffix = ''): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '—';
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

  // One table per day, one row per model, so values line up for comparison
  const nomadsShown = comparison.series.some((series) => NOMADS_MODELS.has(series.model));
  for (const dayKey of comparison.days) {
    const label = DateTime.fromISO(dayKey, { zone: comparison.timezone }).toLocaleString({
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    });

    output += `## ${label}\n\n`;
    output += '| Model | High | Low | Precip chance | Precip total | Peak wind | Humidity |\n';
    output += '|---|---:|---:|---:|---:|---:|---:|\n';

    const shown: ComparisonDayValues[] = [];
    for (const series of comparison.series) {
      const name = SHORT_NAMES[series.model];
      const values = series.daily[dayKey];

      if (!values) {
        const pastHorizon = comparison.days.indexOf(dayKey) * 24 >= series.horizonHours - 24;
        const reason = pastHorizon ? ` (beyond its ~${series.horizonHours}h reach)` : ' (no data)';
        output += `| ${name}${reason} | — | — | — | — | — | — |\n`;
        continue;
      }

      shown.push(values);
      // NOMADS "chance" is the share of the run's time steps with precipitation, not a probability
      const chanceMark = NOMADS_MODELS.has(series.model) && values.precipitationChancePct !== undefined ? '†' : '';
      output += `| ${name} | ${formatValue(values.temperatureHighF, 0, '°F')} | ${formatValue(values.temperatureLowF, 0, '°F')}` +
        ` | ${formatValue(values.precipitationChancePct, 0, '%')}${chanceMark} | ${formatValue(values.precipitationTotalIn, 2, ' in')}` +
        ` | ${formatValue(values.windMaxMph, 0, ' mph')} | ${formatValue(values.humidityMeanPct, 0, '%')} |\n`;
    }

    // How far apart the models are: a narrow range means a more certain forecast
    if (shown.length >= 2) {
      output += `| **Range** | ${formatRange(shown.map((v) => v.temperatureHighF), 0, '°F')} | ${formatRange(shown.map((v) => v.temperatureLowF), 0, '°F')}` +
        ` | | ${formatRange(shown.map((v) => v.precipitationTotalIn), 2, ' in')} | ${formatRange(shown.map((v) => v.windMaxMph), 0, ' mph')} | |\n`;
    }

    output += '\n';
  }

  if (nomadsShown) {
    output += '† For GFS, NAM and HRRR, "precipitation chance" is the share of the day\'s forecast steps with any precipitation in that single run (so steady light rain shows 100%), not a probability like the other models\' values.\n\n';
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
