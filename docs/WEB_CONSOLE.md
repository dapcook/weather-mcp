# Web Console Guide

The web console is a local web page for using the Weather MCP server without an AI client. You can run any of the 18 MCP tools from a form and read the formatted result, and explore any location's weather history since 1940 in the **Climate explorer**.

- [Starting the console](#starting-the-console)
- [Running tools](#running-tools)
- [Choosing a location](#choosing-a-location)
- [Radar maps](#radar-maps)
- [Climate explorer](#climate-explorer)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [How it works](#how-it-works)

## Starting the console

```bash
npm install        # first time only
npm run web
```

`npm run web` compiles the TypeScript (`npm run build`) and then starts the console. When the terminal shows `Weather MCP web console running at http://127.0.0.1:8787`, open **http://127.0.0.1:8787** in a browser.

The status pill in the top-right corner shows **Connected · 18 tools** once the console has started the MCP server. Stop the console with <kbd>Ctrl</kbd>+<kbd>C</kbd>.

You can link straight to a tool or view with a URL hash, for example `http://127.0.0.1:8787/#get_forecast` or `http://127.0.0.1:8787/#climate`. Without a hash, the console reopens the last tool you used.

## Running tools

1. **Pick a tool** from the sidebar. Tools are grouped into Forecasts, Now & alerts, Environment & hazards, Locations, and System. Type in **Filter tools…** to narrow the list by name.
2. **Fill in the form.** Each form is built from the tool's MCP input schema, so every parameter the AI sees is here, with its description underneath. Required fields are marked with a red `*`. Fields with a default show it as a placeholder; leave them empty to use the default.
   - Lists of choices (such as models) are chips you can toggle.
   - Free-form lists are comma-separated.
   - Coordinate-based tools have a location helper above the form (see [Choosing a location](#choosing-a-location)).
3. **Click Run.** The result appears below with an **OK** or **Error** badge and how long the call took. NOMADS and model-comparison tools download model data and can take up to a minute.

In the result card:

- **Show markdown / Show formatted** switches between the raw markdown the AI receives and a rendered view.
- **Copy** copies the markdown.
- **Clear** (next to Run) resets the form.

Each tool remembers the inputs you last ran it with, in your browser's local storage.

Saving or removing a location with `save_location` or `remove_saved_location` updates the saved-location picker straight away.

## Choosing a location

Every tool that takes coordinates has a location helper with three options:

| Option | What it does |
|---|---|
| **Saved location** | Picks one of your saved locations (see `save_location`). For tools that accept `location_name` it fills in the alias; otherwise it fills in the coordinates. |
| **Find a place** | Searches OpenStreetMap (Nominatim) by name. Type a city, town, or place, press <kbd>Enter</kbd> or **Search**, and click a result to fill in its coordinates. |
| **Use my location** | Asks the browser for your current position. |

You can also type coordinates into the latitude and longitude fields yourself. The `location_name` and `alias` fields autocomplete from your saved locations.

## Radar maps

`get_weather_imagery` returns RainViewer radar tiles, which on their own are just colored precipitation with no geography. The console draws them over an Esri basemap with state lines and coastlines, with highways and place names layered on top, and a red pin at the requested location.

- Drag to pan.
- **+** / **−** zoom between levels 3 and 7 (RainViewer's free tiles stop at 7).
- Double-click to re-center on the pin.

## Climate explorer

Open **Climate explorer** under **Explorers** at the top of the sidebar (or go to `/#climate`). It charts daily highs and lows for any year since 1940, for any place on Earth, against what is normal for each date. It is modeled on WeatherSpark's daily temperature chart.

### Loading a place

Use the location helper (saved location, place search, or your location), or type a latitude and longitude and click **Load**. Picking a place loads it straight away.

The first load for a place takes a few seconds: it downloads every day since 1940 (about 31,000 days) in one request. After that, changing years, months, zoom, and units is instant, because nothing more is downloaded. The console remembers the last place you loaded.

**Normals baseline** sets which years count as "normal":

| Baseline | Use it for |
|---|---|
| 1991–2020 (default) | The current official climate normals period |
| 1961–1990, 1951–1980 | Comparing against the climate of earlier decades |
| 1940–last year (all years) | The whole record |

Changing the baseline reloads the place.

The line under the title shows the place's coordinates, grid elevation, time zone, the dates covered, and the baseline in use.

### Reading the chart

| Element | Meaning |
|---|---|
| Gray bar | The day's range, from low to high |
| Red / blue tick | The day's high / low |
| Darker red / blue band | Where highs / lows fall in the middle 50% of baseline years (25th–75th percentile) |
| Lighter red / blue band | The middle 80% (10th–90th percentile) |
| Faint red / blue line | Average high / low for the date |
| Dashed gray line | Freezing (32 °F / 0 °C) |
| Dotted red / blue line | Record high / low for the date, over all years since 1940 (**Records** on) |
| Open circle on a tick | That day set the record for its date, and it still stands (**Records** on) |
| Blue bars below the chart | Daily precipitation (**Precipitation** on) |

A tick above the red band was an unusually hot day for that date. A tick below the blue band was an unusually cold night.

The normal range for each date pools the 15 days centered on it (±7 days) across all baseline years, about 450 values, then lightly smooths the curves. So the bands move smoothly through the year instead of jumping from day to day.

### Moving around

| Control | Action |
|---|---|
| Year dropdown | Jump to any year from 1940 to the present |
| **‹** / **›** | Step back or forward a year. When a month is selected, step a month; when zoomed, step by the zoomed span. |
| **Year**, **Jan**–**Dec** | Show the whole year or one month |
| **Last 12 months** | The 365 days up to the latest data |
| Drag across the chart | Zoom to the dragged range (at least 3 days) |
| Double-click the chart | Zoom back out to the whole year |
| **Records** / **Precipitation** | Show or hide record lines and markers, and the precipitation strip |
| **°F** / **°C** | Switch temperature units (precipitation switches between inches and millimeters) |

Only the chart and summary are redrawn when you change the view, so the page doesn't jump.

The current year always spans January to December. Past the latest data, the normal bands continue so you can see what the rest of the year usually looks like.

### Hovering and the keyboard

Move the pointer over the chart to see:

- A **dashed horizontal line** at the pointer's height, with the temperature labeled on the left axis. Hover over the axis labels themselves to read temperatures without a day selected.
- A **detail box** for the day under the pointer. It shows the high and low, where each ranks against baseline years for that date ("94th percentile", or "above every baseline year"), the normal range and average, precipitation, and the record high and low with their years. The box sits just below the temperature line, or above it near the bottom of the chart.

To use the keyboard, click the chart or tab to it:

| Key | Action |
|---|---|
| <kbd>←</kbd> / <kbd>→</kbd> | Previous / next day |
| <kbd>Page Up</kbd> / <kbd>Page Down</kbd> | Back / forward a week |
| <kbd>Home</kbd> / <kbd>End</kbd> | First / last day in view |
| <kbd>Esc</kbd> | Hide the detail box |

### Summary tiles

The tiles under the chart summarize whatever range is on screen:

| Tile | Meaning |
|---|---|
| Highs vs normal / Lows vs normal | Average departure from the baseline average for each date |
| Warmest / Coldest | Highest high and lowest low, with dates |
| Unusually hot days | Days with a high above the 90th percentile |
| Unusually cold nights | Days with a low below the 10th percentile |
| Records set | Record highs / record lows set in the range that still stand |
| Precipitation | Total, as a percentage of the normal total for the same dates, and the number of wet days (at least 0.01 in) |

### About the data

The explorer uses the [Open-Meteo Historical Weather API](https://open-meteo.com/en/docs/historical-weather-api), which is based on the ERA5 reanalysis. ERA5 values are averages over a grid cell about 25 km across, not readings from a weather station. Expect them to differ from a nearby airport station by a few degrees, especially:

- in hilly or mountainous terrain,
- on coasts,
- in cities.

Record highs and lows are records in this dataset, not official station records.

The latest data is two days before today (in UTC), so the most recent day is always a complete day in the place's local time. Days in each series are grouped by the place's local time zone.

## Configuration

Set these environment variables before `npm run web`:

| Variable | Default | Purpose |
|---|---|---|
| `WEB_PORT` | `8787` | Port to listen on (1024–65535) |
| `ENABLED_TOOLS` | `all` | Which tools the console's MCP server exposes; same presets and names as the MCP server (see [Tool Selection](../README.md#tool-selection-new-in-v140)) |
| `LOG_LEVEL` | `1` | `0` for debug logging, which is useful when a tool misbehaves |

The other MCP server settings (`CACHE_ENABLED`, `API_TIMEOUT_MS`, and so on) are passed through to the MCP server the console starts.

```bash
WEB_PORT=8797 npm run web
ENABLED_TOOLS=basic npm run web
LOG_LEVEL=0 npm run web
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `EADDRINUSE` when starting | Another program (often another console) is using the port. Stop it, or start this one on another port with `WEB_PORT=8797 npm run web`. |
| Status shows **Not connected** | The console couldn't start the MCP server. Check the terminal. `npm run web` builds first, but if you start `node dist/web/server.js` yourself, run `npm run build` first. |
| Page shows old behavior after pulling changes | Changes to `web/index.html` show up when you refresh. Changes to TypeScript need the console restarted (`npm run web` rebuilds). |
| A tool is missing from the sidebar | It is disabled by `ENABLED_TOOLS`. |
| `403 Forbidden host` / `Forbidden origin` | The console only answers `http://127.0.0.1:<port>` and `http://localhost:<port>`. Use one of those addresses. |
| Climate explorer takes a long time or fails | The first load of a place downloads its whole record from Open-Meteo. Check your connection; Open-Meteo's free tier also limits daily requests. |

## How it works

`src/web/server.ts` is a small Node `http` server. It starts the real MCP server (`dist/index.js`) as a child process and talks to it over MCP stdio through the MCP SDK client, exactly as an AI client would, so results match what an AI sees. If the MCP server exits, the console reconnects on the next request. The page, `web/index.html`, is a single file of plain HTML, CSS and JavaScript with no build step and no third-party scripts.

HTTP endpoints (for the page; the console is not meant as a public API):

| Endpoint | Purpose |
|---|---|
| `GET /` | The console page |
| `GET /api/tools` | The MCP server's tool list and input schemas |
| `POST /api/call` | Run a tool. Body: `{"name": "get_forecast", "arguments": {...}}`, sent as `application/json`, up to 64 KB. Returns `{content, isError, elapsedMs}`. Calls time out after 180 s. |
| `GET /api/saved-locations` | Saved locations, read directly from `~/.weather-mcp/locations.json` |
| `GET /api/geocode?q=` | Place search via Nominatim (up to 6 results) |
| `GET /api/climate?latitude=&longitude=&baseline=` | The climate explorer's data, described below |

`/api/climate` returns everything the explorer needs in one response (about 500 KB):

- `high`, `low`, and `precipitation`: daily series since 1940 in °F and inches, starting at `start` and ending at `end`.
- `climatology`, built by `src/utils/climatology.ts`, with one entry for each calendar day. Days are indexed 0–365 on a leap-year calendar, so February 29 has its own slot:
  - `high` / `low`: the mean, and quantiles from the 0th to the 100th percentile in 5% steps
  - `precipitationMean`
  - `recordHigh` / `recordLow`, each with its year
- `baseline` defaults to `1991-2020`. Any `YYYY-YYYY` range of at least 10 years from 1940 to last year is accepted.

The daily record comes from `OpenMeteoService.getDailyTemperatureRecord()` and is cached in memory, keyed by the coordinates (rounded to 0.01°) and end date.

### Security

- The console listens on `127.0.0.1` only.
- It rejects requests whose `Host` header isn't its own address (which blocks DNS rebinding) and browser requests from any other origin (which blocks cross-site requests). A web page you visit can't use the console to change your saved locations.
- `POST` bodies must be JSON, and their size is capped.
- The console only calls tools the MCP server lists, and every call goes through the server's normal input validation.
- The page is served with a strict Content Security Policy: inline code only, no third-party scripts, and requests only to the console itself.
