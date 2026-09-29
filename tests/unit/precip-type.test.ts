import { describe, it, expect } from 'vitest';
import type { GridpointProperties } from '../../src/types/noaa.js';
import {
  parseValidTime,
  getNoaaPrecipTypes,
  getOpenMeteoPrecipTypes,
  formatPrecipTypes,
} from '../../src/utils/precipType.js';

type Condition = { coverage: string | null; weather: string | null; intensity?: string | null };

function gridpoint(entries: Array<[string, Condition[]]>): GridpointProperties {
  return {
    weather: {
      values: entries.map(([validTime, conditions]) => ({
        validTime,
        value: conditions.map((c) => ({
          coverage: c.coverage,
          weather: c.weather,
          intensity: c.intensity ?? null,
          visibility: null,
          attributes: [],
        })),
      })),
    },
  } as unknown as GridpointProperties;
}

describe('parseValidTime', () => {
  it('parses hour, day and minute durations', () => {
    const start = Date.parse('2026-09-30T08:00:00+00:00');
    expect(parseValidTime('2026-09-30T08:00:00+00:00/PT4H')).toEqual({ start, end: start + 4 * 3600_000 });
    expect(parseValidTime('2026-09-30T08:00:00+00:00/P1DT15H')?.end).toBe(start + 39 * 3600_000);
    expect(parseValidTime('2026-09-30T08:00:00+00:00/PT30M')?.end).toBe(start + 30 * 60_000);
  });

  it('rejects malformed intervals', () => {
    expect(parseValidTime('not-a-date/PT1H')).toBeNull();
    expect(parseValidTime('2026-09-30T08:00:00+00:00')).toBeNull();
    expect(parseValidTime('2026-09-30T08:00:00+00:00/garbage')).toBeNull();
  });
});

describe('getNoaaPrecipTypes', () => {
  const props = gridpoint([
    ['2026-09-30T00:00:00+00:00/PT6H', [{ coverage: 'chance', weather: 'rain_showers' }]],
    ['2026-09-30T06:00:00+00:00/PT6H', [
      { coverage: 'likely', weather: 'rain' },
      { coverage: 'slight_chance', weather: 'thunderstorms' },
      { coverage: 'patchy', weather: 'fog' },
    ]],
    ['2026-09-30T12:00:00+00:00/PT6H', [{ coverage: 'slight_chance', weather: 'freezing_rain' }]],
    ['2026-10-01T00:00:00+00:00/PT12H', [{ coverage: 'definite', weather: 'snow' }]],
  ]);

  it('keeps the highest likelihood per type within the window', () => {
    const result = getNoaaPrecipTypes(props, '2026-09-30T00:00:00Z', '2026-09-30T12:00:00Z');
    expect(result).toEqual([{ type: 'rain', detail: 'likely' }]);
  });

  it('ignores conditions that are not precipitation types', () => {
    const result = getNoaaPrecipTypes(props, '2026-09-30T06:00:00Z', '2026-09-30T12:00:00Z');
    expect(result.map((m) => m.type)).toEqual(['rain']);
  });

  it('orders by likelihood, then hazard, and labels definite as expected', () => {
    const result = getNoaaPrecipTypes(props, '2026-09-30T00:00:00Z', '2026-10-02T00:00:00Z');
    expect(result).toEqual([
      { type: 'snow', detail: 'expected' },
      { type: 'rain', detail: 'likely' },
      { type: 'freezing_rain', detail: 'slight chance' },
    ]);
  });

  it('excludes intervals that only touch the window edges', () => {
    expect(getNoaaPrecipTypes(props, '2026-09-30T18:00:00Z', '2026-10-01T00:00:00Z')).toEqual([]);
  });

  it('handles missing weather data', () => {
    expect(getNoaaPrecipTypes({} as GridpointProperties, '2026-09-30T00:00:00Z', '2026-10-01T00:00:00Z')).toEqual([]);
  });

  it('caps the number of intervals processed', () => {
    const many = gridpoint(Array.from({ length: 10 }, (_, i): [string, Condition[]] => [
      `2026-09-30T${String(i).padStart(2, '0')}:00:00+00:00/PT1H`,
      [{ coverage: 'chance', weather: i < 5 ? 'rain' : 'snow' }],
    ]));
    const result = getNoaaPrecipTypes(many, '2026-09-30T00:00:00Z', '2026-10-01T00:00:00Z', 5);
    expect(result.map((m) => m.type)).toEqual(['rain']);
  });
});

describe('getOpenMeteoPrecipTypes', () => {
  it('reports rain plus showers and snowfall amounts', () => {
    expect(getOpenMeteoPrecipTypes({ rain: 0.1, showers: 0.05, snowfall: 1.37, weatherCode: 73 })).toEqual([
      { type: 'snow', detail: '1.4 in' },
      { type: 'rain', detail: '0.15 in' },
    ]);
  });

  it('labels liquid as freezing rain or freezing drizzle from the weather code', () => {
    expect(getOpenMeteoPrecipTypes({ rain: 0.2, weatherCode: 67 })).toEqual([{ type: 'freezing_rain', detail: '0.20 in' }]);
    expect(getOpenMeteoPrecipTypes({ rain: 0.02, weatherCode: 56 })).toEqual([{ type: 'freezing_drizzle', detail: '0.02 in' }]);
    expect(getOpenMeteoPrecipTypes({ rain: 0.02, weatherCode: 53 })).toEqual([{ type: 'drizzle', detail: '0.02 in' }]);
  });

  it('adds hail for thunderstorm-with-hail codes', () => {
    expect(getOpenMeteoPrecipTypes({ showers: 0.5, weatherCode: 99 })).toEqual([
      { type: 'hail' },
      { type: 'rain', detail: '0.50 in' },
    ]);
  });

  it('ignores trace amounts and dry periods', () => {
    expect(getOpenMeteoPrecipTypes({ rain: 0.004, snowfall: 0.05, weatherCode: 3 })).toEqual([]);
    expect(getOpenMeteoPrecipTypes({})).toEqual([]);
  });
});

describe('formatPrecipTypes', () => {
  it('returns an empty string when nothing is expected', () => {
    expect(formatPrecipTypes([])).toBe('');
  });

  it('formats a single type with its detail', () => {
    expect(formatPrecipTypes([{ type: 'rain', detail: 'likely' }])).toBe('**Precipitation Type:** Rain (likely)\n');
  });

  it('flags a wintry mix and warns about icing', () => {
    const output = formatPrecipTypes([
      { type: 'sleet', detail: 'chance' },
      { type: 'rain', detail: 'likely' },
    ]);
    expect(output).toContain('**Precipitation Type:** Sleet (chance), rain (likely) (wintry mix)');
    expect(output).toContain('⚠️ **Icing Risk:** sleet can glaze roads');
  });

  it('does not call snow alone a mix or an icing risk', () => {
    const output = formatPrecipTypes([{ type: 'snow', detail: '2.0 in' }]);
    expect(output).toBe('**Precipitation Type:** Snow (2.0 in)\n');
  });
});
