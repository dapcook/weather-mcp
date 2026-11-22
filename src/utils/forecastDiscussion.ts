import type { AfdJargonMatch, AfdSection } from '../types/noaa.js';

interface JargonEntry extends AfdJargonMatch {
  pattern: RegExp;
}

/**
 * Curated glossary of common NWS Area Forecast Discussion abbreviations and jargon,
 * written to help novice forecasters understand forecaster reasoning.
 */
export const AFD_JARGON_GLOSSARY: readonly JargonEntry[] = [
  // Thermodynamics & Moisture
  {
    term: 'WAA',
    expansion: 'Warm Air Advection',
    explanation: 'Winds blowing warmer air into the region, which often promotes rising motion, clouds, and warming temperatures.',
    category: 'thermodynamics',
    pattern: /\bWAA\b/,
  },
  {
    term: 'CAA',
    expansion: 'Cold Air Advection',
    explanation: 'Winds bringing colder air into the area (typically behind a cold front), causing temperatures to drop or rise slower.',
    category: 'thermodynamics',
    pattern: /\bCAA\b/,
  },
  {
    term: 'PWAT / PW',
    expansion: 'Precipitable Water',
    explanation: 'Total moisture in a vertical column of air if all vapor condensed to rain; higher values (>1.5 in) signal heavy-rain potential.',
    category: 'thermodynamics',
    pattern: /\bPWATs?\b|\bPW\b/,
  },
  {
    term: 'CAPE',
    expansion: 'Convective Available Potential Energy',
    explanation: 'Fuel available for thunderstorms (in J/kg). Roughly: <500 weak, 1000–2500 moderate, >2500 strong updraft potential.',
    category: 'thermodynamics',
    pattern: /\b(?:ML|SB|MU|DC)?CAPE\b/,
  },
  {
    term: 'CIN',
    expansion: 'Convective Inhibition ("Cap")',
    explanation: 'A warm layer aloft that suppresses thunderstorms. Storms only fire if heating or lifting breaks through the cap.',
    category: 'thermodynamics',
    pattern: /\bCINH?\b/,
  },
  {
    term: 'LCL',
    expansion: 'Lifted Condensation Level',
    explanation: 'The height where rising air cools enough to form cloud bases; lower LCLs mean more low-level moisture.',
    category: 'thermodynamics',
    pattern: /\bLCLs?\b/,
  },
  {
    term: 'Lapse Rates',
    expansion: 'Vertical Temperature Drop Rate',
    explanation: 'How fast temperature drops with height. Steep lapse rates (>7°C/km) make the atmosphere unstable and favor hail/updrafts.',
    category: 'thermodynamics',
    pattern: /\blapse rates?\b/i,
  },
  {
    term: 'Theta-E',
    expansion: 'Equivalent Potential Temperature',
    explanation: 'Combined measure of heat and moisture; ridges of high Theta-E mark warm, humid airmasses feeding storms.',
    category: 'thermodynamics',
    pattern: /\btheta-?e\b/i,
  },
  {
    term: 'Dewpoint / Td',
    expansion: 'Dewpoint Temperature',
    explanation: 'The temperature air must cool to reach 100% humidity. Directly measures real moisture—unlike relative humidity.',
    category: 'thermodynamics',
    pattern: /\b(?:dewpoints?|dew points?|Td)\b/i,
  },

  // Dynamics & Synoptic Features
  {
    term: '500mb / 850mb / 700mb',
    expansion: 'Upper-Air Pressure Levels',
    explanation: 'Weather maps by altitude: 850mb (~5,000 ft) tracks temps/low-level jets; 700mb (~10,000 ft) moisture; 500mb (~18,000 ft) storm steering troughs/ridges.',
    category: 'dynamics',
    pattern: /\b(?:250|300|500|700|850|925)\s*(?:mb|hPa)\b/i,
  },
  {
    term: 'Trough',
    expansion: 'Upper-Level Low-Pressure Dip',
    explanation: 'An elongated dip in the jet stream that pulls air upward, promoting clouds, fronts, and precipitation.',
    category: 'dynamics',
    pattern: /\btroughs?\b/i,
  },
  {
    term: 'Ridge',
    expansion: 'Upper-Level High-Pressure Crest',
    explanation: 'A northward bulge in the jet stream where air sinks and warms, typically bringing calmer, drier weather.',
    category: 'dynamics',
    pattern: /\bridging\b|\bridges?\b/i,
  },
  {
    term: 'Shortwave',
    expansion: 'Small-Scale Upper Disturbance',
    explanation: 'A fast-moving ripple inside the main jet stream that triggers localized rounds of rain or storms.',
    category: 'dynamics',
    pattern: /\bshortwaves?\b/i,
  },
  {
    term: 'Vorticity / PVA',
    expansion: 'Atmospheric Spin / Positive Vorticity Advection',
    explanation: 'Spin in the mid-levels (~500mb); when stronger spin moves overhead (PVA), it forces air to rise and helps storms form.',
    category: 'dynamics',
    pattern: /\b(?:vorticity|vort max|PVA|CVA)\b/i,
  },
  {
    term: 'LLJ',
    expansion: 'Low-Level Jet',
    explanation: 'A fast river of wind ~3,000–5,000 ft above ground (often peaking at night) that pumps warm, moist air into storm systems.',
    category: 'dynamics',
    pattern: /\bLLJ\b|\blow-?level jet\b/i,
  },
  {
    term: 'Frontogenesis',
    expansion: 'Front Strengthening',
    explanation: 'Tightening of temperature contrast along a front, which creates focused bands of heavier rain or snow.',
    category: 'dynamics',
    pattern: /\bfrontogen(?:esis|etic)\b/i,
  },
  {
    term: 'FROPA',
    expansion: 'Frontal Passage',
    explanation: 'The moment a cold or warm front crosses your location, marked by a wind shift and temperature/dewpoint change.',
    category: 'dynamics',
    pattern: /\bFROPA\b/,
  },
  {
    term: 'Dryline',
    expansion: 'Moisture Boundary',
    explanation: 'A sharp boundary separating humid air (east) from desert-dry air (west), frequently acting as a trigger for Plains thunderstorms.',
    category: 'dynamics',
    pattern: /\bdryline\b/i,
  },
  {
    term: 'Zonal Flow',
    expansion: 'West-to-East Jet Stream',
    explanation: 'A relatively flat west-to-east upper wind pattern, usually bringing fast-moving, milder systems without extreme swings.',
    category: 'dynamics',
    pattern: /\bzonal(?: flow)?\b/i,
  },
  {
    term: 'Pressure Gradient',
    expansion: 'Pressure Change Over Distance',
    explanation: 'Tightly packed isobars (steep pressure gradient) produce strong, gusty surface winds.',
    category: 'dynamics',
    pattern: /\bpressure gradient\b/i,
  },

  // Convection & Severe Weather
  {
    term: 'Wind Shear',
    expansion: 'Change in Wind Speed/Direction with Height',
    explanation: 'Helps organize storms so updrafts last longer and can rotate; 0–6 km shear >35–40 kt favors severe storms.',
    category: 'convection',
    pattern: /\b(?:bulk |deep[- ]layer |effective |0-\d\s*km )?shear\b/i,
  },
  {
    term: 'SRH',
    expansion: 'Storm-Relative Helicity',
    explanation: 'Low-level wind turning with height; higher values indicate stronger rotational potential for supercells.',
    category: 'convection',
    pattern: /\b(?:ESRH|SRH)\b/,
  },
  {
    term: 'MCS / QLCS',
    expansion: 'Mesoscale / Quasi-Linear Convective System',
    explanation: 'An organized cluster (MCS) or squall line (QLCS) of thunderstorms that acts as one large system, often bringing gusty winds and heavy rain.',
    category: 'convection',
    pattern: /\b(?:MCS|QLCS)\b/,
  },
  {
    term: 'Outflow Boundary',
    expansion: 'Rain-Cooled Gust Front',
    explanation: 'A mini cold front pushed outward by thunderstorm downdrafts; can kick off new storms when it collides with warm air.',
    category: 'convection',
    pattern: /\boutflow boundar(?:y|ies)\b/i,
  },
  {
    term: 'Meso / Mesoscale',
    expansion: 'Regional Storm Scale (~5–100 miles)',
    explanation: 'Weather features smaller than broad highs/lows, like thunderstorm clusters, sea breezes, or outflow boundaries.',
    category: 'convection',
    pattern: /\bmesoscale\b|\bmesoanalysis\b/i,
  },

  // Models & Forecast Guidance
  {
    term: 'NBM',
    expansion: 'National Blend of Models',
    explanation: 'NOAA’s statistical blend combining dozens of weather models; often used by NWS forecasters as their starting baseline.',
    category: 'models',
    pattern: /\bNBM\b/,
  },
  {
    term: 'ECMWF / Euro',
    expansion: 'European Centre Model',
    explanation: 'High-accuracy global forecast model (9 km) widely trusted for medium-range (3–10 day) storm tracks.',
    category: 'models',
    pattern: /\b(?:ECMWF|Euro)\b/,
  },
  {
    term: 'GFS / GEFS',
    expansion: 'Global Forecast System / Ensemble',
    explanation: 'NOAA’s flagship global model (GFS) and its multi-run uncertainty suite (GEFS) out to 16 days.',
    category: 'models',
    pattern: /\b(?:GFS|GEFS)\b/,
  },
  {
    term: 'NAM',
    expansion: 'North American Mesoscale Model',
    explanation: 'NOAA regional model (~12 km / 3 km nest) out to 84 hours; captures finer terrain and frontal detail than global models.',
    category: 'models',
    pattern: /\bNAM(?:\d{1,2}km)?\b/,
  },
  {
    term: 'HRRR / RAP',
    expansion: 'High-Resolution Rapid Refresh',
    explanation: 'Hourly-updating short-range (18–48h) 3 km NOAA model designed for storm timing, clouds, and boundary-layer details.',
    category: 'models',
    pattern: /\b(?:HRRR|RAP)\b/,
  },
  {
    term: 'HREF / SREF',
    expansion: 'High-Res / Short-Range Ensemble Forecast',
    explanation: 'Collections of short-range models run together to show the range of possible storm locations and rainfall amounts.',
    category: 'models',
    pattern: /\b(?:HREF|SREF|ENS|EPS)\b/,
  },
  {
    term: 'CAMs',
    expansion: 'Convection-Allowing Models',
    explanation: 'Fine-grid (~3 km) models like HRRR and NAM-Nest that directly simulate individual thunderstorm structures.',
    category: 'models',
    pattern: /\bCAMs?\b/,
  },
  {
    term: 'MOS',
    expansion: 'Model Output Statistics',
    explanation: 'Bias-corrected point forecasts derived from historical model performance at specific airport stations.',
    category: 'models',
    pattern: /\bMOS\b/,
  },
  {
    term: 'SPC / WPC',
    expansion: 'Storm / Weather Prediction Center',
    explanation: 'National NWS centers issuing severe storm outlooks (SPC) and heavy rain/winter/surface analyses (WPC).',
    category: 'models',
    pattern: /\b(?:SPC|WPC)\b/,
  },

  // Precipitation & Time
  {
    term: 'QPF',
    expansion: 'Quantitative Precipitation Forecast',
    explanation: 'The forecasted liquid precipitation amount (rainfall or melted snow equivalent), usually in inches.',
    category: 'precipitation',
    pattern: /\bQPF\b/,
  },
  {
    term: 'PoP',
    expansion: 'Probability of Precipitation',
    explanation: 'The chance (%) that at least 0.01 inches of liquid precipitation falls at a given point during the period.',
    category: 'precipitation',
    pattern: /\bPoPs?\b/,
  },
  {
    term: 'SLR',
    expansion: 'Snow-to-Liquid Ratio',
    explanation: 'How fluffy or wet snow is (10:1 is average; 15:1+ is light powder in cold air; <8:1 is heavy wet snow).',
    category: 'precipitation',
    pattern: /\bSLRs?\b/,
  },
  {
    term: 'FZRA / FZDZ',
    expansion: 'Freezing Rain / Freezing Drizzle',
    explanation: 'Liquid rain or drizzle that freezes on contact with sub-32°F surfaces, creating dangerous glaze ice.',
    category: 'precipitation',
    pattern: /\b(?:FZRA|FZDZ)\b/,
  },
  {
    term: 'Zulu (Z / UTC)',
    expansion: 'Coordinated Universal Time',
    explanation: 'Standard meteorological clock (e.g., 12Z = 6 AM CST / 7 AM CDT; 00Z = 6 PM CST / 7 PM CDT).',
    category: 'precipitation',
    pattern: /\b\d{2}Z\b/,
  },

  // Aviation
  {
    term: 'VFR / MVFR / IFR / LIFR',
    expansion: 'Flight Visibility & Ceiling Categories',
    explanation: 'Aviation weather tiers from clear (VFR) to low clouds/fog (MVFR <3,000 ft, IFR <1,000 ft, LIFR <500 ft).',
    category: 'aviation',
    pattern: /\b(?:L?IFR|MVFR|VFR)\b/,
  },
  {
    term: 'TAF / METAR',
    expansion: 'Airport Forecast / Observation',
    explanation: 'TAF is a 24–30 hour airport terminal forecast; METAR is the hourly observed surface weather report.',
    category: 'aviation',
    pattern: /\b(?:TAFs?|METARs?)\b/,
  },
  {
    term: 'LLWS',
    expansion: 'Low-Level Wind Shear',
    explanation: 'Sudden change in wind speed or direction within the lowest 2,000 ft—hazardous during takeoff/landing.',
    category: 'aviation',
    pattern: /\bLLWS\b/,
  },
  {
    term: 'CIG',
    expansion: 'Cloud Ceiling',
    explanation: 'Height above ground of the lowest broken or overcast cloud layer.',
    category: 'aviation',
    pattern: /\bCIGs?\b/,
  },
];

/**
 * Reflow fixed-width (66-column) NWS discussion paragraphs while preserving
 * bulleted lists, timestamps, and blank-line paragraph breaks.
 */
function cleanSectionBody(rawBody: string): string {
  const trimmed = rawBody
    .replace(/\r\n/g, '\n')
    .replace(/\n*&&\s*$/g, '')
    .replace(/\n*\$\$\s*$/g, '')
    .trim();

  if (!trimmed) return '';

  const lines = trimmed.split('\n');
  const out: string[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      out.push(paragraph.join(' '));
      paragraph = [];
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      continue;
    }
    if (/^Issued at /i.test(line)) {
      flushParagraph();
      out.push(`*${line}*`);
      continue;
    }
    if (/^[-*•]\s+/.test(line)) {
      flushParagraph();
      paragraph.push(line);
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();

  return out.join('\n\n');
}

function normalizeSectionId(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function formatSectionTitle(rawTitle: string): string {
  return rawTitle
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

/**
 * Parse raw NWS Area Forecast Discussion product text into office metadata and sections.
 */
export function parseAfdText(rawText: string): {
  officeName: string;
  headlineTime?: string;
  sections: AfdSection[];
} {
  const normalized = rawText.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');

  let officeName = 'National Weather Service';
  let headlineTime: string | undefined;

  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    const line = lines[i].trim();
    if (/^National Weather Service/i.test(line)) {
      officeName = line;
      const next = lines[i + 1]?.trim();
      if (next && !next.startsWith('.')) {
        headlineTime = next;
      }
      break;
    }
  }

  // Sections start with a line matching `.SECTION TITLE...`
  const sectionHeaderRegex = /^\.([A-Z0-9 /&-]+)\.\.\.\s*$/gm;
  const matches: Array<{ title: string; start: number; contentStart: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = sectionHeaderRegex.exec(normalized)) !== null) {
    matches.push({
      title: match[1].trim(),
      start: match.index,
      contentStart: match.index + match[0].length,
    });
  }

  const sections: AfdSection[] = [];
  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    const end = i + 1 < matches.length ? matches[i + 1].start : normalized.length;
    const rawBody = normalized.slice(current.contentStart, end);
    const content = cleanSectionBody(rawBody);
    if (!content) continue;
    sections.push({
      id: normalizeSectionId(current.title),
      title: formatSectionTitle(current.title),
      content,
    });
  }

  return { officeName, headlineTime, sections };
}

/**
 * Find all glossary jargon terms present in a forecast discussion text.
 */
export function extractJargonMatches(text: string): AfdJargonMatch[] {
  const found: AfdJargonMatch[] = [];
  for (const entry of AFD_JARGON_GLOSSARY) {
    if (entry.pattern.test(text)) {
      found.push({
        term: entry.term,
        expansion: entry.expansion,
        explanation: entry.explanation,
        category: entry.category,
      });
    }
  }
  return found;
}
