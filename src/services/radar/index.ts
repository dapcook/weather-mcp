/**
 * Multi-provider weather radar service (NWS MRMS, IEM NEXRAD archive, RainViewer)
 * and NWS MRMS Quantitative Precipitation Estimate (QPE) point query client.
 */

import axios, { AxiosInstance } from 'axios';
import {
  ImageryFrame,
  PrecipitationAccumulationValues,
  RadarProduct,
  RadarSourceId,
} from '../../types/imagery.js';
import {
  getNwsRadarWorkspace,
  getNwsWorkspaceCoverageLabel,
  isIemRadarCovered,
  isNwsQpeCovered,
  isNwsRadarCovered,
  NwsRadarWorkspace,
  pointWindowMercatorBBox,
} from '../../utils/radarCoverage.js';
import { Cache } from '../../utils/cache.js';
import { CacheConfig } from '../../config/cache.js';
import { logger } from '../../utils/logger.js';
import { getUserAgent } from '../../utils/version.js';
import { ServiceUnavailableError, ValidationError } from '../../errors/ApiError.js';
import { rainViewerService, RainViewerService } from '../rainviewer.js';
import {
  NwsGoesSatelliteService,
  SATELLITE_PRODUCTS,
  getGoesSector,
  parseGoesTimestamp,
  buildMcpImageContent,
} from './satellite.js';

export {
  NwsGoesSatelliteService,
  SATELLITE_PRODUCTS,
  getGoesSector,
  parseGoesTimestamp,
  buildMcpImageContent,
};

export interface RadarProductInfo {
  id: RadarProduct;
  label: string;
  nwsLayerSuffix: string;
  legendSummary: string;
}

export const RADAR_PRODUCTS: Record<RadarProduct, RadarProductInfo> = {
  base_reflectivity: {
    id: 'base_reflectivity',
    label: "Base Reflectivity (QC'd, dBZ)",
    nwsLayerSuffix: 'bref_qcd',
    legendSummary:
      'dBZ radar reflectivity (light rain ~20 dBZ green, moderate ~35 dBZ yellow, heavy/storms ≥45 dBZ orange/red)',
  },
  composite_reflectivity: {
    id: 'composite_reflectivity',
    label: "Composite Reflectivity (QC'd, dBZ)",
    nwsLayerSuffix: 'cref_qcd',
    legendSummary:
      'Maximum dBZ radar reflectivity across all elevation scans (dBZ)',
  },
  echo_tops: {
    id: 'echo_tops',
    label: '18 dBZ Echo Tops (kft)',
    nwsLayerSuffix: 'neet_v18',
    legendSummary:
      'Storm cloud top height in thousands of feet (kft) where reflectivity reaches 18 dBZ',
  },
  precip_type: {
    id: 'precip_type',
    label: 'Surface Precipitation Type',
    nwsLayerSuffix: 'pcpn_typ',
    legendSummary:
      'MRMS surface precipitation classification (rain, snow, freezing rain, convective)',
  },
};

export interface RadarFrameRequest {
  latitude: number;
  longitude: number;
  product: RadarProduct;
  animated: boolean;
  frames: number;
  pastMinutes: number;
  at?: Date;
}

export interface RadarFrameResult {
  sourceId: RadarSourceId;
  sourceLabel: string;
  coverage: string;
  productLabel: string;
  attribution: string;
  disclaimer: string;
  frames: ImageryFrame[];
  fallbackNote?: string;
}

export interface RadarSource {
  readonly id: RadarSourceId;
  readonly label: string;
  readonly attribution: string;
  covers(latitude: number, longitude: number): boolean;
  supportsProduct(product: RadarProduct): boolean;
  getFrames(request: RadarFrameRequest): Promise<RadarFrameResult>;
}

/**
 * Shared WMS helpers for time-dimension parsing, snapping, and EPSG:3857 GetMap URL building
 */
export abstract class WmsRadarSource implements RadarSource {
  abstract readonly id: RadarSourceId;
  abstract readonly label: string;
  abstract readonly attribution: string;

  abstract covers(latitude: number, longitude: number): boolean;
  abstract supportsProduct(product: RadarProduct): boolean;
  abstract getFrames(request: RadarFrameRequest): Promise<RadarFrameResult>;

  /**
   * Select up to `count` evenly spaced timestamps ending at `endIndex` within `windowMs`.
   */
  protected selectEvenlySpacedDates(
    sortedDates: Date[],
    count: number,
    pastMinutes: number,
    targetDate?: Date
  ): Date[] {
    if (sortedDates.length === 0) {
      return [];
    }

    // Find closest frame to targetDate (or latest frame if targetDate not provided)
    let endIdx = sortedDates.length - 1;
    if (targetDate) {
      const targetMs = targetDate.getTime();
      let bestDiff = Infinity;
      for (let i = 0; i < sortedDates.length; i++) {
        const diff = Math.abs(sortedDates[i].getTime() - targetMs);
        if (diff <= bestDiff) {
          bestDiff = diff;
          endIdx = i;
        }
      }
    }

    if (count <= 1) {
      return [sortedDates[endIdx]];
    }

    const endMs = sortedDates[endIdx].getTime();
    const startMs = endMs - pastMinutes * 60 * 1000;
    // Allow 90s tolerance on the start boundary for 2-minute or 5-minute radar steps
    const candidates = sortedDates
      .slice(0, endIdx + 1)
      .filter((d) => d.getTime() >= startMs - 90_000);

    if (candidates.length === 0) {
      return [sortedDates[endIdx]];
    }
    if (candidates.length <= count) {
      return candidates;
    }

    const selected: Date[] = [];
    const seen = new Set<number>();
    for (let i = 0; i < count; i++) {
      const idx = Math.round((i * (candidates.length - 1)) / (count - 1));
      const candidate = candidates[idx];
      if (!seen.has(candidate.getTime())) {
        seen.add(candidate.getTime());
        selected.push(candidate);
      }
    }
    return selected;
  }

  /**
   * Build a validated WMS GetMap URL for a 512x512 EPSG:3857 window around a coordinate
   */
  protected buildWmsGetMapUrl(options: {
    endpointUrl: string;
    version: '1.3.0' | '1.1.1';
    layerName: string;
    latitude: number;
    longitude: number;
    isoTime: string;
    halfSpanMeters?: number;
  }): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(options.layerName)) {
      throw new Error(`Invalid WMS layer name: ${options.layerName}`);
    }
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(options.isoTime)) {
      throw new Error(`Invalid WMS TIME value: ${options.isoTime}`);
    }

    const [minX, minY, maxX, maxY] = pointWindowMercatorBBox(
      options.latitude,
      options.longitude,
      options.halfSpanMeters ?? 250_000
    );

    const crsKey = options.version === '1.3.0' ? 'CRS' : 'SRS';
    const bboxStr = `${minX},${minY},${maxX},${maxY}`;
    const sep = options.endpointUrl.includes('?') ? '&' : '?';

    return (
      `${options.endpointUrl}${sep}SERVICE=WMS&VERSION=${options.version}&REQUEST=GetMap` +
      `&LAYERS=${encodeURIComponent(options.layerName)}&STYLES=` +
      `&FORMAT=image%2Fpng&TRANSPARENT=TRUE` +
      `&${crsKey}=EPSG%3A3857&BBOX=${bboxStr}&WIDTH=512&HEIGHT=512` +
      `&TIME=${encodeURIComponent(options.isoTime)}`
    );
  }
}

/**
 * Parse layer `<Dimension name="time">` or `<Extent name="time">` lists from WMS GetCapabilities XML
 */
export function parseWmsCapabilitiesLayerTimes(xml: string): Map<string, Date[]> {
  const result = new Map<string, Date[]>();
  const layerBlockRegex = /<Layer\b[^>]*>([\s\S]*?)<\/Layer>/g;
  let match: RegExpExecArray | null;

  while ((match = layerBlockRegex.exec(xml)) !== null) {
    const block = match[1];
    const nameMatch = block.match(/<Name>\s*([a-zA-Z0-9_:-]+)\s*<\/Name>/);
    if (!nameMatch) {
      continue;
    }
    const layerName = nameMatch[1];

    const dimMatch =
      block.match(/<Dimension\b[^>]*name=["']time["'][^>]*>([\s\S]*?)<\/Dimension>/i) ??
      block.match(/<Extent\b[^>]*name=["']time["'][^>]*>([\s\S]*?)<\/Extent>/i);
    if (!dimMatch) {
      continue;
    }

    const rawList = dimMatch[1].trim();
    if (!rawList || rawList.includes('/')) {
      // Interval syntax (e.g. 2011-02-16/2026-12-31/PT5M) is handled procedurally by IEM
      continue;
    }

    const dates: Date[] = [];
    for (const token of rawList.split(',')) {
      const trimmed = token.trim();
      if (!trimmed) continue;
      const d = new Date(trimmed);
      if (!Number.isNaN(d.getTime())) {
        dates.push(d);
      }
    }

    if (dates.length > 0) {
      dates.sort((a, b) => a.getTime() - b.getTime());
      result.set(layerName, dates);
    }
  }

  return result;
}

const ALLOWED_NWS_WORKSPACES: ReadonlySet<NwsRadarWorkspace> = new Set([
  'conus',
  'alaska',
  'hawaii',
  'carib',
  'guam',
]);

/**
 * NOAA/NWS Multi-Radar Multi-Sensor (MRMS) WMS provider via opengeo.ncep.noaa.gov
 */
export class NwsRadarSource extends WmsRadarSource {
  readonly id = 'nws' as const;
  readonly label = 'NOAA/NWS MRMS Radar';
  readonly attribution =
    'NOAA/NWS Multi-Radar Multi-Sensor (MRMS) via NCEP GeoServer (Public Domain)';

  private readonly client: AxiosInstance;
  private readonly baseUrl: string;
  private readonly capabilitiesCache: Cache<Map<string, Date[]>>;

  constructor(options?: { baseURL?: string; timeout?: number }) {
    super();
    this.baseUrl = (options?.baseURL ?? 'https://opengeo.ncep.noaa.gov/geoserver').replace(
      /\/+$/,
      ''
    );
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: options?.timeout ?? 10000,
      headers: {
        'User-Agent': getUserAgent(),
      },
    });
    this.capabilitiesCache = new Cache<Map<string, Date[]>>(32);
  }

  clearCache(): void {
    this.capabilitiesCache.clear();
  }

  covers(latitude: number, longitude: number): boolean {
    return isNwsRadarCovered(latitude, longitude);
  }

  supportsProduct(product: RadarProduct): boolean {
    return Object.prototype.hasOwnProperty.call(RADAR_PRODUCTS, product);
  }

  private async getWorkspaceCapabilities(
    workspace: NwsRadarWorkspace
  ): Promise<Map<string, Date[]>> {
    if (!ALLOWED_NWS_WORKSPACES.has(workspace)) {
      throw new ValidationError(`Unsupported NWS radar workspace: ${workspace}`, 'source', workspace);
    }

    const cacheKey = `nws-wms-caps:${workspace}`;
    if (CacheConfig.enabled) {
      const cached = this.capabilitiesCache.get(cacheKey);
      if (cached) {
        return cached;
      }
    }

    try {
      const response = await this.client.get<string>(
        `/${workspace}/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetCapabilities`,
        { responseType: 'text' }
      );
      const parsed = parseWmsCapabilitiesLayerTimes(
        typeof response.data === 'string' ? response.data : String(response.data)
      );
      if (parsed.size === 0) {
        throw new ServiceUnavailableError(
          'NOAA',
          `NWS GeoServer (${workspace}) returned no radar time dimensions`
        );
      }
      if (CacheConfig.enabled) {
        this.capabilitiesCache.set(cacheKey, parsed, CacheConfig.ttl.weatherImagery);
      }
      return parsed;
    } catch (error) {
      if (error instanceof ServiceUnavailableError) {
        throw error;
      }
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('Failed to fetch NWS GeoServer capabilities', error as Error, { workspace });
      throw new ServiceUnavailableError(
        'NOAA',
        `NWS radar capabilities unavailable (${workspace}): ${msg}`
      );
    }
  }

  async getFrames(request: RadarFrameRequest): Promise<RadarFrameResult> {
    const workspace = getNwsRadarWorkspace(request.latitude, request.longitude);
    if (!workspace) {
      throw new ValidationError(
        'NWS radar only covers the United States and its territories (CONUS, Alaska, Hawaii, Puerto Rico/USVI, Guam). Use source="rainviewer" or source="auto" for international locations.',
        'source',
        'nws'
      );
    }

    const productInfo = RADAR_PRODUCTS[request.product];
    const layerName = `${workspace}_${productInfo.nwsLayerSuffix}`;
    const caps = await this.getWorkspaceCapabilities(workspace);
    const availableDates = caps.get(layerName) ?? [];

    if (availableDates.length === 0) {
      throw new ServiceUnavailableError(
        'NOAA',
        `No timestamps available for NWS radar layer ${layerName}`
      );
    }

    if (request.at) {
      const earliestMs = availableDates[0].getTime();
      const latestMs = availableDates[availableDates.length - 1].getTime();
      const targetMs = request.at.getTime();
      // Allow 10 minutes tolerance outside the ~2-hour NWS GeoServer rolling window
      if (targetMs < earliestMs - 10 * 60_000) {
        throw new ValidationError(
          `NWS GeoServer only retains the last ~2 hours of radar frames (earliest available: ${availableDates[0].toISOString()}). Use source="iem" or source="auto" for historical US radar back to 2011-02-16.`,
          'at',
          request.at.toISOString()
        );
      }
      if (targetMs > latestMs + 10 * 60_000) {
        throw new ValidationError(
          `Requested radar time (${request.at.toISOString()}) is in the future beyond the latest NWS scan (${availableDates[availableDates.length - 1].toISOString()}).`,
          'at',
          request.at.toISOString()
        );
      }
    }

    const selectedDates = this.selectEvenlySpacedDates(
      availableDates,
      request.frames,
      request.pastMinutes,
      request.at
    );

    const endpointUrl = `${this.baseUrl}/${workspace}/wms`;
    const frames: ImageryFrame[] = selectedDates.map((date) => {
      const isoTime = date.toISOString();
      return {
        url: this.buildWmsGetMapUrl({
          endpointUrl,
          version: '1.3.0',
          layerName,
          latitude: request.latitude,
          longitude: request.longitude,
          isoTime,
        }),
        timestamp: date,
        description: `NWS ${productInfo.label} at ${isoTime}`,
      };
    });

    return {
      sourceId: this.id,
      sourceLabel: this.label,
      coverage: getNwsWorkspaceCoverageLabel(workspace),
      productLabel: `${productInfo.label} — ${productInfo.legendSummary}`,
      attribution: this.attribution,
      disclaimer:
        'NOAA/NWS MRMS radar updates every 2 minutes. Always consult official NWS warnings and forecasts for safety decisions.',
      frames,
    };
  }
}

/**
 * Iowa Environmental Mesonet (IEM) NEXRAD N0Q WMS-T provider (2011-02-16 to present, 5-min steps)
 */
export class IemRadarSource extends WmsRadarSource {
  readonly id = 'iem' as const;
  readonly label = 'Iowa Environmental Mesonet (IEM NEXRAD)';
  readonly attribution =
    'Iowa Environmental Mesonet (IEM), Iowa State University — NEXRAD N0Q Base Reflectivity Composite';

  static readonly ARCHIVE_START = new Date('2011-02-16T00:00:00Z');
  static readonly STEP_MS = 5 * 60 * 1000;

  private readonly endpointUrl: string;

  constructor(options?: { endpointUrl?: string }) {
    super();
    this.endpointUrl =
      options?.endpointUrl ?? 'https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q-t.cgi';
  }

  covers(latitude: number, longitude: number): boolean {
    return isIemRadarCovered(latitude, longitude);
  }

  supportsProduct(product: RadarProduct): boolean {
    return product === 'base_reflectivity';
  }

  /**
   * Snap timestamp down to the nearest 5-minute UTC boundary
   */
  static snapToFiveMinutes(date: Date): Date {
    const snappedMs = Math.floor(date.getTime() / IemRadarSource.STEP_MS) * IemRadarSource.STEP_MS;
    return new Date(snappedMs);
  }

  async getFrames(request: RadarFrameRequest): Promise<RadarFrameResult> {
    if (!this.covers(request.latitude, request.longitude)) {
      throw new ValidationError(
        'IEM NEXRAD radar only covers the United States (CONUS, Alaska, Hawaii, and Puerto Rico/USVI).',
        'source',
        'iem'
      );
    }

    if (!this.supportsProduct(request.product)) {
      throw new ValidationError(
        `IEM WMS-T archive only supports product="base_reflectivity" (requested "${request.product}"). Use source="nws" for ${request.product}.`,
        'product',
        request.product
      );
    }

    const now = new Date();
    const targetEnd = request.at ?? now;

    if (targetEnd.getTime() < IemRadarSource.ARCHIVE_START.getTime()) {
      throw new ValidationError(
        `IEM N0Q high-resolution radar archive starts on 2011-02-16T00:00:00Z (requested ${targetEnd.toISOString()}).`,
        'at',
        targetEnd.toISOString()
      );
    }

    if (targetEnd.getTime() > now.getTime() + IemRadarSource.STEP_MS) {
      throw new ValidationError(
        `Requested radar timestamp (${targetEnd.toISOString()}) cannot be in the future.`,
        'at',
        targetEnd.toISOString()
      );
    }

    const snappedEnd = IemRadarSource.snapToFiveMinutes(targetEnd);
    const totalSteps = Math.max(0, Math.floor(request.pastMinutes / 5));
    const candidateDates: Date[] = [];

    for (let i = totalSteps; i >= 0; i--) {
      const frameMs = snappedEnd.getTime() - i * IemRadarSource.STEP_MS;
      if (frameMs >= IemRadarSource.ARCHIVE_START.getTime()) {
        candidateDates.push(new Date(frameMs));
      }
    }

    const selectedDates = this.selectEvenlySpacedDates(
      candidateDates,
      request.frames,
      request.pastMinutes,
      snappedEnd
    );

    const productInfo = RADAR_PRODUCTS.base_reflectivity;
    const workspace = getNwsRadarWorkspace(request.latitude, request.longitude);
    const coverageLabel = workspace
      ? `${getNwsWorkspaceCoverageLabel(workspace)} (IEM NEXRAD Archive)`
      : 'United States (IEM NEXRAD Archive)';

    const frames: ImageryFrame[] = selectedDates.map((date) => {
      // IEM expects ISO-8601 UTC without milliseconds: YYYY-MM-DDTHH:MM:SSZ
      const isoNoMs = date.toISOString().replace(/\.\d{3}Z$/, 'Z');
      return {
        url: this.buildWmsGetMapUrl({
          endpointUrl: this.endpointUrl,
          version: '1.1.1',
          layerName: 'nexrad-n0q-wmst',
          latitude: request.latitude,
          longitude: request.longitude,
          isoTime: isoNoMs,
        }),
        timestamp: date,
        description: `IEM NEXRAD Base Reflectivity at ${isoNoMs}`,
      };
    });

    return {
      sourceId: this.id,
      sourceLabel: this.label,
      coverage: coverageLabel,
      productLabel: `${productInfo.label} — ${productInfo.legendSummary}`,
      attribution: this.attribution,
      disclaimer:
        'IEM composite radar is generated by the Iowa Environmental Mesonet (Iowa State University) from NEXRAD Level III data and is not an official NOAA/NWS product.',
      frames,
    };
  }
}

/**
 * Global fallback radar provider backed by RainViewer
 */
export class RainViewerRadarSource implements RadarSource {
  readonly id = 'rainviewer' as const;
  readonly label = 'RainViewer';
  readonly attribution = 'RainViewer Global Precipitation Radar (https://www.rainviewer.com)';

  private readonly service: RainViewerService;

  constructor(service: RainViewerService = rainViewerService) {
    this.service = service;
  }

  covers(_latitude: number, _longitude: number): boolean {
    return true;
  }

  supportsProduct(product: RadarProduct): boolean {
    return product === 'base_reflectivity';
  }

  async getFrames(request: RadarFrameRequest): Promise<RadarFrameResult> {
    if (!this.supportsProduct(request.product)) {
      throw new ValidationError(
        `RainViewer only provides base precipitation reflectivity (requested product="${request.product}"). Use source="nws" in the United States for ${request.product}.`,
        'product',
        request.product
      );
    }

    if (request.at) {
      const ageMinutes = (Date.now() - request.at.getTime()) / 60_000;
      if (ageMinutes > 130 || ageMinutes < -10) {
        throw new ValidationError(
          'RainViewer only provides the last ~2 hours of radar frames. For historical US radar back to 2011-02-16, use source="iem" or source="auto".',
          'at',
          request.at.toISOString()
        );
      }
    }

    const wantMultiple = request.animated || request.frames > 1;
    const rawFrames = await this.service.getPrecipitationRadar(
      request.latitude,
      request.longitude,
      wantMultiple
    );

    let selectedFrames = rawFrames;
    if (wantMultiple && rawFrames.length > request.frames && request.frames > 0) {
      // If caller explicitly specified a custom frame count or pastMinutes window, filter/downsample
      const endFrame = rawFrames[rawFrames.length - 1];
      const cutoffMs = endFrame.timestamp.getTime() - request.pastMinutes * 60_000;
      const inWindow = rawFrames.filter((f) => f.timestamp.getTime() >= cutoffMs - 90_000);
      const pool = inWindow.length > 0 ? inWindow : rawFrames;

      if (pool.length <= request.frames) {
        selectedFrames = pool;
      } else {
        const picked: ImageryFrame[] = [];
        for (let i = 0; i < request.frames; i++) {
          const idx = Math.round((i * (pool.length - 1)) / (request.frames - 1));
          picked.push(pool[idx]);
        }
        selectedFrames = picked;
      }
    } else if (!wantMultiple && rawFrames.length > 1) {
      selectedFrames = [rawFrames[rawFrames.length - 1]];
    }

    return {
      sourceId: this.id,
      sourceLabel: this.label,
      coverage: 'Global',
      productLabel: 'Precipitation Reflectivity',
      attribution: this.attribution,
      disclaimer:
        'RainViewer provides global precipitation radar. Data may have 5-10 minute delay. For official forecasts, consult local meteorological services.',
      frames: selectedFrames,
    };
  }
}

interface QpeIdentifyResponse {
  properties?: {
    Values?: string[];
  };
  catalogItems?: {
    features?: Array<{
      attributes?: {
        name?: string;
        idp_subset?: string;
        idp_validendtime?: number;
      };
    }>;
  };
}

/**
 * Client for NWS Multi-Radar Multi-Sensor (MRMS) Quantitative Precipitation Estimate (QPE)
 * point queries via ArcGIS ImageServer `/identify`.
 *
 * Verified in Phase 0: raw pixel `properties.Values` are in millimetres (mm).
 */
export class NwsQpeService {
  private readonly client: AxiosInstance;
  private readonly cache: Cache<PrecipitationAccumulationValues>;

  constructor(options?: { baseURL?: string; timeout?: number }) {
    const baseURL =
      options?.baseURL ??
      'https://mapservices.weather.noaa.gov/raster/rest/services/obs/mrms_qpe/ImageServer';
    this.client = axios.create({
      baseURL,
      timeout: options?.timeout ?? 10000,
      headers: {
        'User-Agent': getUserAgent(),
      },
    });
    this.cache = new Cache<PrecipitationAccumulationValues>(128);
  }

  clearCache(): void {
    this.cache.clear();
  }

  async getPointAccumulation(
    latitude: number,
    longitude: number
  ): Promise<PrecipitationAccumulationValues> {
    if (!isNwsQpeCovered(latitude, longitude)) {
      return {
        mm: { h1: null, h3: null, h6: null, h12: null, h24: null, h48: null, h72: null },
        note: 'Radar-estimated precipitation accumulation (NWS MRMS QPE) is only available for the United States (CONUS, Alaska, Hawaii, and Puerto Rico/USVI).',
      };
    }

    const cacheKey = Cache.generateKey(
      'nws-qpe',
      Math.round(latitude * 100) / 100,
      Math.round(longitude * 100) / 100
    );
    if (CacheConfig.enabled) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return cached;
      }
    }

    const geometryJson = JSON.stringify({
      x: longitude,
      y: latitude,
      spatialReference: { wkid: 4326 },
    });

    const response = await this.client.get<QpeIdentifyResponse>('/identify', {
      params: {
        geometry: geometryJson,
        geometryType: 'esriGeometryPoint',
        returnGeometry: false,
        returnCatalogItems: true,
        f: 'json',
      },
    });

    const features = response.data?.catalogItems?.features ?? [];
    const rawValues = response.data?.properties?.Values ?? [];

    const mm: PrecipitationAccumulationValues['mm'] = {
      h1: null,
      h3: null,
      h6: null,
      h12: null,
      h24: null,
      h48: null,
      h72: null,
    };

    let validEndTime: Date | undefined;
    let subsetPrefix: string | undefined;

    for (let i = 0; i < features.length; i++) {
      const attrs = features[i]?.attributes;
      const subset = attrs?.idp_subset ?? attrs?.name ?? '';
      const rawVal = rawValues[i];
      const parsedVal = rawVal !== undefined && rawVal !== 'NoData' ? Number.parseFloat(rawVal) : NaN;
      const valueMm = Number.isFinite(parsedVal) && parsedVal >= 0 ? parsedVal : null;

      if (attrs?.idp_validendtime && !validEndTime) {
        const dt = new Date(attrs.idp_validendtime);
        if (!Number.isNaN(dt.getTime())) {
          validEndTime = dt;
        }
      }

      const prefixMatch = subset.match(/^([a-z]+)_QPE_(\d{2})H$/i);
      if (prefixMatch) {
        subsetPrefix = prefixMatch[1].toLowerCase();
        const hoursCode = prefixMatch[2];
        switch (hoursCode) {
          case '01':
            mm.h1 = valueMm;
            break;
          case '03':
            mm.h3 = valueMm;
            break;
          case '06':
            mm.h6 = valueMm;
            break;
          case '12':
            mm.h12 = valueMm;
            break;
          case '24':
            mm.h24 = valueMm;
            break;
          case '48':
            mm.h48 = valueMm;
            break;
          case '72':
            mm.h72 = valueMm;
            break;
        }
      }
    }

    const result: PrecipitationAccumulationValues = {
      validEndTime,
      subsetPrefix,
      mm,
    };

    if (CacheConfig.enabled) {
      this.cache.set(cacheKey, result, CacheConfig.ttl.weatherImagery);
    }

    return result;
  }
}

/**
 * Orchestrates provider selection (`source: 'auto' | 'nws' | 'iem' | 'rainviewer'`)
 * and automatic fallback when an upstream radar service is unreachable.
 */
export class RadarServiceRegistry {
  readonly nws: NwsRadarSource;
  readonly iem: IemRadarSource;
  readonly rainviewer: RainViewerRadarSource;
  readonly qpe: NwsQpeService;
  readonly satellite: NwsGoesSatelliteService;
  readonly esriBaseUrl?: string;

  constructor(options?: {
    nws?: NwsRadarSource;
    iem?: IemRadarSource;
    rainviewer?: RainViewerRadarSource;
    qpe?: NwsQpeService;
    satellite?: NwsGoesSatelliteService;
    esriBaseUrl?: string;
  }) {
    this.nws = options?.nws ?? new NwsRadarSource();
    this.iem = options?.iem ?? new IemRadarSource();
    this.rainviewer = options?.rainviewer ?? new RainViewerRadarSource();
    this.qpe = options?.qpe ?? new NwsQpeService();
    this.satellite = options?.satellite ?? new NwsGoesSatelliteService();
    this.esriBaseUrl = options?.esriBaseUrl;
  }

  getSource(id: RadarSourceId): RadarSource {
    switch (id) {
      case 'nws':
        return this.nws;
      case 'iem':
        return this.iem;
      case 'rainviewer':
        return this.rainviewer;
    }
  }

  async fetchFrames(
    source: RadarSourceId | 'auto',
    request: RadarFrameRequest
  ): Promise<RadarFrameResult> {
    if (source !== 'auto') {
      const provider = this.getSource(source);
      return provider.getFrames(request);
    }

    // Automatic routing
    const inNws = this.nws.covers(request.latitude, request.longitude);
    const inIem = this.iem.covers(request.latitude, request.longitude);

    // 1. Historical request (`at` older than ~110 minutes)
    if (request.at) {
      const ageMinutes = (Date.now() - request.at.getTime()) / 60_000;
      if (ageMinutes > 110) {
        if (!inIem) {
          throw new ValidationError(
            'Historical radar archive (`at` more than 2 hours ago) is only available for the United States via IEM (CONUS, Alaska, Hawaii, Puerto Rico/USVI).',
            'at',
            request.at.toISOString()
          );
        }
        return this.iem.getFrames(request);
      }
    }

    // 2. Non-default radar product (composite_reflectivity, echo_tops, precip_type)
    if (request.product !== 'base_reflectivity') {
      if (!inNws) {
        throw new ValidationError(
          `Radar product "${request.product}" is only available within NOAA/NWS United States coverage.`,
          'product',
          request.product
        );
      }
      return this.nws.getFrames(request);
    }

    // 3. US location: try NWS -> IEM -> RainViewer
    if (inNws) {
      const failures: string[] = [];
      try {
        return await this.nws.getFrames(request);
      } catch (err) {
        if (err instanceof ValidationError) {
          throw err;
        }
        const reason = err instanceof Error ? err.message : String(err);
        failures.push(`NWS (${reason})`);
        logger.warn('NWS radar failed in auto mode, falling back', { reason });
      }

      if (inIem) {
        try {
          const iemResult = await this.iem.getFrames(request);
          return {
            ...iemResult,
            fallbackNote: `Fell back to ${iemResult.sourceLabel} because ${failures.join('; ')} was unavailable.`,
          };
        } catch (err) {
          if (err instanceof ValidationError) {
            throw err;
          }
          const reason = err instanceof Error ? err.message : String(err);
          failures.push(`IEM (${reason})`);
          logger.warn('IEM radar failed in auto mode, falling back to RainViewer', { reason });
        }
      }

      const rvResult = await this.rainviewer.getFrames(request);
      return {
        ...rvResult,
        fallbackNote: `Fell back to ${rvResult.sourceLabel} because ${failures.join(', ')} failed.`,
      };
    }

    // 4. Outside US: use RainViewer
    return this.rainviewer.getFrames(request);
  }
}

export const radarServiceRegistry = new RadarServiceRegistry();
