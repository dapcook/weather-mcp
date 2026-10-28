# To Do

Open work on the Weather MCP Server, newest decisions first. This is the short, current list; longer-term ideas live in the [Roadmap](./planning/ROADMAP.md) and [Future Enhancements](./planning/FUTURE_ENHANCEMENTS.md), and what has shipped is in the [Changelog](../CHANGELOG.md).

**Last reviewed:** 2026-10-28, with the Docker/web console branch ([PR #2](https://github.com/dapcook/weather-mcp/pull/2)) at 1,254 unit tests passing.

Keep this file honest: when you finish an item, move it to [Done recently](#done-recently) (or delete it), and when you find a new problem, add it here with why it matters.

## Soon

### 1. Upgrade dependencies (security advisories)
- **Why:** `npm audit` reports 19 advisories: 11 in production dependencies (including `@modelcontextprotocol/sdk` 1.21.1 and `axios`) and the rest in dev tooling, 2 of them critical (dev-only). `main` has the same 19. The server can now listen on a network port, so the production ones matter more than they did for a stdio-only tool.
- **What:** move the MCP SDK (1.21.x to the current 1.x), `axios`, and the test tooling (`vitest` and friends) to patched versions; rebuild; run all tests; re-check `docker compose up -d --build`.
- **Watch for:** SDK changes to the Streamable HTTP transport used by `src/web/app.ts`, and to the in-memory transport the console uses.
- **How to do it:** a separate branch and PR, not part of PR #2.
- **Done when:** `npm audit` shows no production advisories (or each remaining one is explained here), unit tests pass, and the container still serves 18 tools over `/mcp`.

### 2. Run the integration tests
- **Why:** the 62 tests in `tests/integration/` call live weather APIs and have not been run on this branch. They cover error recovery, Great Lakes marine, weather imagery, lightning, rivers and wildfire.
- **What:** `npx vitest run tests/integration` with `API_TIMEOUT_MS`, `ENABLED_TOOLS`, `CACHE_ENABLED`, `CACHE_MAX_SIZE` and `LOG_LEVEL` unset. A few failures from upstream outages are normal; anything that fails the same way twice deserves a look.
- **Done when:** results are recorded in the PR or changelog, with each failure explained.

### 3. Build and test the `linux/amd64` image
- **Why:** only `linux/arm64` (Apple Silicon, Raspberry Pi 5) has been built and tested. The Dockerfile uses a multi-architecture base image and installs the native GRIB decoder wherever it loads, so `amd64` should work, but the README says it builds for both.
- **What:** `docker buildx build --platform linux/amd64 .` (emulated is fine for a smoke test), run it, and check `/health`, 18 tools over `/mcp`, and a GFS comparison (GRIB decoding).
- **Done when:** the result is written in [DOCKER_DEPLOYMENT_PLAN.md](./planning/DOCKER_DEPLOYMENT_PLAN.md), or the README claim is narrowed.

## Cleanups

### 4. Remove or fix the retry loop that never retries
- `OpenMeteoService.makeRequest()` retries only when the error text contains lowercase `rate limit`, `server error` or `timed out`, but the real messages don't, so nothing is retried. Not retrying 429s is the better behavior here (retrying within the same minute rarely helps), and a test pins it. Delete the dead loop, or make it retry only on connection resets and 5xx, and update `tests/unit/retry-logic.test.ts` and `openmeteo-rate-limit.test.ts` to match.

### 5. Give the Census.gov geocoder its own service name
- A Census.gov rate limit is still labeled `OpenMeteo` because `RateLimitError` has no Census service. Add one to the service names and to `RATE_LIMIT_HELP_LINKS` (the compiler enforces one entry per service), and add a test like the Nominatim one.

### 6. See the "couldn't refresh" note on screen
- The climate explorer shows a line under the place name when it can only show a saved record. It is covered by `tests/unit/web-climate-disk.test.ts` but has not been looked at in a browser. To check: load a place, wait until the next day (a saved record is then one day short), turn off the computer's network connection, and load the place again; `localhost` still works but Open-Meteo is unreachable, so the refresh fails and the note should appear.

### 7. Forecast form layout
- Offered after the climate explorer cleanup: the Forecast tool's form in the web console could use the same tidy-up (grouping, matching control heights). The shared select and number-field styles already apply to it.

### 8. Model comparison: GFS/NAM/HRRR "precipitation chance" is not a probability
- For the NOMADS models it is the share of the day's 3-hourly steps that have any precipitation in that single run, so a run with light rain all day shows 100% (seen live: GFS 100% next to ECMWF 31%, ICON 33%). The Open-Meteo rows use Open-Meteo's own value. Either rename it for the NOMADS rows (for example "wet hours 100%"), or drop it there and leave chance to the models that have one. The longer-term answer is the ensemble item under Ideas.

### 9. Client configs not yet confirmed in the apps
- The Cursor and VS Code examples in [CLIENT_SETUP.md](./CLIENT_SETUP.md#connecting-to-a-remote-server-http) follow those clients' documented formats and are marked untested. Confirm each in the app, then remove the "untested" note.

## Ideas, not committed to

- **Merge PR #2** into the fork's `main` when you are satisfied with it. Nothing else blocks it.
- **More comparison models.** Open-Meteo also serves regional high-resolution runs (ICON-EU/D2, GEM regional/HRDPS, UKMO, Météo-France AROME/ARPEGE, JMA, NBM), each one more entry in `OPEN_METEO_MODELS`. Ensembles (GEFS, ECMWF-ENS) would give real precipitation probabilities and forecast spread, but need Open-Meteo's ensemble API and a new output format. More NOMADS runs (RAP, NAM nests) fit the existing GRIB pipeline.
- **Tailscale for remote access** (was Phase 5 of the Docker plan): sign in, turn on HTTPS, add the `*.ts.net` name to `WEB_ALLOWED_HOSTS`, `tailscale serve`. Never `tailscale funnel` (public internet). Dropped when the Raspberry Pi became unavailable; revisit if the server moves to an always-on machine.
- **Disk cache for other heavy requests.** Only the climate explorer's 86-year record is saved on disk today. The next heaviest Open-Meteo calls (long `get_historical_weather` ranges, climate normals) are cached in memory only.
- **Clear-cache control.** There is no tool or button to clear caches; delete the `climate/` folder in the data folder to reset the saved records.
- **Update the security audit.** The latest ([SECURITY_AUDIT_V1.6.md](./development/SECURITY_AUDIT_V1.6.md), 2025-11-10) predates saved locations, the web console, the HTTP endpoint and Docker.
- See [Roadmap](./planning/ROADMAP.md) and [Future Enhancements](./planning/FUTURE_ENHANCEMENTS.md) for feature ideas.

## Done recently

All on the `feat/docker-deployment` branch ([PR #2](https://github.com/dapcook/weather-mcp/pull/2)); details in the [Changelog](../CHANGELOG.md).

- `get_forecast` can use one chosen model (`model`: ECMWF, AIFS, ICON, GEM, GFS, NAM, HRRR)
- Model comparison: ECMWF IFS, ECMWF AIFS, ICON and GEM added (replacing the mislabeled "ECMWF proxy"); NOMADS no longer picks a run that is still being posted
- Climate explorer temperature axis stays fixed while stepping between years
- Climate explorer records saved on disk, so restarts and rebuilds no longer repeat the download (about 680 Open-Meteo calls per place); refreshes fetch only the newest days, and a failed refresh shows the saved data with a note
- Memory limit for the explorer's in-memory cache (96 MiB instead of growing without bound)
- Open-Meteo rate-limit message says which limit was hit and links the right docs
- Climate explorer layout cleanup
- Request log and analytics salt written to the data folder in read-only containers; query strings kept out of logs
- Docker image and compose file (arm64 tested), one server for `/mcp` and the web console, token/Host/Origin checks
- Server no longer crashes on ARM Linux when the native GRIB decoder is missing
- Documentation audit against the code
