/**
 * NOAA NESDIS STAR GOES-East (GOES-19) and GOES-West (GOES-18) Satellite Imagery Service
 * plus MCP image content builder (`include_image: true`) for radar and satellite imagery.
 */

import axios, { AxiosInstance } from 'axios';
import { Cache } from '../../utils/cache.js';
import { CacheConfig } from '../../config/cache.js';
import { getUserAgent } from '../../utils/version.js';
import { logger } from '../../utils/logger.js';
import { ValidationError } from '../../errors/ApiError.js';
import { pointWindowMercatorBBox } from '../../utils/radarCoverage.js';
import { compositeRadarPng } from '../../utils/pngComposite.js';
import { ImageryFrame, SatelliteProduct } from '../../types/imagery.js';

export interface SatelliteProductMetadata {
  id: SatelliteProduct;
  bandCode: string;
  label: string;
  legendSummary: string;
}

export const SATELLITE_PRODUCTS: Record<SatelliteProduct, SatelliteProductMetadata> = {
  geocolor: {
    id: 'geocolor',
    bandCode: 'GEOCOLOR',
    label: 'GeoColor (True Color Day / Multispectral IR Night)',
    legendSummary:
      'Daytime true color clouds, smoke, dust, and snow; nighttime multispectral low/high cloud composite',
  },
  visible: {
    id: 'visible',
    bandCode: '02',
    label: 'Red Visible (ABI Band 2, 0.64 µm)',
    legendSummary:
      'High-resolution daytime cloud, fog, and convective detail (dark at night — use geocolor or infrared at night)',
  },
  infrared: {
    id: 'infrared',
    bandCode: '13',
    label: 'Clean Longwave Infrared Window (ABI Band 13, 10.3 µm)',
    legendSummary:
      'Cloud-top brightness temperature day and night (cold convective anvil tops in bright colors)',
  },
  water_vapor: {
    id: 'water_vapor',
    bandCode: '09',
    label: 'Mid-Level Tropospheric Water Vapor (ABI Band 9, 6.9 µm)',
    legendSummary:
      'Mid-level moisture, jet streaks, upper-level lows, troughs, and dry intrusions',
  },
  shortwave_infrared: {
    id: 'shortwave_infrared',
    bandCode: '07',
    label: 'Shortwave Infrared Window (ABI Band 7, 3.9 µm)',
    legendSummary: 'Nighttime fog/low stratus discrimination and wildfire hot-spot detection',
  },
};

export interface GoesSectorInfo {
  satellite: 'GOES19' | 'GOES18';
  sectorPath: string;
  sectorCode: string;
  imageSize: string;
  coverageLabel: string;
}

/**
 * Determine the optimal NOAA NESDIS GOES-19 (East) or GOES-18 (West) sector
 * for a given latitude and longitude.
 * Returns `null` for locations outside GOES Western Hemisphere / Pacific coverage.
 */
export function getGoesSector(latitude: number, longitude: number): GoesSectorInfo | null {
  // 1. Alaska (50°N..73°N, 180°W..129°W or 170°E..180°E)
  if (
    latitude >= 50 &&
    latitude <= 73 &&
    ((longitude >= -180 && longitude <= -129) || (longitude >= 170 && longitude <= 180))
  ) {
    return {
      satellite: 'GOES18',
      sectorPath: 'SECTOR/ak',
      sectorCode: 'ak',
      imageSize: '1000x1000',
      coverageLabel: 'Alaska (NOAA GOES-18 West)',
    };
  }

  // 2. Hawaii (15°N..29°N, 165°W..150°W)
  if (latitude >= 15 && latitude <= 29 && longitude >= -165 && longitude <= -150) {
    return {
      satellite: 'GOES18',
      sectorPath: 'SECTOR/hi',
      sectorCode: 'hi',
      imageSize: '1200x1200',
      coverageLabel: 'Hawaii (NOAA GOES-18 West)',
    };
  }

  // 3. Puerto Rico, US Virgin Islands & Caribbean (10°N..24°N, 85°W..58°W)
  if (latitude >= 10 && latitude <= 24 && longitude >= -85 && longitude <= -58) {
    return {
      satellite: 'GOES19',
      sectorPath: 'SECTOR/pr',
      sectorCode: 'pr',
      imageSize: '1200x1200',
      coverageLabel: 'Puerto Rico & Caribbean (NOAA GOES-19 East)',
    };
  }

  // 4. Guam, CNMI & Western Pacific (5°N..25°N, 135°E..175°E)
  if (latitude >= 5 && latitude <= 25 && longitude >= 135 && longitude <= 175) {
    return {
      satellite: 'GOES18',
      sectorPath: 'SECTOR/tpw',
      sectorCode: 'tpw',
      imageSize: '900x540',
      coverageLabel: 'Tropical Pacific West / Guam (NOAA GOES-18 West)',
    };
  }

  // 5. CONUS Regional Sectors (24°N..51°N, 126°W..65°W)
  if (latitude >= 24 && latitude <= 51 && longitude >= -126 && longitude <= -65) {
    if (latitude < 30 && longitude >= -98 && longitude <= -81) {
      return {
        satellite: 'GOES19',
        sectorPath: 'SECTOR/ga',
        sectorCode: 'ga',
        imageSize: '1000x1000',
        coverageLabel: 'Gulf Coast (NOAA GOES-19 East)',
      };
    }

    if (longitude < -114) {
      if (latitude >= 40) {
        return {
          satellite: 'GOES18',
          sectorPath: 'SECTOR/pnw',
          sectorCode: 'pnw',
          imageSize: '1200x1200',
          coverageLabel: 'Pacific Northwest (NOAA GOES-18 West)',
        };
      }
      return {
        satellite: 'GOES18',
        sectorPath: 'SECTOR/psw',
        sectorCode: 'psw',
        imageSize: '1200x1200',
        coverageLabel: 'Pacific Southwest (NOAA GOES-18 West)',
      };
    }

    if (longitude < -102) {
      if (latitude >= 40) {
        return {
          satellite: 'GOES19',
          sectorPath: 'SECTOR/nr',
          sectorCode: 'nr',
          imageSize: '1200x1200',
          coverageLabel: 'Northern Rockies (NOAA GOES-19 East)',
        };
      }
      return {
        satellite: 'GOES19',
        sectorPath: 'SECTOR/sr',
        sectorCode: 'sr',
        imageSize: '1200x1200',
        coverageLabel: 'Southern Rockies (NOAA GOES-19 East)',
      };
    }

    if (longitude < -88) {
      if (latitude >= 38) {
        return {
          satellite: 'GOES19',
          sectorPath: 'SECTOR/umv',
          sectorCode: 'umv',
          imageSize: '1200x1200',
          coverageLabel: 'Upper Mississippi Valley (NOAA GOES-19 East)',
        };
      }
      if (longitude < -93 && latitude >= 29) {
        return {
          satellite: 'GOES19',
          sectorPath: 'SECTOR/sp',
          sectorCode: 'sp',
          imageSize: '1200x1200',
          coverageLabel: 'Southern Plains (NOAA GOES-19 East)',
        };
      }
      if (latitude >= 29) {
        return {
          satellite: 'GOES19',
          sectorPath: 'SECTOR/smv',
          sectorCode: 'smv',
          imageSize: '1200x1200',
          coverageLabel: 'Southern Mississippi Valley (NOAA GOES-19 East)',
        };
      }
      return {
        satellite: 'GOES19',
        sectorPath: 'SECTOR/ga',
        sectorCode: 'ga',
        imageSize: '1000x1000',
        coverageLabel: 'Gulf Coast (NOAA GOES-19 East)',
      };
    }

    if (longitude < -77) {
      if (latitude >= 38) {
        return {
          satellite: 'GOES19',
          sectorPath: 'SECTOR/cgl',
          sectorCode: 'cgl',
          imageSize: '1200x1200',
          coverageLabel: 'Central Great Lakes (NOAA GOES-19 East)',
        };
      }
      return {
        satellite: 'GOES19',
        sectorPath: 'SECTOR/se',
        sectorCode: 'se',
        imageSize: '1200x1200',
        coverageLabel: 'Southeast US (NOAA GOES-19 East)',
      };
    }

    if (latitude >= 37) {
      return {
        satellite: 'GOES19',
        sectorPath: 'SECTOR/ne',
        sectorCode: 'ne',
        imageSize: '1200x1200',
        coverageLabel: 'Northeast US (NOAA GOES-19 East)',
      };
    }

    return {
      satellite: 'GOES19',
      sectorPath: 'SECTOR/se',
      sectorCode: 'se',
      imageSize: '1200x1200',
      coverageLabel: 'Southeast US (NOAA GOES-19 East)',
    };
  }

  // 6. Broader Americas / Pacific Full Disk coverage
  if (longitude >= -115 && longitude <= -15 && latitude >= -60 && latitude <= 65) {
    return {
      satellite: 'GOES19',
      sectorPath: 'FD',
      sectorCode: 'FD',
      imageSize: '1808x1808',
      coverageLabel: 'Americas Full Disk (NOAA GOES-19 East)',
    };
  }

  if (
    ((longitude >= -180 && longitude < -115) || (longitude >= 130 && longitude <= 180)) &&
    latitude >= -60 &&
    latitude <= 65
  ) {
    return {
      satellite: 'GOES18',
      sectorPath: 'FD',
      sectorCode: 'FD',
      imageSize: '1808x1808',
      coverageLabel: 'Pacific Full Disk (NOAA GOES-18 West)',
    };
  }

  return null;
}

/**
 * Parse a NOAA NESDIS 11-digit filename timestamp (`YYYYDDDHHMM`, where `DDD` is 1-indexed day of year)
 * into a UTC `Date`.
 */
export function parseGoesTimestamp(stamp: string): Date | null {
  if (!/^\d{11}$/.test(stamp)) {
    return null;
  }
  const year = Number(stamp.slice(0, 4));
  const dayOfYear = Number(stamp.slice(4, 7));
  const hour = Number(stamp.slice(7, 9));
  const minute = Number(stamp.slice(9, 11));
  if (dayOfYear < 1 || dayOfYear > 366 || hour > 23 || minute > 59) {
    return null;
  }
  return new Date(Date.UTC(year, 0, dayOfYear, hour, minute, 0, 0));
}

export interface SatelliteFrameRequest {
  latitude: number;
  longitude: number;
  product: SatelliteProduct;
  animated: boolean;
  frames: number;
  pastMinutes: number;
}

export interface SatelliteFrameResult {
  sourceLabel: string;
  coverage: string;
  productLabel: string;
  attribution: string;
  disclaimer: string;
  frames: ImageryFrame[];
}

/**
 * Service for NOAA NESDIS STAR GOES-19 (East) & GOES-18 (West) ABI satellite imagery
 */
export class NwsGoesSatelliteService {
  private readonly baseURL: string;
  private readonly client: AxiosInstance;
  private readonly dirCache: Cache<Array<{ filename: string; timestamp: Date }>>;

  constructor(options?: { baseURL?: string; timeout?: number }) {
    this.baseURL = (options?.baseURL ?? 'https://cdn.star.nesdis.noaa.gov').replace(/\/+$/, '');
    this.client = axios.create({
      baseURL: this.baseURL,
      timeout: options?.timeout ?? 10000,
      headers: {
        'User-Agent': getUserAgent(),
      },
    });
    this.dirCache = new Cache<Array<{ filename: string; timestamp: Date }>>(64);
  }

  clearCache(): void {
    this.dirCache.clear();
  }

  async getFrames(request: SatelliteFrameRequest): Promise<SatelliteFrameResult> {
    const sector = getGoesSector(request.latitude, request.longitude);
    if (!sector) {
      throw new ValidationError(
        'NOAA GOES-East (GOES-19) and GOES-West (GOES-18) satellite imagery covers the United States, Americas, Atlantic, and Pacific (longitudes 180°W to 15°W and 130°E to 180°E).',
        'location',
        `${request.latitude},${request.longitude}`
      );
    }

    const productInfo = SATELLITE_PRODUCTS[request.product] ?? SATELLITE_PRODUCTS.geocolor;
    const dirPath = `/${sector.satellite}/ABI/${sector.sectorPath}/${productInfo.bandCode}/`;
    const dirUrl = `${this.baseURL}${dirPath}`;

    let availableFiles = await this.listDirectoryFrames(dirPath, sector.imageSize);
    let frames: ImageryFrame[];

    if (availableFiles.length === 0) {
      // Fallback to static latest image URL if directory listing could not be retrieved
      frames = [
        {
          url: `${dirUrl}${sector.imageSize}.jpg`,
          timestamp: new Date(),
          description: `NOAA ${sector.satellite} ${productInfo.label} (${sector.coverageLabel})`,
        },
      ];
    } else {
      const wantMultiple = request.animated || request.frames > 1;
      const latestEntry = availableFiles[availableFiles.length - 1];

      if (!wantMultiple) {
        frames = [
          {
            url: `${dirUrl}${latestEntry.filename}`,
            timestamp: latestEntry.timestamp,
            description: `NOAA ${sector.satellite} ${productInfo.label} at ${latestEntry.timestamp.toISOString()}`,
          },
        ];
      } else {
        const windowMs = Math.max(15, request.pastMinutes) * 60_000;
        const cutoffMs = latestEntry.timestamp.getTime() - windowMs;
        const inWindow = availableFiles.filter(
          (entry) => entry.timestamp.getTime() >= cutoffMs - 60_000
        );
        const pool = inWindow.length > 0 ? inWindow : availableFiles.slice(-request.frames);

        let selectedEntries = pool;
        if (pool.length > request.frames && request.frames > 1) {
          selectedEntries = [];
          for (let i = 0; i < request.frames; i++) {
            const idx = Math.round((i * (pool.length - 1)) / (request.frames - 1));
            selectedEntries.push(pool[idx]);
          }
        }

        frames = selectedEntries.map((entry) => ({
          url: `${dirUrl}${entry.filename}`,
          timestamp: entry.timestamp,
          description: `NOAA ${sector.satellite} ${productInfo.label} at ${entry.timestamp.toISOString()}`,
        }));
      }
    }

    return {
      sourceLabel: `NOAA NESDIS STAR (${sector.satellite === 'GOES19' ? 'GOES-19 East' : 'GOES-18 West'})`,
      coverage: sector.coverageLabel,
      productLabel: `${productInfo.label} — ${productInfo.legendSummary}`,
      attribution: 'NOAA NESDIS Center for Satellite Applications and Research (STAR) — GOES-R ABI',
      disclaimer:
        'NOAA GOES ABI regional sectors update every 5 minutes (Full Disk every 10 minutes). Visible band (Band 2) is dark at night; use GeoColor or Infrared for 24-hour cloud imagery.',
      frames,
    };
  }

  private async listDirectoryFrames(
    dirPath: string,
    imageSize: string
  ): Promise<Array<{ filename: string; timestamp: Date }>> {
    const cacheKey = Cache.generateKey('goes-dir', dirPath, imageSize);
    if (CacheConfig.enabled) {
      const cached = this.dirCache.get(cacheKey);
      if (cached) {
        return cached;
      }
    }

    try {
      const response = await this.client.get<string>(dirPath, {
        responseType: 'text',
      });
      const html = typeof response.data === 'string' ? response.data : '';
      const escapedSize = imageSize.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(
        `href="((\\d{11})_GOES\\d+-ABI-[A-Za-z0-9_-]+-${escapedSize}\\.jpg)"`,
        'gi'
      );

      const entries: Array<{ filename: string; timestamp: Date }> = [];
      const seen = new Set<string>();
      for (const match of html.matchAll(pattern)) {
        const filename = match[1];
        const stamp = match[2];
        if (seen.has(filename)) continue;
        const parsed = parseGoesTimestamp(stamp);
        if (parsed) {
          seen.add(filename);
          entries.push({ filename, timestamp: parsed });
        }
      }

      entries.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

      if (CacheConfig.enabled && entries.length > 0) {
        this.dirCache.set(cacheKey, entries, CacheConfig.ttl.weatherImagery);
      }

      return entries;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn('Failed to fetch GOES directory listing; falling back to static latest.jpg', {
        dirPath,
        reason,
      });
      return [];
    }
  }
}

const MAX_MCP_IMAGE_BYTES = 4 * 1024 * 1024; // 4 MB safety cap

/**
 * Fetch and build an MCP `image` content block (`base64` + `mimeType`) for the latest frame:
 * - For `satellite`: downloads the NOAA GOES JPEG directly (`image/jpeg`).
 * - For `radar` / `precipitation`: downloads the transparent radar PNG, composites it over an
 *   Esri Light Gray Canvas basemap + city/state reference labels with a center location pin,
 *   and encodes a single self-contained `image/png` so vision-capable AI clients can inspect
 *   where precipitation sits relative to geography and the queried coordinates.
 */
export async function buildMcpImageContent(options: {
  type: 'radar' | 'precipitation' | 'satellite';
  frameUrl: string;
  latitude: number;
  longitude: number;
  esriBaseUrl?: string;
  timeoutMs?: number;
}): Promise<{ data: string; mimeType: 'image/png' | 'image/jpeg' } | undefined> {
  const timeout = options.timeoutMs ?? 10000;
  const headers = { 'User-Agent': getUserAgent() };

  try {
    const primaryRes = await axios.get<ArrayBuffer>(options.frameUrl, {
      responseType: 'arraybuffer',
      timeout,
      headers,
      maxContentLength: MAX_MCP_IMAGE_BYTES,
    });
    const primaryBuf = Buffer.from(primaryRes.data);
    if (primaryBuf.length === 0 || primaryBuf.length > MAX_MCP_IMAGE_BYTES) {
      return undefined;
    }

    if (options.type === 'satellite') {
      return {
        data: primaryBuf.toString('base64'),
        mimeType: 'image/jpeg',
      };
    }

    // Extract EPSG:3857 BBOX from WMS GetMap URL if present, otherwise compute a ±160 km window
    let bboxStr: string;
    try {
      const parsedUrl = new URL(options.frameUrl);
      const bboxParam = parsedUrl.searchParams.get('BBOX') ?? parsedUrl.searchParams.get('bbox');
      if (bboxParam && /^-?[\d.]+,-?[\d.]+,-?[\d.]+,-?[\d.]+$/.test(bboxParam)) {
        bboxStr = bboxParam;
      } else {
        bboxStr = pointWindowMercatorBBox(options.latitude, options.longitude, 160).join(',');
      }
    } catch {
      bboxStr = pointWindowMercatorBBox(options.latitude, options.longitude, 160).join(',');
    }

    const esriRoot =
      options.esriBaseUrl ??
      'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas';
    const baseExportUrl = `${esriRoot}/World_Light_Gray_Base/MapServer/export?bbox=${bboxStr}&bboxSR=3857&imageSR=3857&size=512,512&format=png32&f=image`;
    const refExportUrl = `${esriRoot}/World_Light_Gray_Reference/MapServer/export?bbox=${bboxStr}&bboxSR=3857&imageSR=3857&size=512,512&format=png32&f=image`;

    const [basePng, referencePng] = await Promise.all([
      axios
        .get<ArrayBuffer>(baseExportUrl, {
          responseType: 'arraybuffer',
          timeout: 6000,
          headers,
          maxContentLength: MAX_MCP_IMAGE_BYTES,
        })
        .then((r) => Buffer.from(r.data))
        .catch(() => null),
      axios
        .get<ArrayBuffer>(refExportUrl, {
          responseType: 'arraybuffer',
          timeout: 6000,
          headers,
          maxContentLength: MAX_MCP_IMAGE_BYTES,
        })
        .then((r) => Buffer.from(r.data))
        .catch(() => null),
    ]);

    const composited = compositeRadarPng({
      radarPng: primaryBuf,
      basePng,
      referencePng,
    });

    return {
      data: composited.toString('base64'),
      mimeType: 'image/png',
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn('Failed to build MCP image content; returning text response only', {
      frameUrl: options.frameUrl,
      reason,
    });
    return undefined;
  }
}
