/**
 * RainViewer API client for global precipitation radar imagery
 * Free API with no authentication required
 * @see https://www.rainviewer.com/api.html
 */

import axios, { AxiosInstance } from 'axios';
import { logger } from '../utils/logger.js';
import { RainViewerResponse, RainViewerFrame, ImageryFrame } from '../types/imagery.js';
import { ServiceUnavailableError } from '../errors/ApiError.js';
import { Cache } from '../utils/cache.js';
import { CacheConfig } from '../config/cache.js';
import { getUserAgent } from '../utils/version.js';

export class RainViewerService {
  private client: AxiosInstance;
  private cache: Cache<RainViewerResponse>;
  private readonly baseUrl = 'https://api.rainviewer.com';
  private readonly tileHost = 'https://tilecache.rainviewer.com';

  constructor(options?: { baseURL?: string; timeout?: number }) {
    this.client = axios.create({
      baseURL: options?.baseURL ?? this.baseUrl,
      timeout: options?.timeout ?? 10000,
      headers: {
        'User-Agent': getUserAgent()
      }
    });
    this.cache = new Cache<RainViewerResponse>(16);
  }

  /**
   * Clear cached radar metadata (used in tests)
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get latest precipitation radar data
   * Returns timestamps and paths for animated radar
   */
  async getRadarData(): Promise<RainViewerResponse> {
    const cacheKey = 'rainviewer:weather-maps';
    if (CacheConfig.enabled) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        logger.info('RainViewer radar metadata cache hit');
        return cached;
      }
    }

    try {
      logger.info('Fetching RainViewer radar data');

      const response = await this.client.get<RainViewerResponse>('/public/weather-maps.json');

      if (!response.data || !response.data.radar) {
        throw new ServiceUnavailableError(
          'RainViewer',
          'Invalid response format from RainViewer API'
        );
      }

      if (CacheConfig.enabled) {
        this.cache.set(cacheKey, response.data, CacheConfig.ttl.weatherImagery);
      }

      logger.info('RainViewer radar data retrieved successfully', {
        pastFrames: response.data.radar.past?.length || 0,
        nowcastFrames: response.data.radar.nowcast?.length || 0
      });

      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const message = error.response?.data?.message || error.message;

        logger.error('RainViewer API request failed', error, {
          status,
          message
        });

        throw new ServiceUnavailableError(
          'RainViewer',
          `Failed to fetch radar data: ${message}`
        );
      }

      throw error;
    }
  }

  /**
   * Build tile URL for a specific frame
   * RainViewer uses tile-based system (similar to web maps)
   */
  buildTileUrl(frame: RainViewerFrame, size: number = 512, zoom: number = 4): string {
    // For global view, we use zoom 4 and tile coordinates for coverage
    // Format: {host}/v2/radar/{timestamp}/{size}/{zoom}/{x}/{y}/tile.png
    const centerX = Math.floor(2 ** (zoom - 1));
    const centerY = Math.floor(2 ** (zoom - 1));

    return `${this.tileHost}${frame.path}/${size}/${zoom}/${centerX}/${centerY}/4/1_1.png`;
  }

  /**
   * Build tile URL for a specific coordinate
   * Clamps latitude to Web Mercator projection range to prevent NaN tile coordinates
   */
  buildCoordinateTileUrl(
    frame: RainViewerFrame,
    latitude: number,
    longitude: number,
    zoom: number = 6
  ): string {
    // Web Mercator projection is undefined at the poles
    // Clamp latitude to safe range (±85.05112878°) to avoid division by zero
    const MAX_LATITUDE = 85.05112878;
    const clampedLat = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, latitude));

    if (clampedLat !== latitude) {
      logger.warn('Latitude clamped to Web Mercator safe range', {
        original: latitude,
        clamped: clampedLat,
        maxLatitude: MAX_LATITUDE
      });
    }

    // Convert lat/lon to tile coordinates
    const x = Math.floor(((longitude + 180) / 360) * 2 ** zoom);
    const y = Math.floor(
      ((1 - Math.log(Math.tan((clampedLat * Math.PI) / 180) + 1 / Math.cos((clampedLat * Math.PI) / 180)) / Math.PI) / 2) *
        2 ** zoom
    );

    return `${this.tileHost}${frame.path}/512/${zoom}/${x}/${y}/4/1_1.png`;
  }

  /**
   * Convert RainViewer frames to standard ImageryFrame format
   */
  convertFrames(frames: RainViewerFrame[], latitude: number, longitude: number): ImageryFrame[] {
    return frames.map(frame => ({
      url: this.buildCoordinateTileUrl(frame, latitude, longitude),
      timestamp: new Date(frame.time * 1000),
      description: `Precipitation radar at ${new Date(frame.time * 1000).toISOString()}`
    }));
  }

  /**
   * Get recent precipitation radar imagery (past 2 hours)
   */
  async getPrecipitationRadar(
    latitude: number,
    longitude: number,
    animated: boolean = false
  ): Promise<ImageryFrame[]> {
    const data = await this.getRadarData();

    if (!data.radar.past || data.radar.past.length === 0) {
      logger.warn('No past radar data available from RainViewer');
      return [];
    }

    // If animated, return all past frames
    if (animated) {
      return this.convertFrames(data.radar.past, latitude, longitude);
    }

    // Otherwise, return only the most recent frame
    const latestFrame = data.radar.past[data.radar.past.length - 1];
    return this.convertFrames([latestFrame], latitude, longitude);
  }
}

// Singleton instance
export const rainViewerService = new RainViewerService();
