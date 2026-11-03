/**
 * Unit tests for multi-provider radar sources (NWS MRMS, IEM NEXRAD archive, RainViewer)
 * and NWS MRMS QPE point accumulations using a local stub HTTP server (no network I/O).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import {
  IemRadarSource,
  NwsGoesSatelliteService,
  NwsQpeService,
  NwsRadarSource,
  parseGoesTimestamp,
  parseWmsCapabilitiesLayerTimes,
  getGoesSector,
  RadarServiceRegistry,
  RainViewerRadarSource,
} from '../../src/services/radar/index.js';
import {
  compositeRadarPng,
  decodePngToRgba,
  encodeRgbaToPng,
} from '../../src/utils/pngComposite.js';
import { RainViewerService } from '../../src/services/rainviewer.js';
import {
  getNwsRadarWorkspace,
  isIemRadarCovered,
  isNwsQpeCovered,
  isNwsRadarCovered,
  pointWindowMercatorBBox,
  tileToMercatorBBox,
  ORIGIN_SHIFT_M,
} from '../../src/utils/radarCoverage.js';
import {
  formatWeatherImageryResponse,
  getWeatherImagery,
} from '../../src/handlers/weatherImageryHandler.js';

function buildStubWmsCapabilities(workspace: string, baseIsoMs: number): string {
  // Generate 30 timestamps at 2-minute intervals ending at baseIsoMs
  const times: string[] = [];
  for (let i = 29; i >= 0; i--) {
    times.push(new Date(baseIsoMs - i * 2 * 60_000).toISOString());
  }
  const timeList = times.join(',');

  const suffixes = ['bref_qcd', 'cref_qcd', 'neet_v18', 'pcpn_typ'];
  const layersXml = suffixes
    .map(
      (suffix) => `
      <Layer queryable="1" opaque="0">
        <Name>${workspace}_${suffix}</Name>
        <Title>${workspace}_${suffix}</Title>
        <Dimension name="time" default="${times[times.length - 1]}" units="ISO8601">${timeList}</Dimension>
      </Layer>`
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<WMS_Capabilities version="1.3.0">
  <Capability>
    <Layer>
      <Title>Stub NWS GeoServer (${workspace})</Title>
      ${layersXml}
    </Layer>
  </Capability>
</WMS_Capabilities>`;
}

describe('Radar Coverage & Web Mercator Math', () => {
  it('identifies all five NWS workspaces and international locations', () => {
    // Kansas City (CONUS)
    expect(getNwsRadarWorkspace(39.0997, -94.5786)).toBe('conus');
    // Anchorage (Alaska)
    expect(getNwsRadarWorkspace(61.2181, -149.9003)).toBe('alaska');
    // Honolulu (Hawaii)
    expect(getNwsRadarWorkspace(21.3069, -157.8583)).toBe('hawaii');
    // San Juan (Puerto Rico / Caribbean)
    expect(getNwsRadarWorkspace(18.4655, -66.1057)).toBe('carib');
    // Hagåtña (Guam)
    expect(getNwsRadarWorkspace(13.4763, 144.7502)).toBe('guam');

    // International (Tokyo, London, Sydney)
    expect(getNwsRadarWorkspace(35.6762, 139.6503)).toBeNull();
    expect(getNwsRadarWorkspace(51.5074, -0.1278)).toBeNull();
    expect(getNwsRadarWorkspace(-33.8688, 151.2093)).toBeNull();

    // Coverage helpers
    expect(isNwsRadarCovered(13.4763, 144.7502)).toBe(true);
    expect(isIemRadarCovered(39.0997, -94.5786)).toBe(true);
    expect(isIemRadarCovered(13.4763, 144.7502)).toBe(false); // Guam not in IEM WMS-T
    expect(isNwsQpeCovered(18.4655, -66.1057)).toBe(true);
    expect(isNwsQpeCovered(13.4763, 144.7502)).toBe(false);
  });

  it('computes Web Mercator (EPSG:3857) tile and window bounding boxes', () => {
    // At zoom 0, tile (0, 0) spans the entire Web Mercator world
    const [minX0, minY0, maxX0, maxY0] = tileToMercatorBBox(0, 0, 0);
    expect(minX0).toBeCloseTo(-ORIGIN_SHIFT_M, 0);
    expect(minY0).toBeCloseTo(-ORIGIN_SHIFT_M, 0);
    expect(maxX0).toBeCloseTo(ORIGIN_SHIFT_M, 0);
    expect(maxY0).toBeCloseTo(ORIGIN_SHIFT_M, 0);

    // At zoom 1, tile (0, 0) is the NW quadrant (x: -ORIGIN..0, y: 0..+ORIGIN)
    const [minX1, minY1, maxX1, maxY1] = tileToMercatorBBox(1, 0, 0);
    expect(minX1).toBeCloseTo(-ORIGIN_SHIFT_M, 0);
    expect(maxX1).toBeCloseTo(0, 0);
    expect(minY1).toBeCloseTo(0, 0);
    expect(maxY1).toBeCloseTo(ORIGIN_SHIFT_M, 0);

    // Point window around (0, 0) with 250 km half-span
    const [wMinX, wMinY, wMaxX, wMaxY] = pointWindowMercatorBBox(0, 0, 250_000);
    expect(wMinX).toBe(-250_000);
    expect(wMinY).toBe(-250_000);
    expect(wMaxX).toBe(250_000);
    expect(wMaxY).toBe(250_000);
  });

  it('keeps tileToMercatorBBox in web/index.html identical to src/utils/radarCoverage.ts', () => {
    const html = readFileSync(join(process.cwd(), 'web/index.html'), 'utf-8');
    const fnMatch = html.match(/function tileToMercatorBBox\(z,\s*x,\s*y\)\s*\{[\s\S]*?\n  \}/);
    expect(fnMatch).not.toBeNull();

    const pageFn = new Function(
      'ORIGIN_SHIFT_M',
      `return (${fnMatch![0]});`
    )(ORIGIN_SHIFT_M) as (z: number, x: number, y: number) => [number, number, number, number];

    for (const [z, x, y] of [
      [3, 2, 3],
      [6, 15, 24],
      [9, 120, 195],
      [11, 480, 780],
    ] as const) {
      expect(pageFn(z, x, y)).toEqual(tileToMercatorBBox(z, x, y));
    }
  });
});

describe('Radar Sources & Handler (Stub Server)', () => {
  let server: Server;
  let baseUrl: string;
  let nwsFail = false;
  let qpeFail = false;
  let nwsCapRequests = 0;
  const fixedNowMs = Date.now() - 4 * 60_000; // 4 minutes ago so it's within both NWS and IEM windows

  let nws: NwsRadarSource;
  let iem: IemRadarSource;
  let rainviewer: RainViewerRadarSource;
  let qpe: NwsQpeService;
  let registry: RadarServiceRegistry;

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');

      // 1. NWS GeoServer GetCapabilities & GetMap stub
      const nwsMatch = reqUrl.pathname.match(/^\/geoserver\/([a-z]+)\/wms$/);
      if (nwsMatch) {
        if (reqUrl.searchParams.get('REQUEST') === 'GetMap') {
          const rgba = Buffer.alloc(16 * 16 * 4);
          for (let i = 0; i < rgba.length; i += 4) {
            rgba[i] = 0;
            rgba[i + 1] = 200;
            rgba[i + 2] = 80;
            rgba[i + 3] = 180;
          }
          const pngBuf = encodeRgbaToPng(16, 16, rgba);
          res.writeHead(200, { 'Content-Type': 'image/png' });
          res.end(pngBuf);
          return;
        }
        nwsCapRequests += 1;
        if (nwsFail) {
          res.writeHead(503, { 'Content-Type': 'text/plain' });
          res.end('GeoServer down');
          return;
        }
        const ws = nwsMatch[1];
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        res.end(buildStubWmsCapabilities(ws, fixedNowMs));
        return;
      }

      // 4. NOAA GOES satellite directory listing & JPEG stub
      const goesDirMatch = reqUrl.pathname.match(
        /^\/goes\/(GOES19|GOES18)\/ABI\/([A-Za-z0-9/_-]+)\/([A-Za-z0-9]+)\/$/
      );
      if (goesDirMatch) {
        const [, sat, sectorPath, band] = goesDirMatch;
        const sectorCode = sectorPath.split('/').pop()!;
        const size = sectorCode === 'ak' || sectorCode === 'ga' ? '1000x1000' : '1200x1200';
        const html = [
          '20261632146',
          '20261632151',
          '20261632156',
          '20261632201',
          '20261632206',
          '20261632211',
        ]
          .map(
            (stamp) =>
              `<a href="${stamp}_${sat}-ABI-${sectorCode}-${band}-${size}.jpg">${stamp}_${sat}-ABI-${sectorCode}-${band}-${size}.jpg</a>`
          )
          .join('\n');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
        return;
      }

      if (reqUrl.pathname.startsWith('/goes/') && reqUrl.pathname.endsWith('.jpg')) {
        // Minimal valid JPEG SOI..EOI bytes
        const jpegStub = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        res.end(jpegStub);
        return;
      }
      if (reqUrl.pathname === '/public/weather-maps.json') {
        const unixNow = Math.floor(fixedNowMs / 1000);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            version: '2.0',
            generated: unixNow,
            host: 'https://tilecache.rainviewer.com',
            radar: {
              past: [
                { time: unixNow - 1200, path: `/v2/radar/${unixNow - 1200}` },
                { time: unixNow - 600, path: `/v2/radar/${unixNow - 600}` },
                { time: unixNow, path: `/v2/radar/${unixNow}` },
              ],
              nowcast: [],
            },
          })
        );
        return;
      }

      // 3. NWS QPE /identify stub
      if (reqUrl.pathname === '/qpe/identify') {
        if (qpeFail) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 503, message: 'Service Unavailable' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            objectId: 0,
            name: 'Pixel',
            value: '2.5',
            properties: {
              Values: ['2.5', '5.1', '10.2', '15.0', '25.4', '30.0', '38.1'],
            },
            catalogItems: {
              features: [
                { attributes: { idp_subset: 'conus_QPE_01H', idp_validendtime: fixedNowMs } },
                { attributes: { idp_subset: 'conus_QPE_03H', idp_validendtime: fixedNowMs } },
                { attributes: { idp_subset: 'conus_QPE_06H', idp_validendtime: fixedNowMs } },
                { attributes: { idp_subset: 'conus_QPE_12H', idp_validendtime: fixedNowMs } },
                { attributes: { idp_subset: 'conus_QPE_24H', idp_validendtime: fixedNowMs } },
                { attributes: { idp_subset: 'conus_QPE_48H', idp_validendtime: fixedNowMs } },
                { attributes: { idp_subset: 'conus_QPE_72H', idp_validendtime: fixedNowMs } },
              ],
            },
          })
        );
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    nwsFail = false;
    qpeFail = false;
    nwsCapRequests = 0;

    nws = new NwsRadarSource({ baseURL: `${baseUrl}/geoserver`, timeout: 5000 });
    iem = new IemRadarSource({
      endpointUrl: 'https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q-t.cgi',
    });
    const rvService = new RainViewerService({ baseURL: baseUrl, timeout: 5000 });
    rainviewer = new RainViewerRadarSource(rvService);
    qpe = new NwsQpeService({ baseURL: `${baseUrl}/qpe`, timeout: 5000 });
    const satellite = new NwsGoesSatelliteService({ baseURL: `${baseUrl}/goes`, timeout: 5000 });
    registry = new RadarServiceRegistry({
      nws,
      iem,
      rainviewer,
      qpe,
      satellite,
      esriBaseUrl: `${baseUrl}/esri`,
    });
  });

  it('parses WMS GetCapabilities time lists', () => {
    const xml = buildStubWmsCapabilities('conus', fixedNowMs);
    const map = parseWmsCapabilitiesLayerTimes(xml);
    expect(map.has('conus_bref_qcd')).toBe(true);
    expect(map.get('conus_bref_qcd')?.length).toBe(30);
  });

  it('routes Kansas City (US) to NWS in auto mode and caches GetCapabilities', async () => {
    const res1 = await getWeatherImagery(
      {
        latitude: 39.0997,
        longitude: -94.5786,
        type: 'radar',
        animated: true,
        frames: 6,
        past_minutes: 30,
      },
      registry
    );

    expect(res1.sourceId).toBe('nws');
    expect(res1.source).toContain('NOAA/NWS');
    expect(res1.frames.length).toBe(6);
    expect(res1.frames[0].url).toContain('LAYERS=conus_bref_qcd');
    expect(res1.frames[0].url).toContain('CRS=EPSG%3A3857');
    expect(nwsCapRequests).toBe(1);

    // Second call for another CONUS location should hit capabilities cache
    await getWeatherImagery(
      {
        latitude: 40.7128,
        longitude: -74.006,
        type: 'radar',
      },
      registry
    );
    expect(nwsCapRequests).toBe(1);
  });

  it('routes Alaska, Hawaii, Puerto Rico, and Guam to their respective NWS workspaces', async () => {
    const cases = [
      { lat: 61.2181, lon: -149.9003, expectedLayer: 'alaska_bref_qcd' },
      { lat: 21.3069, lon: -157.8583, expectedLayer: 'hawaii_bref_qcd' },
      { lat: 18.4655, lon: -66.1057, expectedLayer: 'carib_bref_qcd' },
      { lat: 13.4763, lon: 144.7502, expectedLayer: 'guam_bref_qcd' },
    ];

    for (const c of cases) {
      const res = await getWeatherImagery(
        { latitude: c.lat, longitude: c.lon, type: 'radar' },
        registry
      );
      expect(res.sourceId).toBe('nws');
      expect(res.frames[0].url).toContain(`LAYERS=${c.expectedLayer}`);
    }
  });

  it('routes Tokyo (outside US) to RainViewer in auto mode', async () => {
    const res = await getWeatherImagery(
      {
        latitude: 35.6762,
        longitude: 139.6503,
        type: 'radar',
        animated: false,
      },
      registry
    );

    expect(res.sourceId).toBe('rainviewer');
    expect(res.source).toBe('RainViewer');
    expect(res.frames.length).toBe(1);
    expect(res.frames[0].url).toContain('tilecache.rainviewer.com');
  });

  it('falls back to IEM with a note when NWS fails in auto mode', async () => {
    nwsFail = true;

    const res = await getWeatherImagery(
      {
        latitude: 39.0997,
        longitude: -94.5786,
        type: 'radar',
      },
      registry
    );

    expect(res.sourceId).toBe('iem');
    expect(res.fallbackNote).toContain('Fell back to Iowa Environmental Mesonet');
    expect(res.frames[0].url).toContain('LAYERS=nexrad-n0q-wmst');

    const formatted = formatWeatherImageryResponse(res);
    expect(formatted).toContain('Fell back to Iowa Environmental Mesonet');
  });

  it('falls back to RainViewer when NWS fails in Guam (outside IEM coverage)', async () => {
    nwsFail = true;

    const res = await getWeatherImagery(
      {
        latitude: 13.4763,
        longitude: 144.7502,
        type: 'radar',
      },
      registry
    );

    expect(res.sourceId).toBe('rainviewer');
    expect(res.fallbackNote).toContain('Fell back to RainViewer');
  });

  it('routes historical `at` requests to IEM and snaps to 5-minute steps', async () => {
    const res = await getWeatherImagery(
      {
        latitude: 39.0997,
        longitude: -94.5786,
        type: 'radar',
        at: '2025-06-12T22:03:45Z',
        frames: 3,
        past_minutes: 10,
      },
      registry
    );

    expect(res.sourceId).toBe('iem');
    expect(res.frames.length).toBe(3);
    expect(res.frames[0].timestamp.toISOString()).toBe('2025-06-12T21:50:00.000Z');
    expect(res.frames[1].timestamp.toISOString()).toBe('2025-06-12T21:55:00.000Z');
    expect(res.frames[2].timestamp.toISOString()).toBe('2025-06-12T22:00:00.000Z');
    expect(res.frames[2].url).toContain('TIME=2025-06-12T22%3A00%3A00Z');
  });

  it('rejects IEM dates before 2011-02-16 or in the future', async () => {
    await expect(
      getWeatherImagery(
        {
          latitude: 39.0997,
          longitude: -94.5786,
          type: 'radar',
          source: 'iem',
          at: '2010-05-01T12:00:00Z',
        },
        registry
      )
    ).rejects.toThrow('2011-02-16');

    const futureIso = new Date(Date.now() + 24 * 3600_000).toISOString();
    await expect(
      getWeatherImagery(
        {
          latitude: 39.0997,
          longitude: -94.5786,
          type: 'radar',
          source: 'iem',
          at: futureIso,
        },
        registry
      )
    ).rejects.toThrow('future');
  });

  it('fetches and formats NWS MRMS QPE precipitation amounts when include_values is true', async () => {
    const res = await getWeatherImagery(
      {
        latitude: 47.6062,
        longitude: -122.3321,
        type: 'radar',
        include_values: true,
      },
      registry
    );

    expect(res.precipitationValues).toBeDefined();
    expect(res.precipitationValues?.mm.h1).toBe(2.5);
    expect(res.precipitationValues?.mm.h24).toBe(25.4);
    expect(res.precipitationValues?.mm.h72).toBe(38.1);

    const formatted = formatWeatherImageryResponse(res);
    expect(formatted).toContain('## 🌧️ Radar-Estimated Precipitation (NWS MRMS QPE)');
    expect(formatted).toContain('1.00 in (25.4 mm)');
    expect(formatted).toContain('1.50 in (38.1 mm)');
  });

  it('keeps radar imagery when QPE point query fails', async () => {
    qpeFail = true;

    const res = await getWeatherImagery(
      {
        latitude: 47.6062,
        longitude: -122.3321,
        type: 'radar',
        include_values: true,
      },
      registry
    );

    expect(res.frames.length).toBe(1);
    expect(res.precipitationValues?.note).toContain('temporarily unavailable');
  });

  it('maps US & territory coordinates to NOAA GOES-19 / GOES-18 regional sectors', () => {
    expect(getGoesSector(40.7128, -74.006)?.sectorCode).toBe('ne');
    expect(getGoesSector(33.749, -84.388)?.sectorCode).toBe('se');
    expect(getGoesSector(41.8781, -87.6298)?.sectorCode).toBe('cgl');
    expect(getGoesSector(44.9778, -93.265)?.sectorCode).toBe('umv');
    expect(getGoesSector(35.1495, -90.049)?.sectorCode).toBe('smv');
    expect(getGoesSector(32.7767, -96.797)?.sectorCode).toBe('sp');
    expect(getGoesSector(27.9506, -82.4572)?.sectorCode).toBe('ga');
    expect(getGoesSector(45.7833, -108.5007)?.sectorCode).toBe('nr');
    expect(getGoesSector(35.0844, -106.6504)?.sectorCode).toBe('sr');
    expect(getGoesSector(47.6062, -122.3321)?.sectorCode).toBe('pnw');
    expect(getGoesSector(34.0522, -118.2437)?.sectorCode).toBe('psw');
    expect(getGoesSector(61.2181, -149.9003)?.sectorCode).toBe('ak');
    expect(getGoesSector(21.3069, -157.8583)?.sectorCode).toBe('hi');
    expect(getGoesSector(18.4655, -66.1057)?.sectorCode).toBe('pr');
    expect(getGoesSector(13.4763, 144.7502)?.sectorCode).toBe('tpw');
    expect(getGoesSector(51.5074, -0.1278)).toBeNull(); // London outside GOES coverage

    const dt = parseGoesTimestamp('20261632211');
    expect(dt?.toISOString()).toBe('2026-06-12T22:11:00.000Z');
  });

  it('fetches NOAA GOES satellite imagery (single frame, animated, and MCP image content)', async () => {
    const res = await getWeatherImagery(
      {
        latitude: 44.9778,
        longitude: -93.265,
        type: 'satellite',
        product: 'geocolor',
        animated: true,
        frames: 4,
        past_minutes: 30,
        include_image: true,
      },
      registry
    );

    expect(res.type).toBe('satellite');
    expect(res.source).toContain('GOES-19 East');
    expect(res.coverage).toContain('Upper Mississippi Valley');
    expect(res.frames.length).toBe(4);
    expect(res.frames[3].url).toContain('20261632211_GOES19-ABI-umv-GEOCOLOR-1200x1200.jpg');
    expect(res.imageContent).toBeDefined();
    expect(res.imageContent?.mimeType).toBe('image/jpeg');
    expect(res.imageContent?.data.length).toBeGreaterThan(8);
  });

  it('composites radar PNG and returns MCP image content when include_image is true', async () => {
    const res = await getWeatherImagery(
      {
        latitude: 39.0997,
        longitude: -94.5786,
        type: 'radar',
        include_image: true,
      },
      registry
    );

    expect(res.imageContent).toBeDefined();
    expect(res.imageContent?.mimeType).toBe('image/png');
    const pngBuf = Buffer.from(res.imageContent!.data, 'base64');
    const decoded = decodePngToRgba(pngBuf);
    expect(decoded.width).toBeGreaterThanOrEqual(16);
    expect(decoded.height).toBeGreaterThanOrEqual(16);

    // Direct round-trip test on compositeRadarPng
    const smallRgba = Buffer.alloc(32 * 32 * 4, 128);
    const smallPng = encodeRgbaToPng(32, 32, smallRgba);
    const comp = compositeRadarPng({ radarPng: smallPng });
    const compDecoded = decodePngToRgba(comp);
    expect(compDecoded.width).toBe(32);
    expect(compDecoded.height).toBe(32);
  });
});
