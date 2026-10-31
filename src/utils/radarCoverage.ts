/**
 * Geographic coverage detection and Web Mercator (EPSG:3857) projection math
 * for weather radar providers and the web console tile map.
 */

export type NwsRadarWorkspace = 'conus' | 'alaska' | 'hawaii' | 'carib' | 'guam';

const EARTH_RADIUS_M = 6378137;
export const ORIGIN_SHIFT_M = Math.PI * EARTH_RADIUS_M; // 20037508.342789244
export const MAX_MERCATOR_LAT = 85.05112878;

/**
 * Determine which NWS GeoServer workspace covers the given coordinates, or null if outside US coverage.
 *
 * Verified GeoServer workspaces on opengeo.ncep.noaa.gov:
 * - conus:  [-130, -60, 20, 55] (checked with continental US bounds 24.0..50.0, -126.0..-66.0)
 * - alaska: [-176, -126, 50, 72]
 * - hawaii: [-164, -151, 15, 26]
 * - carib:  [-90, -60, 10, 25]  (Puerto Rico & US Virgin Islands: 17.0..19.5, -68.5..-64.0)
 * - guam:   [140, 150, 9, 18]   (Guam & CNMI: 12.5..16.5, 144.0..146.5)
 */
export function getNwsRadarWorkspace(latitude: number, longitude: number): NwsRadarWorkspace | null {
  // Check smaller island territories first before broader continental boxes
  if (latitude >= 17.0 && latitude <= 19.5 && longitude >= -68.5 && longitude <= -64.0) {
    return 'carib';
  }
  if (latitude >= 18.0 && latitude <= 23.5 && longitude >= -161.5 && longitude <= -154.0) {
    return 'hawaii';
  }
  if (latitude >= 12.5 && latitude <= 16.5 && longitude >= 144.0 && longitude <= 146.5) {
    return 'guam';
  }
  if (latitude >= 51.0 && latitude <= 71.5 && longitude >= -176.0 && longitude <= -129.5) {
    return 'alaska';
  }
  if (latitude >= 24.0 && latitude <= 50.0 && longitude >= -126.0 && longitude <= -66.0) {
    return 'conus';
  }
  return null;
}

/**
 * Human-readable coverage label for an NWS workspace
 */
export function getNwsWorkspaceCoverageLabel(workspace: NwsRadarWorkspace): string {
  switch (workspace) {
    case 'conus':
      return 'Continental United States (CONUS)';
    case 'alaska':
      return 'Alaska';
    case 'hawaii':
      return 'Hawaii';
    case 'carib':
      return 'Puerto Rico & U.S. Virgin Islands';
    case 'guam':
      return 'Guam & Northern Mariana Islands';
  }
}

/**
 * True if coordinates fall within any NWS GeoServer radar workspace
 */
export function isNwsRadarCovered(latitude: number, longitude: number): boolean {
  return getNwsRadarWorkspace(latitude, longitude) !== null;
}

/**
 * True if coordinates fall within IEM's WMS-T NEXRAD archive coverage ([-171, 15, -66, 70]).
 * Covers CONUS, Alaska, Hawaii, and Puerto Rico/USVI (excludes Guam in the eastern hemisphere).
 */
export function isIemRadarCovered(latitude: number, longitude: number): boolean {
  const ws = getNwsRadarWorkspace(latitude, longitude);
  return ws === 'conus' || ws === 'alaska' || ws === 'hawaii' || ws === 'carib';
}

/**
 * True if coordinates fall within NWS MRMS QPE ImageServer coverage.
 * QPE subsets exist for conus, alaska, hawaii, and carib.
 */
export function isNwsQpeCovered(latitude: number, longitude: number): boolean {
  return isIemRadarCovered(latitude, longitude);
}

/**
 * Convert geographic coordinates (WGS84 degrees) to Web Mercator (EPSG:3857) metres.
 */
export function latLonToMercator(latitude: number, longitude: number): { x: number; y: number } {
  const clampedLat = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, latitude));
  const clampedLon = Math.max(-180, Math.min(180, longitude));

  const x = (clampedLon * ORIGIN_SHIFT_M) / 180;
  const latRad = (clampedLat * Math.PI) / 180;
  const y = Math.log(Math.tan(Math.PI / 4 + latRad / 2)) * EARTH_RADIUS_M;

  return { x, y };
}

/**
 * Build a square EPSG:3857 bounding box [minX, minY, maxX, maxY] in metres
 * around a point, clamped to the Web Mercator world bounds.
 */
export function pointWindowMercatorBBox(
  latitude: number,
  longitude: number,
  halfSpanMeters: number = 250_000
): [number, number, number, number] {
  const { x, y } = latLonToMercator(latitude, longitude);
  const span = Math.max(1_000, Math.min(5_000_000, halfSpanMeters));

  const minX = Math.max(-ORIGIN_SHIFT_M, x - span);
  const maxX = Math.min(ORIGIN_SHIFT_M, x + span);
  const minY = Math.max(-ORIGIN_SHIFT_M, y - span);
  const maxY = Math.min(ORIGIN_SHIFT_M, y + span);

  return [
    Math.round(minX * 100) / 100,
    Math.round(minY * 100) / 100,
    Math.round(maxX * 100) / 100,
    Math.round(maxY * 100) / 100,
  ];
}

/**
 * Convert slippy-map XYZ tile coordinates to an EPSG:3857 bounding box [minX, minY, maxX, maxY] in metres.
 * Used by both server tests and the web console's WMS tile layer.
 */
export function tileToMercatorBBox(
  z: number,
  x: number,
  y: number
): [number, number, number, number] {
  const n = 2 ** z;
  const worldSpan = 2 * ORIGIN_SHIFT_M;
  const tileSizeM = worldSpan / n;

  const minX = -ORIGIN_SHIFT_M + x * tileSizeM;
  const maxX = minX + tileSizeM;
  // In XYZ tiles, y=0 is at the top (+ORIGIN_SHIFT_M) and increases southward
  const maxY = ORIGIN_SHIFT_M - y * tileSizeM;
  const minY = maxY - tileSizeM;

  return [
    Math.round(minX * 100) / 100,
    Math.round(minY * 100) / 100,
    Math.round(maxX * 100) / 100,
    Math.round(maxY * 100) / 100,
  ];
}
