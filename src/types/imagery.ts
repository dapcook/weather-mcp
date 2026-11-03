/**
 * Type definitions for weather imagery data
 * Supports NOAA/NWS MRMS radar, IEM NEXRAD archive, and RainViewer global precipitation radar
 */

/**
 * Weather imagery type
 */
export type ImageryType = 'radar' | 'satellite' | 'precipitation';

/**
 * Supported radar providers
 */
export type RadarSourceId = 'nws' | 'iem' | 'rainviewer';

/**
 * Supported radar products
 */
export type RadarProduct =
  | 'base_reflectivity'
  | 'composite_reflectivity'
  | 'echo_tops'
  | 'precip_type';

/**
 * Supported NOAA GOES satellite imagery bands / products
 */
export type SatelliteProduct =
  | 'geocolor'
  | 'visible'
  | 'infrared'
  | 'water_vapor'
  | 'shortwave_infrared';

/**
 * Satellite imagery layer options
 */
export type SatelliteLayer = SatelliteProduct;

/**
 * Radar layer options (legacy alias)
 */
export type RadarLayer = 'base_reflectivity' | 'composite_reflectivity' | 'precipitation';

/**
 * Weather imagery request parameters
 */
export interface WeatherImageryParams {
  latitude: number;
  longitude: number;
  type: ImageryType;
  animated?: boolean;
  layers?: string[];
  source?: RadarSourceId | 'auto';
  product?: RadarProduct | SatelliteProduct;
  frames?: number;
  past_minutes?: number;
  at?: string;
  include_values?: boolean;
  include_image?: boolean;
}

/**
 * Single imagery frame
 */
export interface ImageryFrame {
  url: string;
  timestamp: Date;
  description?: string;
}

/**
 * Radar-estimated precipitation accumulation values at a point (NWS MRMS QPE)
 * Raw values from the service are in millimetres (mm).
 */
export interface PrecipitationAccumulationValues {
  validEndTime?: Date;
  subsetPrefix?: string;
  mm: {
    h1: number | null;
    h3: number | null;
    h6: number | null;
    h12: number | null;
    h24: number | null;
    h48: number | null;
    h72: number | null;
  };
  note?: string;
}

/**
 * Weather imagery response
 */
export interface WeatherImageryResponse {
  type: ImageryType;
  location: {
    latitude: number;
    longitude: number;
  };
  coverage: string;
  resolution?: string;
  source: string;
  sourceId?: RadarSourceId;
  product?: string;
  attribution?: string;
  fallbackNote?: string;
  precipitationValues?: PrecipitationAccumulationValues;
  imageContent?: {
    data: string;
    mimeType: 'image/png' | 'image/jpeg';
  };
  animated: boolean;
  frames: ImageryFrame[];
  generatedAt: Date;
  disclaimer?: string;
}

/**
 * RainViewer API response types
 */
export interface RainViewerFrame {
  time: number;  // Unix timestamp
  path: string;  // Relative path to tile
}

export interface RainViewerResponse {
  version: string;
  generated: number;  // Unix timestamp
  host: string;
  radar: {
    past: RainViewerFrame[];
    nowcast: RainViewerFrame[];
  };
  satellite?: {
    infrared: RainViewerFrame[];
  };
}

/**
 * NOAA radar station information
 */
export interface NOAARadarStation {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  elevation: number;
  distance?: number;  // Distance from query point in km
}
