/**
 * Handler for get_forecast_discussion tool (NWS Area Forecast Discussion + Novice Jargon Guide)
 */

import { NOAAService } from '../services/noaa.js';
import { validateCoordinates, validateOptionalBoolean } from '../utils/validation.js';
import { extractJargonMatches } from '../utils/forecastDiscussion.js';
import { ValidationError } from '../errors/ApiError.js';

interface ForecastDiscussionArgs {
  latitude?: number;
  longitude?: number;
  section?: string;
  include_jargon_guide?: boolean;
}

const VALID_SECTIONS = [
  'all',
  'key_messages',
  'synopsis',
  'discussion',
  'short_term',
  'long_term',
  'aviation',
] as const;

export async function handleGetForecastDiscussion(
  args: unknown,
  noaaService: NOAAService
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { latitude, longitude } = validateCoordinates(args);
  const rawArgs = (args as ForecastDiscussionArgs) || {};

  const includeJargonGuide = validateOptionalBoolean(
    rawArgs.include_jargon_guide,
    'include_jargon_guide',
    true
  );

  let sectionFilter = 'all';
  if (rawArgs.section !== undefined) {
    if (typeof rawArgs.section !== 'string') {
      throw new ValidationError('section must be a string', 'section', rawArgs.section);
    }
    const normalized = rawArgs.section.trim().toLowerCase();
    if (!VALID_SECTIONS.includes(normalized as (typeof VALID_SECTIONS)[number])) {
      throw new ValidationError(
        `Invalid section "${rawArgs.section}". Must be one of: ${VALID_SECTIONS.join(', ')}`,
        'section',
        rawArgs.section
      );
    }
    sectionFilter = normalized;
  }

  const afd = await noaaService.getForecastDiscussion(latitude, longitude);

  const selectedSections =
    sectionFilter === 'all'
      ? afd.sections
      : afd.sections.filter(
          (s) => s.id === sectionFilter || s.id.includes(sectionFilter)
        );

  const lines: string[] = [];
  lines.push(`# NWS Area Forecast Discussion (${afd.wfo})`);
  lines.push('');
  lines.push(`**Office:** ${afd.officeName} (\`${afd.issuingOffice}\`)`);
  lines.push(`**Issued:** ${afd.headlineTime || afd.issuanceTime}`);
  lines.push(`**Location:** ${latitude.toFixed(4)}, ${longitude.toFixed(4)}`);
  lines.push('');

  if (selectedSections.length === 0) {
    lines.push(
      `No section matching \`${sectionFilter}\` was found in this issuance. Available sections: ${afd.sections.map((s) => s.title).join(', ')}.`
    );
    lines.push('');
  } else {
    for (const sec of selectedSections) {
      lines.push(`## ${sec.title}`);
      lines.push('');
      lines.push(sec.content);
      lines.push('');
    }
  }

  if (includeJargonGuide) {
    const textForGlossary = selectedSections.map((s) => s.content).join('\n\n') || afd.rawText;
    const jargon = extractJargonMatches(textForGlossary);
    if (jargon.length > 0) {
      lines.push('---');
      lines.push('## Novice Forecaster Jargon Guide');
      lines.push('');
      lines.push('*Plain-English explanations for meteorological terms used above:*');
      lines.push('');
      for (const item of jargon) {
        lines.push(`- **${item.term}** (*${item.expansion}*) — ${item.explanation}`);
      }
      lines.push('');
    }
  }

  lines.push('---');
  lines.push(`*Source: NOAA NWS (${afd.issuingOffice}) · Product ID: ${afd.productId}*`);

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}
