/**
 * Handler for get_weather_imagery tool
 * Provides weather radar, precipitation imagery, historical radar archive,
 * and radar-estimated precipitation amounts (QPE) across NWS, IEM, and RainViewer.
 */

import {
  WeatherImageryParams,
  WeatherImageryResponse,
  ImageryType,
  RadarSourceId,
  RadarProduct,
  SatelliteProduct,
  PrecipitationAccumulationValues,
} from '../types/imagery.js';
import {
  RADAR_PRODUCTS,
  RadarServiceRegistry,
  radarServiceRegistry,
  buildMcpImageContent,
} from '../services/radar/index.js';
import { validateLatitude, validateLongitude } from '../utils/validation.js';
import { logger, redactCoordinatesForLogging } from '../utils/logger.js';
import { ValidationError } from '../errors/ApiError.js';

const VALID_SOURCES: ReadonlyArray<RadarSourceId | 'auto'> = [
  'auto',
  'nws',
  'iem',
  'rainviewer',
];

const VALID_RADAR_PRODUCTS: ReadonlyArray<RadarProduct> = [
  'base_reflectivity',
  'composite_reflectivity',
  'echo_tops',
  'precip_type',
];

const VALID_SATELLITE_PRODUCTS: ReadonlyArray<SatelliteProduct> = [
  'geocolor',
  'visible',
  'infrared',
  'water_vapor',
  'shortwave_infrared',
];

/**
 * Validate imagery request parameters
 */
function validateImageryParams(params: WeatherImageryParams): {
  source: RadarSourceId | 'auto';
  radarProduct: RadarProduct;
  satelliteProduct: SatelliteProduct;
  animated: boolean;
  frames: number;
  explicitFrames: boolean;
  pastMinutes: number;
  at?: Date;
  includeValues: boolean;
  includeImage: boolean;
} {
  // Validate coordinates
  validateLatitude(params.latitude);
  validateLongitude(params.longitude);

  // Validate imagery type
  const validTypes: ImageryType[] = ['radar', 'satellite', 'precipitation'];
  if (!validTypes.includes(params.type)) {
    throw new ValidationError(
      `Invalid imagery type: ${params.type}. Must be one of: ${validTypes.join(', ')}`,
      'type',
      params.type
    );
  }

  // Validate boolean parameters
  if (params.animated !== undefined && typeof params.animated !== 'boolean') {
    throw new ValidationError('animated parameter must be a boolean', 'animated', params.animated);
  }

  if (params.include_values !== undefined && typeof params.include_values !== 'boolean') {
    throw new ValidationError(
      'include_values parameter must be a boolean',
      'include_values',
      params.include_values
    );
  }

  if (params.include_image !== undefined && typeof params.include_image !== 'boolean') {
    throw new ValidationError(
      'include_image parameter must be a boolean',
      'include_image',
      params.include_image
    );
  }

  // Validate layers array if provided (kept for backwards compatibility and satellite band selection)
  if (params.layers !== undefined) {
    if (!Array.isArray(params.layers)) {
      throw new ValidationError('layers parameter must be an array', 'layers', params.layers);
    }
    if (params.layers.length > 10) {
      throw new ValidationError('Maximum 10 layers allowed', 'layers', params.layers);
    }
  }

  // Validate source
  const source: RadarSourceId | 'auto' = params.source ?? 'auto';
  if (!VALID_SOURCES.includes(source)) {
    throw new ValidationError(
      `Invalid radar source: "${String(params.source)}". Must be one of: ${VALID_SOURCES.join(', ')}`,
      'source',
      params.source
    );
  }

  // Validate product based on imagery type
  let radarProduct: RadarProduct = 'base_reflectivity';
  let satelliteProduct: SatelliteProduct = 'geocolor';

  if (params.type === 'satellite') {
    const requestedSat =
      (params.product as SatelliteProduct | undefined) ??
      (params.layers?.[0] as SatelliteProduct | undefined) ??
      'geocolor';
    if ((VALID_SATELLITE_PRODUCTS as ReadonlyArray<string>).includes(requestedSat)) {
      satelliteProduct = requestedSat as SatelliteProduct;
    } else if (
      params.product !== undefined &&
      !(VALID_RADAR_PRODUCTS as ReadonlyArray<string>).includes(String(params.product))
    ) {
      throw new ValidationError(
        `Invalid satellite product: "${String(params.product)}". Must be one of: ${VALID_SATELLITE_PRODUCTS.join(', ')}`,
        'product',
        params.product
      );
    }
  } else {
    const requestedRadar = (params.product as RadarProduct | undefined) ?? 'base_reflectivity';
    if (!VALID_RADAR_PRODUCTS.includes(requestedRadar)) {
      throw new ValidationError(
        `Invalid radar product: "${String(params.product)}". Must be one of: ${VALID_RADAR_PRODUCTS.join(', ')}`,
        'product',
        params.product
      );
    }
    radarProduct = requestedRadar;
  }

  // Validate frames (1..24)
  let explicitFrames = false;
  let frames = params.animated ? 6 : 1;
  if (params.frames !== undefined) {
    if (
      typeof params.frames !== 'number' ||
      !Number.isInteger(params.frames) ||
      params.frames < 1 ||
      params.frames > 24
    ) {
      throw new ValidationError(
        'frames parameter must be an integer between 1 and 24',
        'frames',
        params.frames
      );
    }
    frames = params.frames;
    explicitFrames = true;
  }

  const animated = params.animated !== undefined ? params.animated : frames > 1;

  // Validate past_minutes (5..180)
  let pastMinutes = 60;
  if (params.past_minutes !== undefined) {
    if (
      typeof params.past_minutes !== 'number' ||
      !Number.isFinite(params.past_minutes) ||
      params.past_minutes < 5 ||
      params.past_minutes > 180
    ) {
      throw new ValidationError(
        'past_minutes parameter must be a number between 5 and 180',
        'past_minutes',
        params.past_minutes
      );
    }
    pastMinutes = Math.round(params.past_minutes);
  }

  // Validate `at` ISO timestamp
  let at: Date | undefined;
  if (params.at !== undefined && params.at !== '') {
    if (typeof params.at !== 'string') {
      throw new ValidationError('at parameter must be an ISO-8601 timestamp string', 'at', params.at);
    }
    const parsed = new Date(params.at);
    if (Number.isNaN(parsed.getTime())) {
      throw new ValidationError(
        `Invalid ISO-8601 timestamp for "at": "${params.at}". Example: "2025-06-12T22:00:00Z"`,
        'at',
        params.at
      );
    }
    at = parsed;
  }

  return {
    source,
    radarProduct,
    satelliteProduct,
    animated,
    frames,
    explicitFrames,
    pastMinutes,
    at,
    includeValues: params.include_values === true,
    includeImage: params.include_image === true,
  };
}

/**
 * Get weather imagery based on type and radar/satellite provider parameters
 */
export async function getWeatherImagery(
  params: WeatherImageryParams,
  registry: RadarServiceRegistry = radarServiceRegistry
): Promise<WeatherImageryResponse> {
  const validated = validateImageryParams(params);
  const { latitude, longitude, type } = params;

  // Redact coordinates for logging to protect user privacy
  const redacted = redactCoordinatesForLogging(latitude, longitude);
  logger.info('Weather imagery requested', {
    latitude: redacted.lat,
    longitude: redacted.lon,
    type,
    source: validated.source,
    product: type === 'satellite' ? validated.satelliteProduct : validated.radarProduct,
    animated: validated.animated,
    frames: validated.frames,
    includeValues: validated.includeValues,
    includeImage: validated.includeImage,
  });

  switch (type) {
    case 'precipitation':
    case 'radar': {
      // When RainViewer is used with animated=true and no explicit `frames` cap,
      // allow up to 24 frames so all ~12 RainViewer frames are returned as before.
      const requestedFrames =
        !validated.explicitFrames && validated.animated && validated.source === 'rainviewer'
          ? 24
          : validated.frames;

      const radarResult = await registry.fetchFrames(validated.source, {
        latitude,
        longitude,
        product: validated.radarProduct,
        animated: validated.animated,
        frames: requestedFrames,
        pastMinutes: validated.pastMinutes,
        at: validated.at,
      });

      let precipitationValues: PrecipitationAccumulationValues | undefined;
      if (validated.includeValues) {
        try {
          precipitationValues = await registry.qpe.getPointAccumulation(latitude, longitude);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          logger.warn('NWS QPE point query failed; returning radar imagery with note', { reason });
          precipitationValues = {
            mm: { h1: null, h3: null, h6: null, h12: null, h24: null, h48: null, h72: null },
            note: `Radar precipitation amounts temporarily unavailable (${reason}).`,
          };
        }
      }

      let imageContent: WeatherImageryResponse['imageContent'];
      if (validated.includeImage && radarResult.frames.length > 0) {
        const latestFrame = radarResult.frames[radarResult.frames.length - 1];
        imageContent = await buildMcpImageContent({
          type,
          frameUrl: latestFrame.url,
          latitude,
          longitude,
          esriBaseUrl: registry.esriBaseUrl,
        });
      }

      const isMultiFrame = validated.animated || radarResult.frames.length > 1;

      return {
        type,
        location: { latitude, longitude },
        coverage: radarResult.coverage,
        resolution: isMultiFrame
          ? `${radarResult.frames.length} frames`
          : 'Latest snapshot',
        source: radarResult.sourceLabel,
        sourceId: radarResult.sourceId,
        product:
          validated.radarProduct !== 'base_reflectivity' || radarResult.sourceId !== 'rainviewer'
            ? radarResult.productLabel || RADAR_PRODUCTS[validated.radarProduct].label
            : undefined,
        attribution: radarResult.attribution,
        fallbackNote: radarResult.fallbackNote,
        precipitationValues,
        imageContent,
        animated: isMultiFrame,
        frames: radarResult.frames,
        generatedAt: new Date(),
        disclaimer: radarResult.disclaimer,
      };
    }

    case 'satellite': {
      const satResult = await registry.satellite.getFrames({
        latitude,
        longitude,
        product: validated.satelliteProduct,
        animated: validated.animated,
        frames: validated.frames,
        pastMinutes: validated.pastMinutes,
      });

      let imageContent: WeatherImageryResponse['imageContent'];
      if (validated.includeImage && satResult.frames.length > 0) {
        const latestFrame = satResult.frames[satResult.frames.length - 1];
        imageContent = await buildMcpImageContent({
          type: 'satellite',
          frameUrl: latestFrame.url,
          latitude,
          longitude,
        });
      }

      const isMultiFrame = validated.animated || satResult.frames.length > 1;

      return {
        type,
        location: { latitude, longitude },
        coverage: satResult.coverage,
        resolution: isMultiFrame
          ? `${satResult.frames.length} frames`
          : 'Latest snapshot',
        source: satResult.sourceLabel,
        product: satResult.productLabel,
        attribution: satResult.attribution,
        imageContent,
        animated: isMultiFrame,
        frames: satResult.frames,
        generatedAt: new Date(),
        disclaimer: satResult.disclaimer,
      };
    }

    default: {
      throw new ValidationError(`Unsupported imagery type: ${String(type)}`, 'type', type);
    }
  }
}

function formatMmAndInches(mm: number | null): string {
  if (mm === null || !Number.isFinite(mm)) {
    return 'N/A';
  }
  const inches = mm / 25.4;
  return `${inches.toFixed(2)} in (${mm.toFixed(1)} mm)`;
}

/**
 * Format weather imagery response for display
 */
export function formatWeatherImageryResponse(response: WeatherImageryResponse): string {
  const lines: string[] = [];

  lines.push('# Weather Imagery');
  lines.push('');
  lines.push(
    `**Location:** ${response.location.latitude.toFixed(4)}, ${response.location.longitude.toFixed(4)}`
  );
  lines.push(`**Type:** ${response.type.charAt(0).toUpperCase() + response.type.slice(1)}`);
  lines.push(`**Coverage:** ${response.coverage}`);

  if (response.resolution) {
    lines.push(`**Resolution:** ${response.resolution}`);
  }

  lines.push(`**Source:** ${response.source}`);
  if (response.product) {
    lines.push(`**Product:** ${response.product}`);
  }
  if (response.attribution) {
    lines.push(`**Attribution:** ${response.attribution}`);
  }
  lines.push(`**Animated:** ${response.animated ? 'Yes' : 'No'}`);
  lines.push('');

  if (response.fallbackNote) {
    lines.push(`> ℹ️ **Note:** ${response.fallbackNote}`);
    lines.push('');
  }

  // Display frames
  if (response.animated && response.frames.length > 1) {
    lines.push(`## 🎬 Animation Frames (${response.frames.length} frames)`);
    lines.push('');

    // Show first, middle, and last frames as inline images when > 5 frames for markdown brevity
    const framesToShow =
      response.frames.length <= 5
        ? response.frames
        : [
            response.frames[0],
            response.frames[Math.floor(response.frames.length / 2)],
            response.frames[response.frames.length - 1],
          ];

    framesToShow.forEach((frame) => {
      const frameNumber = response.frames.indexOf(frame) + 1;
      lines.push(`### Frame ${frameNumber} - ${frame.timestamp.toISOString()}`);
      lines.push(`![${frame.description || 'Weather imagery'}](${frame.url})`);
      lines.push('');
    });

    if (response.frames.length > 5) {
      lines.push(`*Showing 3 of ${response.frames.length} frames for brevity*`);
      lines.push('');
      lines.push(
        '**All frames:** ' +
          response.frames
            .map((f, idx) => `[Frame ${idx + 1} (${f.timestamp.toISOString()})](${f.url})`)
            .join(' · ')
      );
      lines.push('');
    }
  } else if (response.frames.length > 0) {
    lines.push('## 📸 Current Imagery');
    lines.push('');
    const frame = response.frames[0];
    lines.push(`**Timestamp:** ${frame.timestamp.toISOString()}`);
    lines.push(`![${frame.description || 'Weather imagery'}](${frame.url})`);
    lines.push('');
  } else {
    lines.push('## ⚠️ No Imagery Available');
    lines.push('');
    lines.push('No imagery data is currently available for this location and time.');
    lines.push('');
  }

  // Display radar-estimated precipitation amounts (Phase 4: include_values)
  if (response.precipitationValues) {
    const qpe = response.precipitationValues;
    lines.push('## 🌧️ Radar-Estimated Precipitation (NWS MRMS QPE)');
    lines.push('');
    if (qpe.note) {
      lines.push(`*${qpe.note}*`);
      lines.push('');
    } else {
      const rainingNow =
        qpe.mm.h1 !== null && qpe.mm.h1 > 0
          ? `Yes (${formatMmAndInches(qpe.mm.h1)} in the last hour)`
          : 'No measurable precipitation in the last hour';
      lines.push(`**Precipitating Now (1h QPE):** ${rainingNow}`);
      if (qpe.validEndTime) {
        lines.push(`**Valid Through:** ${qpe.validEndTime.toISOString()}`);
      }
      lines.push('');
      lines.push('| Window | Accumulation (in / mm) |');
      lines.push('|---|---|');
      lines.push(`| Last 1 hour | ${formatMmAndInches(qpe.mm.h1)} |`);
      lines.push(`| Last 3 hours | ${formatMmAndInches(qpe.mm.h3)} |`);
      lines.push(`| Last 6 hours | ${formatMmAndInches(qpe.mm.h6)} |`);
      lines.push(`| Last 12 hours | ${formatMmAndInches(qpe.mm.h12)} |`);
      lines.push(`| Last 24 hours | ${formatMmAndInches(qpe.mm.h24)} |`);
      lines.push(`| Last 48 hours | ${formatMmAndInches(qpe.mm.h48)} |`);
      lines.push(`| Last 72 hours | ${formatMmAndInches(qpe.mm.h72)} |`);
      lines.push('');
    }
  }

  // Add disclaimer if present
  if (response.disclaimer) {
    lines.push('---');
    lines.push('');
    lines.push(`⚠️ **DISCLAIMER:** ${response.disclaimer}`);
    lines.push('');
  }

  lines.push('---');
  lines.push(`*Generated: ${response.generatedAt.toISOString()}*`);
  lines.push(`*Data source: ${response.source}*`);

  return lines.join('\n');
}
