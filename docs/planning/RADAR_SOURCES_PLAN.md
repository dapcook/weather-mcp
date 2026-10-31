# Radar Sources Plan (`get_weather_imagery`)

**Goal:** let `get_weather_imagery` (and the web console's radar map) use more than one free radar source: NOAA/NWS Multi-Radar Multi-Sensor (MRMS) across the US and territories, the Iowa Environmental Mesonet (IEM) archive back to 2011, closer street-level zoom, frame playback, and radar-estimated precipitation amounts at a point, with RainViewer kept as the global fallback.

**Status:** All Phases (0–5) completed, tested, and deployed (US focus + RainViewer global fallback + NOAA GOES satellite + MCP vision image content).

| Phase | Scope | Effort | Status |
|---|---|---|---|
| 0 | Verification spikes (layer names, units, terms) | ½ day | ✅ Done |
| 1 | Provider framework + NWS (US & territories) + `source` and past-frame options | 1 day | ✅ Done |
| 2 | IEM (US NEXRAD archive back to 2011 via `at` parameter) | 1 day | ✅ Done |
| 3 | Console map works for every source, deeper zoom, frame slider | 1 day | ✅ Done |
| 4 | Rain amounts at a point (`include_values` via NWS MRMS QPE) | ½-1 day | ✅ Done |
| 5 | Let the AI visually inspect radar/satellite (`include_image`) + NOAA GOES satellite (`type: "satellite"`) | 1-2 days | ✅ Done |

---

## 1. Where things stand

| Piece | Before this work |
|---|---|
| `src/services/rainviewer.ts` | The only provider. Returns one tile URL per frame at zoom 6 for the location. Frames are the last ~2 hours; free tiles stop at zoom 7 |
| `src/handlers/weatherImageryHandler.ts` | Validates, calls RainViewer, formats markdown. `type` is `radar`, `satellite` or `precipitation`; `satellite` returns "not yet implemented". `layers` is accepted and ignored |
| Tool schema (`src/mcpServer.ts`) | `latitude`, `longitude`, `location_name`, `type` (required), `animated`, `layers`. `get_weather_imagery` is already in `SAVED_LOCATION_TOOLS` |
| Console (`web/index.html`) | `enhanceRadarImages` only recognizes RainViewer tile URLs, then `buildRadarMap` draws them over an Esri basemap (zoom 3-7, pan, pin). One frame per map; an animated result shows 3 of N frames as separate maps |
| Output contract | The tool returns image URLs only. The server never downloads or proxies imagery |
| Security | The console's CSP already allows images from any `https:` host, so new providers need no CSP change |

## 2. Verified sources (Phase 0 results)

| Source | Gives | Past frames | Coverage | Access | Verified notes |
|---|---|---|---|---|---|
| **NWS GeoServer** (`opengeo.ncep.noaa.gov/geoserver/{region}/wms`) | MRMS QC'd base reflectivity (`{region}_bref_qcd`), composite reflectivity (`{region}_cref_qcd`), 18 dBZ echo tops (`{region}_neet_v18`), precipitation type (`{region}_pcpn_typ`) | 60 frames, 2-minute steps (~2 hours) | All 5 workspaces verified: `conus` (`[-130, -60, 20, 55]`), `alaska` (`[-176, -126, 50, 72]`), `hawaii` (`[-164, -151, 15, 26]`), `carib` (`[-90, -60, 10, 25]`), `guam` (`[140, 150, 9, 18]`) | WMS 1.3.0, `TIME` parameter, `EPSG:3857` and `EPSG:4326`, no key | Public domain, official NOAA/NWS product |
| **NWS MRMS QPE** (`mapservices.weather.noaa.gov/raster/rest/services/obs/mrms_qpe/ImageServer`) | Radar-estimated precipitation accumulation (1, 3, 6, 12, 24, 48, 72 h) at a point via `/identify` | Current only | `conus_QPE_*`, `alaska_QPE_*`, `hawaii_QPE_*`, `carib_QPE_*` (Guam not in QPE catalog) | ArcGIS ImageServer `/identify` with JSON point geometry (`wkid: 4326`), no key | **Units verified as millimetres (mm)**: raw pixel `properties.Values` match MRMS GRIB2 raster mm (verified against KSEA/KBFI ASOS gauges: 0.36 in / 9.1 mm gauge vs 15.3 mm QPE), while the visual `rft_*hr` color ramp legend converts to inches |
| **IEM** (`mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q-t.cgi`) | NEXRAD composite base reflectivity (`nexrad-n0q-wmst`, 0.5 dBZ resolution) | WMS-T `PT5M` from **2011-02-16T00:00:00Z to present** (5-minute steps) | US (`[-171, 15, -66, 70]`: CONUS, AK, HI, PR) | WMS 1.1.1, `SRS=EPSG:3857`, `TIME` ISO-8601 UTC (snapped to 5 minutes), no key | Built by Iowa Environmental Mesonet (Iowa State University); requests descriptive `User-Agent` and reasonable request rates |
| **RainViewer** (`api.rainviewer.com`) | Pre-rendered global radar tiles | About 2 hours (10-minute steps) | Global | XYZ tiles (zoom ≤ 7 free) | Global fallback outside US coverage or when US services are unreachable |

**Out of scope:**
- **MRMS raw GRIB2 files** (`noaa-mrms-pds` on AWS): decoding one 7000 × 3500 grid takes ~570 MB of heap memory; NWS QPE `/identify` gives point values with zero grid download.
- **NEXRAD Level II/III** (AWS): raw single-site radial velocity/spectrum width is for storm-scale analysis.
- **International national WMS (Environment Canada, DWD, UK Met Office, BoM):** skipped per user preference to focus on United States coverage + RainViewer global fallback.

## 3. Design

### 3.1 Tool parameters

Keep existing parameters (`latitude`, `longitude`, `location_name`, `type`, `animated`, `layers`); add:

| Parameter | Values | Meaning |
|---|---|---|
| `source` | `auto` (default), `nws`, `iem`, `rainviewer` | Which radar provider to use |
| `product` | `base_reflectivity` (default), `composite_reflectivity`, `echo_tops`, `precip_type` | Radar product (NWS supports all 4; IEM and RainViewer provide base reflectivity) |
| `frames` | `1`–`24` (default `1`; when `animated: true`, default `6`) | Number of frames to return |
| `past_minutes` | `5`–`120` (default `60` when multiple frames requested) | Time window for frame selection |
| `at` | ISO-8601 timestamp | Historical radar snapshot/loop ending at a past time (IEM archive back to `2011-02-16T00:00:00Z` for US locations; NWS within its ~2-hour window) |
| `include_values` | `boolean` (default `false`) | Fetch radar-estimated precipitation amounts (1, 3, 6, 12, 24, 48, 72 h) at the point from NWS MRMS QPE |

### 3.2 Providers & Coverage (`src/services/radar/` and `src/utils/radarCoverage.ts`)

- `src/utils/radarCoverage.ts`:
  - `getNwsRadarWorkspace(lat, lon)` returns `'conus' | 'alaska' | 'hawaii' | 'carib' | 'guam' | null`
  - `isIemCovered(lat, lon)` checks if coordinates are in CONUS, Alaska, Hawaii, or Puerto Rico/Caribbean (`conus`, `alaska`, `hawaii`, `carib`)
  - Shared Web Mercator (`EPSG:3857`) bounding-box helpers (`latLonToMercator`, `tileToMercatorBBox`, `pointWindowMercatorBBox`) used by both WMS URL generation and console tile math
- `src/services/radar/`:
  - `RadarSource` interface & `WmsRadarSource` implementation
  - `NwsRadarSource`: queries and caches `GetCapabilities` (3-minute TTL) for the regional workspace, snaps requested times to available layer timestamps, and builds WMS 1.3.0 `GetMap` URLs (`CRS=EPSG:3857`, `WIDTH=512`, `HEIGHT=512`, `FORMAT=image/png`, `TRANSPARENT=TRUE`)
  - `IemRadarSource`: snaps requested timestamps to 5-minute (`PT5M`) boundaries (validating `>= 2011-02-16T00:00:00Z` and `<= now`) and builds WMS 1.1.1 `GetMap` URLs (`SRS=EPSG:3857`, `LAYERS=nexrad-n0q-wmst`)
  - `RainViewerRadarSource`: adapts `RainViewerService` (with 3-minute response caching) to the `RadarSource` interface
  - `NwsQpeService`: queries `mrms_qpe/ImageServer/identify` for `include_values: true`, returning 1h, 3h, 6h, 12h, 24h, 48h, and 72h accumulations in both inches and mm

### 3.3 Routing & Fallback (`source: 'auto'`)

1. If `at` is more than 2 hours in the past:
   - Must be within US IEM coverage (`conus`, `alaska`, `hawaii`, `carib`) and `>= 2011-02-16T00:00:00Z` → routes to **IEM**.
2. For current / recent requests in US coverage:
   - Routes to **NWS**, falling back to **IEM**, then **RainViewer** if an upstream service fails (recording a `fallbackNote` in the response).
3. Outside US coverage:
   - Routes to **RainViewer**.
4. Explicit `source` outside its geographic coverage or time range throws a clear `ValidationError` listing valid sources for that location/time.

### 3.4 Web Console (`web/index.html`)

- **Provider-aware radar map (`enhanceRadarImages` + `buildRadarMap`):**
  - Recognizes RainViewer tile URLs, NWS GeoServer WMS URLs, and IEM WMS URLs.
  - For WMS sources, computes each visible slippy-map tile's `EPSG:3857` bounding box (`tileToMercatorBBox(z, x, y)`) and requests a 256×256 transparent PNG tile from the WMS endpoint with the active frame's `TIME` and `LAYERS`.
  - Unlocks zoom levels **3 to 11** for WMS sources (street/neighborhood level), keeping 3 to 7 for RainViewer.
  - Consolidates multiple frames into **one interactive radar map** with a **frame playback slider** (Play/Pause button, range scrubber, frame timestamp readout) instead of rendering 3 separate static maps.
  - Also consolidates multi-frame NOAA GOES satellite imagery (`enhanceSatelliteImages`) into an interactive frame player with Play/Pause and timeline scrubber, and renders a collapsible preview of any attached MCP vision image (`include_image: true`).

### 3.5 NOAA GOES Satellite & MCP Vision Image Content (Phase 5)

- **NOAA NESDIS STAR GOES-19 (East) & GOES-18 (West) (`src/services/radar/satellite.ts`):**
  - `getGoesSector(latitude, longitude)` maps US & territory coordinates to their regional sector (`ne`, `se`, `cgl`, `umv`, `smv`, `sp`, `ga`, `nr`, `sr`, `pnw`, `psw`, `ak`, `hi`, `pr`, `tpw`) and broader Americas/Pacific coordinates to Full Disk (`FD`).
  - Supports 5 satellite bands via `product` (or `layers`): `geocolor` (default), `visible` (Band 2), `infrared` (Band 13), `water_vapor` (Band 9), and `shortwave_infrared` (Band 7).
  - Parses timestamped filenames (`YYYYDDDHHMM_GOES19-ABI-...`) from the sector directory listing (cached 3 minutes) for both single latest snapshots and multi-frame animations.
- **Zero-Dependency PNG Compositor & MCP Image Content (`src/utils/pngComposite.ts`, `include_image: true`):**
  - When `include_image: true` is passed to `get_weather_imagery`, the tool attaches `{ type: 'image', data: base64, mimeType }` to the MCP tool response alongside the markdown text.
  - For `type: "radar"` / `"precipitation"`, `buildMcpImageContent` fetches the transparent radar PNG, composites it over the Esri Light Gray Canvas basemap + city/state reference labels, and draws a center location pin using Node's built-in `node:zlib` (`decodePngToRgba` / `encodeRgbaToPng` — zero native image library dependencies).
  - For `type: "satellite"`, `buildMcpImageContent` attaches the NOAA GOES JPEG (`image/jpeg`).
