# CLAUDE.md - AI Assistant Guide for Weather MCP Server

This document provides context and guidelines for AI assistants (Claude, etc.) working with this codebase.

## Project Overview

**Weather MCP Server** is a Model Context Protocol (MCP) server providing weather data from NOAA and Open-Meteo APIs. It enables AI assistants to fetch real-time weather forecasts, current conditions, historical data, air quality, marine conditions, severe weather alerts, wildfire tracking, river monitoring, lightning detection, and weather imagery. A built-in **web console** (`npm run web`) lets anyone run every MCP tool interactively in a browser — including a full **climate explorer** chart — without needing an AI client.

- **Language:** TypeScript (Node.js)
- **Version:** 1.7.0 (Production Ready)
- **License:** MIT
- **MCP SDK:** @modelcontextprotocol/sdk v1.21.1

## Architecture

### Core Components

```
src/
├── index.ts                    # MCP server entry point, tool registry
├── handlers/                   # Tool request handlers (one per MCP tool)
│   ├── forecastHandler.ts
│   ├── nomadsForecastHandler.ts        # Raw NOMADS/GFS model-run forecast
│   ├── modelComparisonHandler.ts       # Multi-model (GFS/NAM/HRRR/ECMWF proxy) comparison
│   ├── currentConditionsHandler.ts
│   ├── alertsHandler.ts
│   ├── historicalWeatherHandler.ts
│   ├── statusHandler.ts
│   ├── locationHandler.ts
│   ├── airQualityHandler.ts
│   ├── marineConditionsHandler.ts
│   ├── riverConditionsHandler.ts
│   ├── wildfireHandler.ts
│   ├── weatherImageryHandler.ts        # RainViewer radar/precipitation imagery
│   ├── lightningHandler.ts             # Blitzortung real-time lightning
│   └── savedLocationsHandler.ts        # Saved locations management (v1.7.0)
├── services/                   # External API clients
│   ├── noaa.ts                 # NOAA Weather API client (forecasts, alerts, NWPS river gauges)
│   ├── openmeteo.ts            # Open-Meteo API client (forecast, historical, air quality, marine,
│   │                           #   climate normals, daily temperature archive for climate explorer)
│   ├── nomads.ts               # NOMADS/NCEP model-run client (GFS, NAM, HRRR)
│   ├── modelComparison.ts      # Orchestrates multi-model comparison
│   ├── nominatim.ts            # Nominatim/OSM geocoding client (v1.7.0)
│   ├── locationStore.ts        # Saved locations storage service (v1.7.0)
│   ├── nifc.ts                 # NIFC wildfire ArcGIS API client
│   ├── usgs.ts                 # USGS water services client
│   ├── rainviewer.ts           # RainViewer radar imagery API client
│   └── blitzortung.ts          # Blitzortung.org MQTT lightning detection client
├── web/                        # Web console (browser UI + HTTP API)
│   └── server.ts               # Express server; drives real MCP server over stdio;
│                               #   serves /api/climate for the climate explorer
├── types/                      # TypeScript type definitions
│   ├── noaa.ts
│   ├── openmeteo.ts
│   ├── nomads.ts               # NOMADS model-run response types
│   ├── modelComparison.ts      # Model comparison request/response types
│   ├── nominatim.ts            # Nominatim API types (v1.7.0)
│   ├── savedLocations.ts       # Saved locations types (v1.7.0)
│   ├── imagery.ts              # Weather imagery types
│   ├── lightning.ts            # Lightning strike/safety types
│   └── wildfire.ts             # NIFC wildfire types
├── utils/                      # Shared utilities
│   ├── cache.ts                # LRU cache with TTL
│   ├── validation.ts           # Input validation
│   ├── units.ts                # Unit conversions
│   ├── logger.ts               # Structured logging (stderr only)
│   ├── requestLogger.ts        # MCP request lifecycle logging (start/end/duration)
│   ├── locationResolver.ts     # Location name/coordinate resolution (v1.7.0)
│   ├── airQuality.ts           # AQI calculations (US EPA + European EAQI)
│   ├── marine.ts               # Wave/ocean utilities + NOAA marine extraction
│   ├── fireWeather.ts          # Fire weather indices + contextual messaging
│   ├── distance.ts             # Haversine distance calculations
│   ├── geohash.ts              # Geohash encoding/decoding (for lightning)
│   ├── gribGrid.ts             # GRIB grid interpolation (NAM Lambert Conformal)
│   ├── climatology.ts          # Per-calendar-day percentile curves for climate explorer
│   ├── precipType.ts           # Precipitation type classification (NOAA + Open-Meteo)
│   ├── normals.ts              # Climate normals computation and formatting
│   ├── snow.ts                 # Snow/ice depth and forecast extraction
│   ├── timezone.ts             # Luxon-based timezone-aware formatting
│   ├── temperatureConversion.ts# °C ↔ °F helpers
│   ├── geography.ts            # Great Lakes / coastal bay geographic detection
│   └── version.ts              # Package version helper
├── config/                     # Configuration
│   ├── cache.ts                # Cache TTL settings + env-var parsing
│   ├── tools.ts                # Tool configuration (presets, aliases, ENABLED_TOOLS)
│   ├── api.ts                  # Optional API tokens (NCEI)
│   └── displayThresholds.ts    # Display logic constants
├── analytics/                  # Optional analytics middleware
└── errors/                     # Custom error classes
    └── ApiError.ts
web/
└── index.html                  # Single-page web console (all views, no build step)
tests/
├── unit/                       # Unit tests (fast, no I/O)
└── integration/                # Integration tests (live API calls)
```

### Design Patterns

1. **Handler Pattern:** Each MCP tool has a dedicated handler function in `src/handlers/`
2. **Service Layer:** API clients are abstracted into service classes with retry logic and caching
3. **Validation First:** All user inputs validated before processing (see `src/utils/validation.ts`)
4. **Caching Strategy:** LRU cache with TTL based on data volatility (see `src/config/cache.ts`)
5. **Error Hierarchy:** Custom error classes for different failure scenarios (`src/errors/ApiError.ts`)
6. **Saved-Location Injection:** `applySavedLocation()` in `src/index.ts` swaps `location_name` for coordinates before handlers run, so most handlers need no special logic
7. **Web Console Pattern:** `src/web/server.ts` spawns `dist/index.js` as a child process and communicates via MCP stdio — the browser UI talks to the **real** MCP server, not a mock

## Key Features (18 MCP Tools)

1. **get_forecast** - Up to 16-day forecasts (NOAA/Open-Meteo auto-select by location); precipitation type; climate normals; snow/ice; timezone-aware output
2. **get_forecast_nomads** - Raw forecast from the latest NOMADS/NCEP GFS model run (global)
3. **get_model_comparison_forecast** - Compare GFS, NAM, HRRR (NOMADS) and ECMWF proxy (Open-Meteo) side by side; HRRR is CONUS-only and opt-in
4. **get_current_conditions** - Current weather + optional fire weather indices (NOAA, US only); climate normals; snow depth
5. **get_alerts** - Weather alerts/warnings (NOAA, US only)
6. **get_historical_weather** - Historical data 1940-present (Open-Meteo, global); recent 7 days via NOAA (US only)
7. **check_service_status** - API health check + cache statistics
8. **search_location** - Location search/geocoding (Nominatim/OSM)
9. **get_air_quality** - AQI + pollutants + UV index (Open-Meteo, global)
10. **get_marine_conditions** - Wave height, swell, currents; auto-selects NOAA for Great Lakes/coastal bays, Open-Meteo for oceans
11. **get_weather_imagery** - Precipitation radar / animated loops (RainViewer, global)
12. **get_lightning_activity** - Real-time lightning detection (Blitzortung.org, global)
13. **get_river_conditions** - River levels and flood monitoring (NOAA NWPS + USGS, US only)
14. **get_wildfire_info** - Active wildfire tracking (NIFC WFIGS, US only)
15. **save_location** - Save a location with an alias; auto-geocodes via Nominatim (v1.7.0)
16. **list_saved_locations** - List all saved locations (v1.7.0)
17. **get_saved_location** - Get details for a specific saved location (v1.7.0)
18. **remove_saved_location** - Delete a saved location (v1.7.0)

## Web Console

Run with:
```bash
npm run web          # builds TypeScript then starts the server
```
Then open **http://127.0.0.1:8787**.

### Architecture

`src/web/server.ts` is an Express HTTP server that:
1. Spawns `dist/index.js` as a child process (stdin/stdout pipe)
2. Forwards every `/api/tool` POST as an MCP `tools/call` JSON-RPC message
3. Returns the raw MCP response to the browser
4. Serves the `web/index.html` single-page app as a static file
5. Adds a dedicated `GET /api/climate` endpoint for the climate explorer (see below)

`web/index.html` is a self-contained SPA (vanilla JS, no build step, ~87 KB):
- Builds forms dynamically from each tool's JSON schema
- **Location helpers:** saved-location picker, name search, browser geolocation
- **Radar view:** RainViewer tiles drawn over a Leaflet basemap (state lines, roads, city labels); drag/zoom; pin at your location
- **Climate Explorer view:** WeatherSpark-style interactive temperature chart (see below)

Security: the server binds to `127.0.0.1` only and validates `Origin` / `Host` headers to block cross-site requests.

### Climate Explorer

`GET /api/climate?latitude=&longitude=&baseline=` returns:
- Full daily high/low/precipitation series since 1940 (from `OpenMeteoService.getDailyTemperatureRecord`)
- Per-calendar-day percentile curves (0th–100th in 5% steps) computed by `src/utils/climatology.ts`
- 30-year baseline means, precipitation normals, and record highs/lows

`src/utils/climatology.ts` computes climatology by:
- Pooling ±7 days around each calendar day across all baseline years
- Computing 0–100th percentile in 5% steps using linear interpolation
- Applying a 5-day rolling average to smooth the curves
- Handling leap-year day (Feb 29) by including Feb 28 and Mar 1 neighbors

`web/index.html` climate explorer features:
- Gray range bars with high/low ticks over 25–75th and 10–90th percentile bands
- Average temperature lines (mean high / mean low)
- Optional record overlay and record-set markers
- Precipitation strip (bars below x-axis)
- °F / °C toggle
- Year / month stepping, "last 12 months" mode
- Drag-to-zoom with click-to-reset
- Keyboard navigation (arrow keys for day stepping)
- Hover tooltip with percentile rank of the hovered day's temperature
- Pointer-following temperature guide line
- Summary tiles: warmest day, coldest day, wettest day, total precip for the visible range
- Only the chart and tiles redraw on view changes (not the full card)

### Environment Variables (web console)
- `WEB_PORT` — HTTP port (default `8787`)
- `ENABLED_TOOLS` — which MCP tools to expose (defaults to `all` in web mode)

## Development Guidelines

### Code Style

- **TypeScript Strict Mode:** All strict flags enabled (see `tsconfig.json`)
- **No `any` types:** Use proper typing or `unknown` with validation
- **Explicit returns:** All functions must return on all code paths
- **No unused variables:** Compiler enforces `noUnusedLocals` and `noUnusedParameters`
- **Logs to stderr only:** MCP protocol requirement; never log to stdout

### Adding New Features

1. **Types First:** Define TypeScript interfaces in `src/types/`
2. **Validation:** Add validators to `src/utils/validation.ts`
3. **Handler:** Create handler in `src/handlers/` following existing patterns
4. **Service (if needed):** Add API methods to the relevant service in `src/services/`
5. **Tool Registration:** Register in `src/index.ts` (both `ListToolsRequestSchema` and `CallToolRequestSchema`)
6. **Saved Location Support:** Add `location_name` to the tool schema and either add it to `SAVED_LOCATION_TOOLS` in `src/index.ts` or call `resolveLocation()` in the handler
7. **Tests:** Write comprehensive unit + integration tests
8. **Documentation:** Update `README.md`, `CHANGELOG.md`, and this file

### Error Handling

Always use custom error classes from `src/errors/ApiError.ts`:

```typescript
import { InvalidLocationError, RateLimitError, ServiceUnavailableError } from '../errors/ApiError.js';

// Bad
throw new Error('Invalid coordinates');

// Good
throw new InvalidLocationError('NOAA', 'Coordinates outside US coverage');
```

**Security:** All errors are sanitized via `formatErrorForUser()` before returning to users.

### Logging

Use structured logging from `src/utils/logger.ts`:

```typescript
import { logger } from '../utils/logger.js';

// Security events
logger.warn('Rate limit exceeded', { service: 'NOAA', securityEvent: true });

// General logging
logger.info('Cache hit', { key: cacheKey });
logger.error('API request failed', { error: err.message });
```

Request lifecycle logging (start/end/duration) is handled automatically by `src/utils/requestLogger.ts`.

**Important:** All logs go to `stderr`. Never log to `stdout`.

## Testing

### Test Structure

```
tests/
├── unit/                               # Unit tests (fast, no I/O)
│   ├── cache.test.ts                   # LRU cache
│   ├── validation.test.ts              # Input validation
│   ├── units.test.ts                   # Unit conversions
│   ├── errors.test.ts                  # Error classes
│   ├── config.test.ts                  # Cache + tool configuration
│   ├── tool-config.test.ts             # ENABLED_TOOLS parsing and aliases
│   ├── retry-logic.test.ts             # Exponential backoff
│   ├── security.test.ts                # Security validation (coord redaction, markdown injection)
│   ├── security-v1.6.test.ts           # v1.6.0 security boundaries (MQTT buffer, radius clamping)
│   ├── v1.6.1-fixes.test.ts            # v1.6.1 specific regression tests
│   ├── bounds-checking.test.ts         # Array bounds / resource exhaustion limits
│   ├── alert-sorting.test.ts           # Alert severity sorting
│   ├── distance.test.ts                # Haversine distance calculations
│   ├── geohash.test.ts                 # Geohash encoding/decoding
│   ├── geohash-neighbors.test.ts       # Geohash neighbor API
│   ├── gribGrid.test.ts                # GRIB grid (NAM Lambert Conformal)
│   ├── geography.test.ts               # Great Lakes / coastal bay detection
│   ├── airQuality.test.ts              # AQI calculations (US + European, health-critical)
│   ├── fireWeather.test.ts             # Fire danger indices (safety-critical)
│   ├── fireWeatherContext.test.ts      # Contextual fire weather messaging
│   ├── normals.test.ts                 # Climate normals computation
│   ├── snow.test.ts                    # Snow/ice extraction
│   ├── timezone.test.ts                # Timezone-aware formatting
│   ├── precip-type.test.ts             # Precipitation type classification
│   ├── climatology.test.ts             # Per-calendar-day percentile curves
│   ├── imagery-handler.test.ts         # Weather imagery handler
│   ├── lightning-handler.test.ts       # Lightning handler
│   ├── rainviewer.test.ts              # RainViewer tile calculations
│   ├── location-resolver.test.ts       # Location resolver
│   ├── saved-locations-activities.test.ts  # Saved locations + activity tags
│   ├── nomads-hrrr-domain.test.ts      # HRRR CONUS bounding box
│   └── ncei.test.ts                    # NCEI service
└── integration/                        # Integration tests (live API calls)
    ├── error-recovery.test.ts
    ├── great-lakes-marine.test.ts
    ├── safety-hazards.test.ts          # River conditions + wildfire
    └── visualization-lightning.test.ts # Imagery + lightning
```

### Testing Requirements

- **Framework:** Vitest (configured in `vitest.config.ts`)
- **Coverage Target:** 100% on critical utilities (cache, validation, units, errors, AQI, fire weather)
- **Performance:** All unit tests must complete in < 2 seconds
- **No Flakiness:** Tests must be deterministic; timezone-sensitive tests pin Luxon's zone to UTC+14

### Running Tests

```bash
npm test                    # Run all tests
npm run test:watch          # Watch mode
npm run test:coverage       # With coverage report
npm run test:ui             # Vitest UI
```

### Writing Tests

Follow existing patterns in `tests/unit/`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';

describe('FeatureName', () => {
  it('should handle normal case', () => {
    const result = myFunction(input);
    expect(result).toBe('expected');
  });

  it('should handle edge case', () => {
    // Test nulls, empty values, boundaries
  });
});
```

## Security Considerations

### Input Validation

**All user inputs must be validated** using functions from `src/utils/validation.ts`:

```typescript
import { validateLatitude, validateLongitude } from '../utils/validation.js';

validateLatitude(latitude);    // Throws InvalidLocationError if invalid
validateLongitude(longitude);
```

### Coordinate Privacy

Coordinates are **redacted in logs** (rounded to ~1.1 km, 2 decimal places) via `redactCoordinatesForLogging()`. Set `LOG_PII=true` to enable full-precision logging (not recommended for production).

### Markdown Injection Prevention

Location names and user-supplied strings are sanitized via `escapeMarkdown()` before being included in MCP responses to prevent injection of malicious Markdown links or images.

### Security Event Logging

Log security-relevant events with `securityEvent: true`:

```typescript
logger.warn('Invalid request parameters', { service: 'NOAA', status: 400, securityEvent: true });
```

### Bounds Checking

Defense-in-depth: array processing is capped to prevent resource exhaustion:
- MQTT lightning buffer: 10,000 strikes max
- Geohash tile generation: 10,000 tiles max
- Radius parameters: clamped to 1–500 km
- Gridpoint series: capped at `maxEntries`

### Web Console Security

- Server binds to `127.0.0.1` only (no external exposure)
- `Origin` and `Host` header validation blocks cross-site requests from pages you visit elsewhere
- All tool calls pass through the same input validation as the MCP server

### No Hardcoded Secrets

- No API keys required (all APIs are public)
- Use environment variables for optional tokens (e.g., `NCEI_API_TOKEN`)
- Never commit `.env` files

## Configuration

### Environment Variables

```bash
# Tool Selection
ENABLED_TOOLS=all                # Preset or comma-separated list (default: basic)

# Cache Configuration
CACHE_ENABLED=true               # Enable/disable caching (default: true)
CACHE_MAX_SIZE=1000              # Max cache entries (100-10000, default: 1000)

# API Configuration
API_TIMEOUT_MS=30000             # API timeout in ms (5000-120000, default: 30000)

# Logging
LOG_LEVEL=1                      # 0=DEBUG, 1=INFO, 2=WARN, 3=ERROR (default: 1)
LOG_PII=false                    # Enable full-precision coordinate logging (default: false)

# Optional API Tokens
NCEI_API_TOKEN=                  # Free NOAA NCEI token for official US climate normals

# Lightning
BLITZORTUNG_MQTT_URL=            # Override MQTT broker URL (default: public Blitzortung broker)

# Web Console
WEB_PORT=8787                    # Web console port (default: 8787)
```

### Tool Presets

| Preset | Tools |
|--------|-------|
| `basic` (default) | get_forecast, get_current_conditions, get_alerts, search_location, check_service_status, save_location, list_saved_locations, get_saved_location, remove_saved_location (9 tools) |
| `standard` | basic + get_historical_weather (10 tools) |
| `full` | standard + get_air_quality (11 tools) |
| `all` | All 18 tools |

Flexible syntax: `ENABLED_TOOLS=basic,+historical,+air_quality` or `ENABLED_TOOLS=all,-marine`.

## Caching Strategy

### TTL Values (defined in `src/config/cache.ts`)

| Data Type | TTL |
|-----------|-----|
| Grid coordinates | ∞ (never change) |
| Location searches | 30 days |
| Weather stations | 24 hours |
| Climate normals | ∞ (static historical data) |
| Daily temperature archive (climate explorer) | ∞ (finalized data) |
| Forecasts | 2 hours |
| Marine conditions | 1 hour |
| Air quality | 1 hour |
| Fire weather (gridpoint) | 2 hours |
| River conditions | 1 hour |
| Current conditions | 15 minutes |
| Weather imagery (radar) | 15 minutes |
| Alerts | 5 minutes |
| Lightning strikes | 5 minutes |
| Wildfire information | 30 minutes |
| Historical data (> 1 day old) | ∞ (finalized) |
| Recent historical (< 1 day) | 1 hour |

### Cache Implementation

- **Algorithm:** LRU (Least Recently Used) eviction
- **Size limits:** Configurable max size (default 1000 entries)
- **Automatic cleanup:** Every 5 minutes
- **Graceful shutdown:** Cleanup on SIGTERM/SIGINT

## Saved Locations Feature (v1.7.0)

### Architecture

- `LocationStore` service (`src/services/locationStore.ts`) — persistent JSON storage at `~/.weather-mcp/locations.json`
- `locationResolver` utility (`src/utils/locationResolver.ts`) — resolves `location_name` → coordinates
- `savedLocationsHandler` (`src/handlers/savedLocationsHandler.ts`) — save/list/get/remove operations
- `nominatim` service (`src/services/nominatim.ts`) — geocodes location queries at ≤1 req/sec

### Adding `location_name` Support to a New Tool

For most handlers, simply add the tool name to `SAVED_LOCATION_TOOLS` in `src/index.ts`. The `applySavedLocation()` middleware will inject coordinates before the handler runs. For handlers that need to resolve the name themselves (e.g., NOMADS):

```typescript
import { resolveLocation } from '../utils/locationResolver.js';
import { LocationStore } from '../services/locationStore.js';

const { latitude, longitude } = resolveLocation(args as YourToolArgs, locationStore);
```

Then update the tool schema: add `location_name` and remove `latitude`/`longitude` from `required`.

### Storage Format

`~/.weather-mcp/locations.json`:
```json
{
  "home": {
    "name": "Seattle, WA",
    "latitude": 47.6062,
    "longitude": -122.3321,
    "timezone": "America/Los_Angeles",
    "country_code": "US",
    "admin1": "Washington",
    "saved_at": "2025-01-15T10:30:00.000Z",
    "updated_at": "2025-01-15T10:30:00.000Z"
  },
  "cabin": {
    "name": "Lake Tahoe, CA",
    "latitude": 39.0968,
    "longitude": -120.0324,
    "timezone": "America/Los_Angeles",
    "country_code": "US",
    "admin1": "California",
    "activities": ["boating", "fishing", "hiking"],
    "saved_at": "2025-01-15T11:00:00.000Z",
    "updated_at": "2025-01-15T11:00:00.000Z"
  }
}
```

**Smart Updates:** If the alias exists and no location details are provided, only `name` and/or `activities` are updated; all coordinates and metadata are preserved.

## NOMADS / Model Comparison Features

### get_forecast_nomads

Fetches a deterministic forecast directly from the latest NOMADS/NCEP GFS model run. Returns daily high/low temperature, precipitation chance/total, peak wind, and average cloud cover. Global coverage.

### get_model_comparison_forecast

Compares GFS, NAM, and ECMWF proxy (Open-Meteo) side by side for the same location/date range.

- **HRRR (opt-in):** 3 km CONUS-only model; only the synoptic cycles (00/06/12/18Z) that post a full 48h horizon are used. Requests outside CONUS are rejected with a clear error. Values beyond the ~48h deterministic horizon are marked N/A.
- **NAM:** Lambert Conformal Conic grid; nearest-value extraction handled by `src/utils/gribGrid.ts` (correct curvilinear grid math).
- **Per-model horizon handling:** each model's values are marked N/A beyond its deterministic horizon.

## Common Tasks

### Adding a New MCP Tool

1. Create handler: `src/handlers/newFeatureHandler.ts`
2. Define types: `src/types/`
3. Add service method if needed: `src/services/`
4. Register in `src/index.ts` (ListTools + CallTool handlers)
5. Add `location_name` support: either add to `SAVED_LOCATION_TOOLS` or call `resolveLocation()` in handler
6. Write tests: `tests/unit/` and `tests/integration/`
7. Update `README.md`, `CHANGELOG.md`, and this file

### Adding a Climate Explorer Data Source

The `/api/climate` endpoint in `src/web/server.ts` calls `OpenMeteoService.getDailyTemperatureRecord()` for the full archive, then passes it to `computeClimatology()` from `src/utils/climatology.ts`. To add a new data source or extend the climatology (e.g., wind normals), update those two files and the relevant section of `web/index.html`.

### Debugging

```bash
# Run MCP server in development mode
npm run dev

# Run web console in development mode
npm run web

# Enable debug logging
LOG_LEVEL=0 npm run web

# Run specific test
npx vitest run tests/unit/climatology.test.ts

# Build and check for errors
npm run build
```

## Code Quality Standards

### Must Pass Before Commit

```bash
npm run build          # TypeScript compilation (0 errors)
npm test               # All tests passing (100%)
npm audit              # No critical vulnerabilities
```

### Code Review Checklist

- [ ] TypeScript strict mode compliance
- [ ] Input validation on all user-facing functions
- [ ] Error handling with custom error classes
- [ ] Security event logging where appropriate
- [ ] Coordinate redaction in any new log statements
- [ ] Tests for new functionality (unit + integration)
- [ ] Documentation updated (README, CHANGELOG, CLAUDE.md)
- [ ] No `console.log` (use logger instead)
- [ ] No hardcoded values (use `config/`)
- [ ] Web console forms still work if tool schema changed

## Project Status

- **Version:** 1.7.0 + Unreleased features (see CHANGELOG.md [Unreleased] section)
- **Status:** Production Ready ✅
- **Unreleased additions:** Web console, climate explorer, NOMADS/HRRR model forecasts, multi-model comparison, precipitation type classification, request lifecycle logging, NAM grid fix, timezone correctness fixes
- **Security Rating:** A- (Excellent, 93/100)
- **Test Coverage:** 1,060+ tests, 100% pass rate
- **Code Quality:** A+ (Excellent, 97.5/100)

## Commit Conventions

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: Add new feature
fix: Bug fix
perf: Performance improvement
refactor: Code refactoring
test: Add/update tests
docs: Documentation changes
chore: Tooling, dependencies, etc.
security: Security improvements
```

## Useful References

- **MCP Specification:** https://spec.modelcontextprotocol.io/
- **NOAA API Docs:** https://www.weather.gov/documentation/services-web-api
- **Open-Meteo Docs:** https://open-meteo.com/en/docs
- **NOMADS/NCEP:** https://nomads.ncep.noaa.gov/
- **Blitzortung:** https://www.blitzortung.org/
- **RainViewer API:** https://www.rainviewer.com/api.html
- **NIFC WFIGS:** https://data-nifc.opendata.arcgis.com/
- **Project Docs:**
  - `README.md` — User-facing documentation
  - `CHANGELOG.md` — Version history
  - `docs/development/CODE_REVIEW.md` — Code quality assessment
  - `docs/development/SECURITY_AUDIT_V1.6.md` — Security analysis

## Getting Help

- **Issues:** https://github.com/weather-mcp/weather-mcp/issues
- **Discussions:** Use GitHub Discussions for questions
- **Security:** See `SECURITY.md` for vulnerability reporting

---

**Last Updated:** 2026-09-29 (Unreleased — web console + climate explorer, NOMADS/HRRR model forecasts, precipitation type, request lifecycle logging, NAM grid/timezone fixes)

This document should be updated whenever major architectural changes are made or new patterns are introduced.
