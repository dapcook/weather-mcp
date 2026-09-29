/**
 * Weather MCP Server: tool registry, handlers, and shared services.
 *
 * This module has no side effects on import. Entry points create the services
 * once and then build MCP servers from them:
 * - src/index.ts: stdio transport (AI clients that launch the server locally)
 * - src/web/server.ts: HTTP /mcp endpoint and the web console
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { NOAAService } from './services/noaa.js';
import { OpenMeteoService } from './services/openmeteo.js';
import { NominatimService } from './services/nominatim.js';
import { NCEIService } from './services/ncei.js';
import { NIFCService } from './services/nifc.js';
import { NOMADSService } from './services/nomads.js';
import { ModelComparisonService } from './services/modelComparison.js';
import { GeocodingService } from './services/geocoding.js';
import { LocationStore } from './services/locationStore.js';
import { toolConfig } from './config/tools.js';
import { logger } from './utils/logger.js';
import { formatErrorForUser } from './errors/ApiError.js';
import { handleGetForecast } from './handlers/forecastHandler.js';
import { handleGetCurrentConditions } from './handlers/currentConditionsHandler.js';
import { handleGetAlerts } from './handlers/alertsHandler.js';
import { handleGetHistoricalWeather } from './handlers/historicalWeatherHandler.js';
import { handleCheckServiceStatus } from './handlers/statusHandler.js';
import { handleSearchLocation } from './handlers/locationHandler.js';
import { handleGetAirQuality } from './handlers/airQualityHandler.js';
import { handleGetMarineConditions } from './handlers/marineConditionsHandler.js';
import { getWeatherImagery, formatWeatherImageryResponse } from './handlers/weatherImageryHandler.js';
import { getLightningActivity, formatLightningActivityResponse } from './handlers/lightningHandler.js';
import { handleGetRiverConditions } from './handlers/riverConditionsHandler.js';
import { handleGetWildfireInfo } from './handlers/wildfireHandler.js';
import {
  handleSaveLocation,
  handleListSavedLocations,
  handleGetSavedLocation,
  handleRemoveSavedLocation
} from './handlers/savedLocationsHandler.js';
import { handleGetNomadsForecast } from './handlers/nomadsForecastHandler.js';
import { handleGetModelComparisonForecast } from './handlers/modelComparisonHandler.js';
import { withAnalytics, analytics } from './analytics/index.js';
import { randomUUID } from 'crypto';
import { logRequestLifecycle } from './utils/requestLogger.js';
import { applySavedLocation } from './utils/locationResolver.js';

/**
 * Server information
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Read version from package.json to ensure single source of truth
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(
  readFileSync(join(__dirname, '../package.json'), 'utf-8')
);

export const SERVER_NAME = 'weather-mcp';
export const SERVER_VERSION: string = packageJson.version;

/**
 * Redact sensitive fields from tool arguments before logging
 * Removes PII like coordinates, location names, addresses
 */
function redactSensitiveFields(args: unknown): unknown {
  if (typeof args !== 'object' || args === null) {
    return args;
  }

  const redacted: Record<string, unknown> = {};
  const sensitiveFields = [
    'latitude', 'longitude', 'lat', 'lon',
    'location', 'city', 'state', 'address', 'query',
    'zipcode', 'postalCode', 'place', 'coordinates'
  ];

  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (sensitiveFields.includes(key)) {
      redacted[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      redacted[key] = redactSensitiveFields(value);
    } else {
      redacted[key] = value;
    }
  }

  return redacted;
}

/**
 * Services shared by every MCP server instance in a process (caches, rate
 * limiters, and the saved-locations store live here).
 */
export interface WeatherServices {
  noaaService: NOAAService;
  openMeteoService: OpenMeteoService;
  nominatimService: NominatimService;
  locationStore: LocationStore;
  nceiService: NCEIService;
  nomadsService: NOMADSService;
  modelComparisonService: ModelComparisonService;
  nifcService: NIFCService;
  geocodingService: GeocodingService;
}

export interface WeatherServicesOptions {
  /** Path to the saved-locations JSON file (default: from WEATHER_MCP_DATA_DIR, else ~/.weather-mcp/locations.json) */
  locationsPath?: string;
}

/**
 * Where saved locations are stored. WEATHER_MCP_DATA_DIR lets a container keep
 * them on a mounted volume; otherwise LocationStore's default (~/.weather-mcp).
 */
export function resolveLocationsPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dataDir = env.WEATHER_MCP_DATA_DIR?.trim();
  return dataDir ? join(dataDir, 'locations.json') : undefined;
}

export function createServices(options: WeatherServicesOptions = {}): WeatherServices {
  const userAgent = `weather-mcp/${SERVER_VERSION} (https://github.com/weather-mcp/weather-mcp)`;
  const openMeteoService = new OpenMeteoService();
  const nomadsService = new NOMADSService({ userAgent });

  return {
    // NOAA requires an identifying User-Agent
    noaaService: new NOAAService({ userAgent }),
    // Open-Meteo: forecasts, historical, air quality, marine (no API key)
    openMeteoService,
    // Nominatim/OSM geocoding for save_location (rate limited to 1 req/sec per OSM policy)
    nominatimService: new NominatimService(),
    // Saved/favorite locations (JSON file)
    locationStore: new LocationStore(options.locationsPath ?? resolveLocationsPath()),
    // NCEI climate normals (optional token; falls back to Open-Meteo)
    nceiService: new NCEIService(),
    // NCEP model runs (GFS, NAM, HRRR) from the public NOMADS filter endpoint
    nomadsService,
    // Side-by-side GFS/NAM/HRRR/ECMWF-proxy comparison
    modelComparisonService: new ModelComparisonService(nomadsService, openMeteoService),
    // NIFC wildfire data (public ArcGIS REST API)
    nifcService: new NIFCService(),
    // Multi-provider geocoding for search_location (Census.gov, Nominatim, Open-Meteo)
    geocodingService: new GeocodingService(),
  };
}

/**
 * Release service resources on shutdown: flush analytics, clear caches.
 */
export async function shutdownServices(services: WeatherServices): Promise<void> {
  await analytics.shutdown();
  services.noaaService.clearCache();
  services.openMeteoService.clearCache();
}

/**
 * Tool definitions - each tool defined separately for conditional registration
 */
const TOOL_DEFINITIONS = {
  get_forecast: {
    name: 'get_forecast' as const,
    description: 'Get future weather forecast for a location (global coverage). Use this for upcoming weather predictions (e.g., "tomorrow", "this week", "next 7 days", "hourly forecast"). Returns forecast data including temperature, precipitation, wind, conditions, and sunrise/sunset times. Supports both daily and hourly granularity. Automatically selects best data source: NOAA for US locations (more detailed), Open-Meteo for international locations. For current weather, use get_current_conditions. For past weather, use get_historical_weather. Can use either coordinates OR a saved location name (e.g., location_name="home"). If this tool returns an error, check the error message for status page links and consider using check_service_status to verify API availability.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        latitude: {
          type: 'number' as const,
          description: 'Latitude of the location (-90 to 90). Not required if location_name is provided.',
          minimum: -90,
          maximum: 90
        },
        longitude: {
          type: 'number' as const,
          description: 'Longitude of the location (-180 to 180). Not required if location_name is provided.',
          minimum: -180,
          maximum: 180
        },
        location_name: {
          type: 'string' as const,
          description: 'Name of a saved location (e.g., "home", "cabin"). Use this instead of latitude/longitude to reference a saved location. List saved locations with list_saved_locations.'
        },
        days: {
          type: 'number' as const,
          description: 'Number of days to include in forecast (1-16 for global, 1-7 for US NOAA, default: 7)',
          minimum: 1,
          maximum: 16,
          default: 7
        },
        granularity: {
          type: 'string' as const,
          description: 'Forecast granularity: "daily" for day/night periods or "hourly" for hour-by-hour detail (default: "daily")',
          enum: ['daily', 'hourly'],
          default: 'daily'
        },
        include_precipitation_probability: {
          type: 'boolean' as const,
          description: 'Include precipitation probability in the forecast output (default: true)',
          default: true
        },
        include_severe_weather: {
          type: 'boolean' as const,
          description: 'Include severe weather probabilities such as thunderstorm chance, wind gust probabilities, and tropical storm/hurricane risks (default: false, US/NOAA only)',
          default: false
        },
        include_normals: {
          type: 'boolean' as const,
          description: 'Include climate normals (30-year averages) for comparison with forecasted temperatures (default: false, daily forecasts only). Shows normal high/low and departure from normal for the first forecast day.',
          default: false
        },
        source: {
          type: 'string' as const,
          description: 'Data source: "auto" (default), "noaa" (US only), "openmeteo" (global), or "nomads" (NCEP GFS model run, global)',
          enum: ['auto', 'noaa', 'openmeteo', 'nomads'],
          default: 'auto'
        }
      },
      required: []
    }
  },

  get_forecast_nomads: {
    name: 'get_forecast_nomads' as const,
    description: 'Get a forecast from the latest NOMADS/NCEP GFS model run. Returns daily high/low temperatures, derived precipitation chance, precipitation totals, and extra wind/humidity context. Use this when users ask for model-run based output specifically from NCEP/NOMADS.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        latitude: {
          type: 'number' as const,
          description: 'Latitude of the location (-90 to 90). Not required if location_name is provided.',
          minimum: -90,
          maximum: 90
        },
        longitude: {
          type: 'number' as const,
          description: 'Longitude of the location (-180 to 180). Not required if location_name is provided.',
          minimum: -180,
          maximum: 180
        },
        location_name: {
          type: 'string' as const,
          description: 'Name of a saved location (e.g., "home", "cabin"). Use this instead of latitude/longitude.'
        },
        days: {
          type: 'number' as const,
          description: 'Number of days to include in forecast (1-10, default: 7)',
          minimum: 1,
          maximum: 10,
          default: 7
        }
      },
      required: []
    }
  },

  get_model_comparison_forecast: {
    name: 'get_model_comparison_forecast' as const,
    description: 'Compare forecasts across multiple model sources in one response. Supports GFS (NOMADS), NAM (NOMADS, ~84h deterministic horizon), HRRR (NOMADS, CONUS-only, ~48h deterministic horizon), and ECMWF proxy guidance via Open-Meteo. For requests beyond a model\'s horizon, its values are shown through the horizon and then marked as N/A. HRRR requests outside the continental US will fail — use GFS or NAM for those locations.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        latitude: {
          type: 'number' as const,
          description: 'Latitude of the location (-90 to 90). Not required if location_name is provided.',
          minimum: -90,
          maximum: 90
        },
        longitude: {
          type: 'number' as const,
          description: 'Longitude of the location (-180 to 180). Not required if location_name is provided.',
          minimum: -180,
          maximum: 180
        },
        location_name: {
          type: 'string' as const,
          description: 'Name of a saved location (e.g., "home", "cabin"). Use this instead of latitude/longitude.'
        },
        days: {
          type: 'number' as const,
          description: 'Number of forecast days to compare (1-10, default: 7). NAM deterministic data is limited to about 84 hours.',
          minimum: 1,
          maximum: 10,
          default: 7
        },
        models: {
          type: 'array' as const,
          description: 'Models to include. Defaults to ["gfs", "nam", "ecmwf_proxy"]. You may also pass "ecmwf" and it will map to "ecmwf_proxy". "hrrr" is opt-in only (not part of the default set) since it is CONUS-only.',
          items: {
            type: 'string' as const,
            enum: ['gfs', 'nam', 'hrrr', 'ecmwf_proxy', 'ecmwf']
          }
        }
      },
      required: []
    }
  },

  get_current_conditions: {
    name: 'get_current_conditions' as const,
    description: 'Get the most recent weather observation for a location (US only). Use this for current weather or when asking about "today\'s weather", "right now", or recent conditions without a specific historical date range. Returns the latest observation from the nearest weather station. Optionally includes fire weather indices (Haines Index, Grassland Fire Danger, Red Flag Threat) when requested. For specific past dates or date ranges, use get_historical_weather instead. If this tool returns an error, check the error message for status page links and consider using check_service_status to verify API availability.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        latitude: {
          type: 'number' as const,
          description: 'Latitude of the location (-90 to 90). Not required if location_name is provided.',
          minimum: -90,
          maximum: 90
        },
        longitude: {
          type: 'number' as const,
          description: 'Longitude of the location (-180 to 180). Not required if location_name is provided.',
          minimum: -180,
          maximum: 180
        },
        location_name: {
          type: 'string' as const,
          description: 'Name of a saved location (e.g., "home", "cabin"). Use this instead of latitude/longitude.'
        },
        include_fire_weather: {
          type: 'boolean' as const,
          description: 'Include fire weather indices (Haines Index, Grassland Fire Danger, Red Flag Threat) in the response (default: false, US only)',
          default: false
        },
        include_normals: {
          type: 'boolean' as const,
          description: 'Include climate normals (30-year averages) for comparison with current conditions (default: false). Shows normal high/low temperatures and precipitation, with departure from normal.',
          default: false
        }
      },
      required: []
    }
  },

  get_alerts: {
    name: 'get_alerts' as const,
    description: 'Get active weather alerts, watches, warnings, and advisories for a location (US only). Use this for safety-critical weather information when asked about "any alerts?", "weather warnings?", "is it safe?", "dangerous weather?", or "weather watches?". Returns severity, urgency, certainty, effective/expiration times, and affected areas. For forecast data, use get_forecast instead. If this tool returns an error, check the error message for status page links and consider using check_service_status to verify API availability.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        latitude: {
          type: 'number' as const,
          description: 'Latitude of the location (-90 to 90). Not required if location_name is provided.',
          minimum: -90,
          maximum: 90
        },
        longitude: {
          type: 'number' as const,
          description: 'Longitude of the location (-180 to 180). Not required if location_name is provided.',
          minimum: -180,
          maximum: 180
        },
        location_name: {
          type: 'string' as const,
          description: 'Name of a saved location (e.g., "home", "cabin"). Use this instead of latitude/longitude.'
        },
        active_only: {
          type: 'boolean' as const,
          description: 'Whether to show only active alerts (default: true)',
          default: true
        }
      },
      required: []
    }
  },

  get_historical_weather: {
    name: 'get_historical_weather' as const,
    description: 'Get historical weather data for a specific date range in the past. Use this when the user asks about weather on specific past dates (e.g., "yesterday", "last week", "November 4, 2024", "30 years ago"). Automatically uses NOAA API for recent dates (last 7 days, US only) or Open-Meteo API for older dates (worldwide, back to 1940). Do NOT use for current conditions - use get_current_conditions instead. If this tool returns an error, check the error message for status page links and consider using check_service_status to verify API availability.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        latitude: {
          type: 'number' as const,
          description: 'Latitude of the location (-90 to 90). Not required if location_name is provided.',
          minimum: -90,
          maximum: 90
        },
        longitude: {
          type: 'number' as const,
          description: 'Longitude of the location (-180 to 180). Not required if location_name is provided.',
          minimum: -180,
          maximum: 180
        },
        location_name: {
          type: 'string' as const,
          description: 'Name of a saved location (e.g., "home", "cabin"). Use this instead of latitude/longitude.'
        },
        start_date: {
          type: 'string' as const,
          description: 'Start date in ISO format (YYYY-MM-DD or ISO 8601 datetime)',
        },
        end_date: {
          type: 'string' as const,
          description: 'End date in ISO format (YYYY-MM-DD or ISO 8601 datetime)',
        },
        limit: {
          type: 'number' as const,
          description: 'Maximum number of observations to return (default: 168 for one week of hourly data)',
          minimum: 1,
          maximum: 500,
          default: 168
        }
      },
      required: ['start_date', 'end_date']
    }
  },

  check_service_status: {
    name: 'check_service_status' as const,
    description: 'Check the operational status of the NOAA and Open-Meteo weather APIs. Use this when experiencing errors or to proactively verify service availability before making weather data requests. Returns current status, helpful messages, and links to official status pages.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: []
    }
  },

  search_location: {
    name: 'search_location' as const,
    description: 'Search for locations by name to get coordinates for weather queries. Uses Nominatim (OpenStreetMap) for excellent coverage of cities, towns, villages, and hamlets worldwide. Use this when the user provides a location name instead of coordinates (e.g., "Paris", "New York", "Tokyo", "San Francisco, CA", "Small Village, County"). Returns location matches with coordinates, timezone, elevation, and other metadata. Enables natural language location queries like "What\'s the weather in Paris?" by converting location names to coordinates.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string' as const,
          description: 'Location name to search for (e.g., "Paris", "New York, NY", "Tokyo")'
        },
        limit: {
          type: 'number' as const,
          description: 'Maximum number of results to return (1-100, default: 5)',
          minimum: 1,
          maximum: 100,
          default: 5
        }
      },
      required: ['query']
    }
  },

  get_air_quality: {
    name: 'get_air_quality' as const,
    description: 'Get air quality data including AQI (Air Quality Index), pollutant concentrations, and UV index for a location (global coverage). Use this when asked about "air quality", "pollution", "AQI", "UV index", "safe to exercise outside", or health-related environmental conditions. Returns current conditions and optional hourly forecast. Shows appropriate AQI scale (US AQI for US locations, European EAQI elsewhere) with health recommendations. Pollutants include PM2.5, PM10, ozone, NO2, SO2, and CO.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        latitude: {
          type: 'number' as const,
          description: 'Latitude of the location (-90 to 90). Not required if location_name is provided.',
          minimum: -90,
          maximum: 90
        },
        longitude: {
          type: 'number' as const,
          description: 'Longitude of the location (-180 to 180). Not required if location_name is provided.',
          minimum: -180,
          maximum: 180
        },
        location_name: {
          type: 'string' as const,
          description: 'Name of a saved location (e.g., "home", "cabin"). Use this instead of latitude/longitude.'
        },
        forecast: {
          type: 'boolean' as const,
          description: 'Include hourly air quality forecast for next 5 days (default: false, shows current only)',
          default: false
        }
      },
      required: []
    }
  },

  get_marine_conditions: {
    name: 'get_marine_conditions' as const,
    description: 'Get marine conditions including wave height, swell, ocean currents, and sea state for a location (global coverage). Use this when asked about "ocean conditions", "wave height", "surf conditions", "safe to boat", "marine forecast", "swell", or "sea state". Returns current conditions and optional daily/hourly forecast. Includes significant wave height, wind waves, swell, wave period, and ocean currents. Shows safety assessment for maritime activities. NOTE: Data has limited accuracy in coastal areas and is NOT suitable for coastal navigation - always consult official marine forecasts.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        latitude: {
          type: 'number' as const,
          description: 'Latitude of the location (-90 to 90). Not required if location_name is provided.',
          minimum: -90,
          maximum: 90
        },
        longitude: {
          type: 'number' as const,
          description: 'Longitude of the location (-180 to 180). Not required if location_name is provided.',
          minimum: -180,
          maximum: 180
        },
        location_name: {
          type: 'string' as const,
          description: 'Name of a saved location (e.g., "home", "cabin"). Use this instead of latitude/longitude.'
        },
        forecast: {
          type: 'boolean' as const,
          description: 'Include marine forecast for next 5 days (default: false, shows current only)',
          default: false
        }
      },
      required: []
    }
  },

  get_weather_imagery: {
    name: 'get_weather_imagery' as const,
    description: 'Get weather imagery including radar, satellite, and precipitation maps for a location (global coverage). Use this when asked about "show radar", "satellite image", "precipitation map", "weather map", "animated radar", or "what does radar show". Returns image URLs with timestamps for current or animated weather visualization. Supports precipitation radar (global via RainViewer). Includes disclaimer about data delays and official forecast consultation. For numerical forecast data, use get_forecast instead.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        latitude: {
          type: 'number' as const,
          description: 'Latitude of the location (-90 to 90). Not required if location_name is provided.',
          minimum: -90,
          maximum: 90
        },
        longitude: {
          type: 'number' as const,
          description: 'Longitude of the location (-180 to 180). Not required if location_name is provided.',
          minimum: -180,
          maximum: 180
        },
        location_name: {
          type: 'string' as const,
          description: 'Name of a saved location (e.g., "home", "cabin"). Use this instead of latitude/longitude.'
        },
        type: {
          type: 'string' as const,
          description: 'Type of imagery: "radar", "satellite", or "precipitation" (default: "precipitation")',
          enum: ['radar', 'satellite', 'precipitation'],
          default: 'precipitation'
        },
        animated: {
          type: 'boolean' as const,
          description: 'Return animated frames showing progression over time (default: false)',
          default: false
        },
        layers: {
          type: 'array' as const,
          description: 'Optional layers to include in imagery (future enhancement)',
          items: {
            type: 'string' as const
          }
        }
      },
      required: ['type']
    }
  },

  get_lightning_activity: {
    name: 'get_lightning_activity' as const,
    description: 'Get real-time lightning strike activity and safety assessment for a location (global coverage). Use this when asked about "lightning nearby", "lightning strikes", "thunderstorm activity", "is it safe from lightning", or "lightning danger". Returns recent strikes within specified radius and time window, including distance, polarity, intensity, and critical safety recommendations. Provides 4-level safety assessment (safe/elevated/high/extreme) based on proximity. SAFETY-CRITICAL tool for outdoor activities and severe weather monitoring.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        latitude: {
          type: 'number' as const,
          description: 'Latitude of the location (-90 to 90). Not required if location_name is provided.',
          minimum: -90,
          maximum: 90
        },
        longitude: {
          type: 'number' as const,
          description: 'Longitude of the location (-180 to 180). Not required if location_name is provided.',
          minimum: -180,
          maximum: 180
        },
        location_name: {
          type: 'string' as const,
          description: 'Name of a saved location (e.g., "home", "cabin"). Use this instead of latitude/longitude.'
        },
        radius: {
          type: 'number' as const,
          description: 'Search radius in kilometers (1-500, default: 100)',
          minimum: 1,
          maximum: 500,
          default: 100
        },
        timeWindow: {
          type: 'number' as const,
          description: 'Time window in minutes for historical strikes (5-120, default: 60)',
          minimum: 5,
          maximum: 120,
          default: 60
        }
      },
      required: []
    }
  },

  get_river_conditions: {
    name: 'get_river_conditions' as const,
    description: 'Monitor river levels and flood status for a location (US only). Use this when asked about "river flooding", "river level", "flood stage", "streamflow", "safe to kayak", or "river conditions". Returns current river gauge data within specified radius including river stage, flow rate, flood category levels (action/minor/moderate/major), and forecasted conditions. Provides safety assessment based on flood stages. SAFETY-CRITICAL tool for flood-prone areas and water recreation.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        latitude: {
          type: 'number' as const,
          description: 'Latitude of the location (-90 to 90). Not required if location_name is provided.',
          minimum: -90,
          maximum: 90
        },
        longitude: {
          type: 'number' as const,
          description: 'Longitude of the location (-180 to 180). Not required if location_name is provided.',
          minimum: -180,
          maximum: 180
        },
        location_name: {
          type: 'string' as const,
          description: 'Name of a saved location (e.g., "home", "cabin"). Use this instead of latitude/longitude.'
        },
        radius: {
          type: 'number' as const,
          description: 'Search radius in kilometers (1-500, default: 50)',
          minimum: 1,
          maximum: 500,
          default: 50
        }
      },
      required: []
    }
  },

  get_wildfire_info: {
    name: 'get_wildfire_info' as const,
    description: 'Monitor active wildfires and fire perimeters for a location (US focus). Use this when asked about "wildfires nearby", "fire danger", "active fires", "wildfire smoke", "fire perimeters", or "evacuation risk". Returns active wildfire information within specified radius including fire name, size, containment percentage, distance from location, and safety assessment. Provides critical evacuation awareness and air quality impact information. SAFETY-CRITICAL tool for wildfire-prone areas.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        latitude: {
          type: 'number' as const,
          description: 'Latitude of the location (-90 to 90). Not required if location_name is provided.',
          minimum: -90,
          maximum: 90
        },
        longitude: {
          type: 'number' as const,
          description: 'Longitude of the location (-180 to 180). Not required if location_name is provided.',
          minimum: -180,
          maximum: 180
        },
        location_name: {
          type: 'string' as const,
          description: 'Name of a saved location (e.g., "home", "cabin"). Use this instead of latitude/longitude.'
        },
        radius: {
          type: 'number' as const,
          description: 'Search radius in kilometers (1-500, default: 100)',
          minimum: 1,
          maximum: 500,
          default: 100
        }
      },
      required: []
    }
  },

  save_location: {
    name: 'save_location' as const,
    description: 'Save a location for easy reuse in weather queries. Use this when a user wants to save a frequently used location like "home", "work", "cabin", or "aunt lisa\'s house". Accepts either a location query (which will be geocoded automatically) or direct coordinates. Saved locations can be used with all weather tools by providing location_name instead of coordinates. Makes it easy to ask "What\'s the weather forecast at home?" without repeatedly providing coordinates. SMART UPDATES: If the alias already exists and you only provide name/activities (without location details), it will update just those fields while preserving coordinates.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        alias: {
          type: 'string' as const,
          description: 'Short name/alias for this location (e.g., "home", "work", "cabin"). Will be lowercased automatically. Max 50 characters.',
          maxLength: 50
        },
        location_query: {
          type: 'string' as const,
          description: 'Location to geocode and save (e.g., "Seattle, WA", "Paris, France", "Lake Tahoe, CA"). Will be geocoded using Nominatim. Not required if latitude/longitude provided.'
        },
        latitude: {
          type: 'number' as const,
          description: 'Latitude if providing coordinates directly. Not required if location_query provided.',
          minimum: -90,
          maximum: 90
        },
        longitude: {
          type: 'number' as const,
          description: 'Longitude if providing coordinates directly. Not required if location_query provided.',
          minimum: -180,
          maximum: 180
        },
        name: {
          type: 'string' as const,
          description: 'Display name for the location (required when using latitude/longitude). E.g., "My Home in Seattle"'
        },
        description: {
          type: 'string' as const,
          description: 'Short description for natural language matching (e.g., "My sister\'s house", "The lake house"). Helps Claude understand contextual references.'
        },
        alternateNames: {
          type: 'array' as const,
          description: 'Alternate names/aliases for this location (e.g., ["sister\'s place", "Jane\'s house"]). Enables more natural language queries.',
          items: {
            type: 'string' as const
          }
        },
        notes: {
          type: 'string' as const,
          description: 'Freeform notes about this location for future reference'
        },
        activities: {
          type: 'array' as const,
          items: {
            type: 'string' as const
          },
          description: 'Optional activities you do at this location (e.g., ["boating", "fishing"], ["hiking", "camping"]). Helps AI provide relevant weather information. Each activity max 50 characters.'
        }
      },
      required: ['alias']
    }
  },

  list_saved_locations: {
    name: 'list_saved_locations' as const,
    description: 'List all saved locations. Use this when a user wants to see their saved locations or asks "what locations do I have saved?" or "show my saved places". Returns all saved locations with their aliases, names, coordinates, and other metadata. Helpful for reminding users what location names they can use with weather tools.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: []
    }
  },

  get_saved_location: {
    name: 'get_saved_location' as const,
    description: 'Get details for a specific saved location. Use this when a user wants to view information about a particular saved location, like "show me details for my home location" or "what are the coordinates for my cabin?".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        alias: {
          type: 'string' as const,
          description: 'The alias/name of the saved location to retrieve (e.g., "home", "work")'
        }
      },
      required: ['alias']
    }
  },

  remove_saved_location: {
    name: 'remove_saved_location' as const,
    description: 'Remove a saved location. Use this when a user wants to delete a saved location, like "remove my work location" or "delete the cabin from saved locations".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        alias: {
          type: 'string' as const,
          description: 'The alias/name of the saved location to remove (e.g., "home", "work")'
        }
      },
      required: ['alias']
    }
  }
};

/**
 * Tools whose handlers only take latitude/longitude. A saved location_name is
 * resolved to coordinates before the handler runs (get_forecast,
 * get_forecast_nomads and get_model_comparison_forecast resolve it themselves).
 */
const SAVED_LOCATION_TOOLS: ReadonlySet<string> = new Set([
  'get_current_conditions',
  'get_alerts',
  'get_historical_weather',
  'get_air_quality',
  'get_marine_conditions',
  'get_weather_imagery',
  'get_lightning_activity',
  'get_river_conditions',
  'get_wildfire_info',
]);

/**
 * Build an MCP server exposing the enabled weather tools.
 *
 * Cheap to create (it only registers handlers), so HTTP transports can create
 * one per request while sharing the same services and caches.
 */
export function createMcpServer(services: WeatherServices): Server {
  const {
    noaaService,
    openMeteoService,
    nominatimService,
    locationStore,
    nceiService,
    nomadsService,
    modelComparisonService,
    nifcService,
    geocodingService,
  } = services;

  const server = new Server(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  /**
   * Handler for listing available tools
   * Only returns tools that are enabled in the configuration
   */
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const enabledTools = toolConfig.getEnabledTools();
    const tools = enabledTools
      .map(toolName => TOOL_DEFINITIONS[toolName])
      .filter(Boolean); // Filter out any undefined tools

    return { tools };
  });

  /**
   * Handler for tool execution
   * Validates that tools are enabled before execution
   */
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const requestId = randomUUID();
    const requestStartMs = Date.now();

    logRequestLifecycle({
      timestamp: new Date().toISOString(),
      requestId,
      tool: name,
      status: 'start'
    });

    const completeSuccess = <T>(result: T): T => {
      logRequestLifecycle({
        timestamp: new Date().toISOString(),
        requestId,
        tool: name,
        status: 'success',
        durationMs: Date.now() - requestStartMs
      });

      return result;
    };

    try {
      // Check if tool is enabled
      if (!toolConfig.isEnabled(name as any)) {
        throw new Error(`Tool '${name}' is not enabled. Please check your ENABLED_TOOLS configuration.`);
      }

      const toolArgs = SAVED_LOCATION_TOOLS.has(name) ? applySavedLocation(args, locationStore) : args;

      switch (name) {
        case 'get_forecast':
          return completeSuccess(await withAnalytics('get_forecast', async () =>
            handleGetForecast(args, noaaService, openMeteoService, nomadsService, locationStore, nceiService)
          ));

        case 'get_forecast_nomads':
          return completeSuccess(await withAnalytics('get_forecast_nomads', async () =>
            handleGetNomadsForecast(args, nomadsService, locationStore)
          ));

        case 'get_model_comparison_forecast':
          return completeSuccess(await withAnalytics('get_model_comparison_forecast', async () =>
            handleGetModelComparisonForecast(args, modelComparisonService, locationStore)
          ));

        case 'get_current_conditions':
          return completeSuccess(await withAnalytics('get_current_conditions', async () =>
            handleGetCurrentConditions(toolArgs, noaaService, openMeteoService, nceiService)
          ));

        case 'get_alerts':
          return completeSuccess(await withAnalytics('get_alerts', async () =>
            handleGetAlerts(toolArgs, noaaService)
          ));

        case 'get_historical_weather':
          return completeSuccess(await withAnalytics('get_historical_weather', async () =>
            handleGetHistoricalWeather(toolArgs, noaaService, openMeteoService)
          ));

        case 'check_service_status':
          return completeSuccess(await withAnalytics('check_service_status', async () =>
            handleCheckServiceStatus(noaaService, openMeteoService, SERVER_VERSION)
          ));

        case 'search_location':
          return completeSuccess(await withAnalytics('search_location', async () =>
            handleSearchLocation(args, geocodingService)
          ));

        case 'get_air_quality':
          return completeSuccess(await withAnalytics('get_air_quality', async () =>
            handleGetAirQuality(toolArgs, openMeteoService)
          ));

        case 'get_marine_conditions':
          return completeSuccess(await withAnalytics('get_marine_conditions', async () =>
            handleGetMarineConditions(toolArgs, noaaService, openMeteoService)
          ));

        case 'get_weather_imagery':
          return completeSuccess(await withAnalytics('get_weather_imagery', async () => {
            const result = await getWeatherImagery(toolArgs as any);
            const formatted = formatWeatherImageryResponse(result);
            return {
              content: [
                {
                  type: 'text',
                  text: formatted
                }
              ]
            };
          }));

        case 'get_lightning_activity':
          return completeSuccess(await withAnalytics('get_lightning_activity', async () => {
            const result = await getLightningActivity(toolArgs as any);
            const formatted = formatLightningActivityResponse(result);
            return {
              content: [
                {
                  type: 'text',
                  text: formatted
                }
              ]
            };
          }));

        case 'get_river_conditions':
          return completeSuccess(await withAnalytics('get_river_conditions', async () =>
            handleGetRiverConditions(toolArgs, noaaService)
          ));

        case 'get_wildfire_info':
          return completeSuccess(await withAnalytics('get_wildfire_info', async () =>
            handleGetWildfireInfo(toolArgs, nifcService)
          ));

        case 'save_location':
          return completeSuccess(await withAnalytics('save_location', async () =>
            handleSaveLocation(args, locationStore, nominatimService)
          ));

        case 'list_saved_locations':
          return completeSuccess(await withAnalytics('list_saved_locations', async () =>
            handleListSavedLocations(locationStore)
          ));

        case 'get_saved_location':
          return completeSuccess(await withAnalytics('get_saved_location', async () =>
            handleGetSavedLocation(args, locationStore)
          ));

        case 'remove_saved_location':
          return completeSuccess(await withAnalytics('remove_saved_location', async () =>
            handleRemoveSavedLocation(args, locationStore)
          ));

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      logRequestLifecycle({
        timestamp: new Date().toISOString(),
        requestId,
        tool: name,
        status: 'error',
        durationMs: Date.now() - requestStartMs
      });

      // Redact sensitive fields from args before logging
      const redactedArgs = args ? redactSensitiveFields(args) : undefined;

      // Log the error with redacted details
      logger.error('Tool execution error', error as Error, {
        tool: name,
        args: redactedArgs ? JSON.stringify(redactedArgs) : undefined,
      });
      // Format error for user display (sanitized)
      const userMessage = formatErrorForUser(error as Error);

      return {
        content: [
          {
            type: 'text',
            text: userMessage
          }
        ],
        isError: true
      };
    }
  });

  return server;
}
