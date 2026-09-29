# Docker Deployment Plan (Raspberry Pi)

**Goal:** Run the Weather MCP server and the web console in one Docker container on a
Raspberry Pi, so AI clients (Claude Desktop, Claude Code) use the tools over the network
and people use the console from any browser on the home network.

**Target:** Raspberry Pi 5 (8 GB), 64-bit Raspberry Pi OS (Debian 12 "Bookworm", `linux/arm64`),
Docker + Docker Compose, SD-card storage.

**Branch:** `feat/docker-deployment`

| Phase | Scope | Status |
|---|---|---|
| 1 | Fix the ARM crash in the GRIB (NOMADS) library | Done |
| 2 | One server process for LLMs (`/mcp`) and the console | Done |
| 3 | Docker packaging, tested on a Mac | Done |
| 4 | Deploy to the Pi | Done |
| 5 | Optional: HTTPS/remote access, friendly name, dashboard link | In progress (Tailscale installed on the Pi; sign-in and HTTPS pending) |
| 6 | Docs and PR | Done |

Placeholders used below: `<pi-host>` (e.g. `raspberrypi.local`), `<pi-ip>` (its LAN address),
`<pi-user>` (the login account on the Pi).

---

## Architecture

```
  Your Mac                                  Raspberry Pi
 ┌────────────────────────┐        ┌──────────────────────────────────────────┐
 │ Claude Desktop ────────┼──┐     │  container "weather-mcp"  (port 3003)    │
 │  (mcp-remote bridge)   │  │     │  ┌────────────────────────────────────┐  │
 │ Claude Code CLI ───────┼──┼──►  │  │ one Node process                   │  │
 │                        │  │ /mcp│  │  /mcp     ← LLMs (HTTP + token)    │  │
 │ Browser ───────────────┼──┼──►  │  │  /        ← web console page       │  │
 └────────────────────────┘  │ /   │  │  /api/*   ← console's tool calls   │  │
  Phone / iPad browser ──────┘     │  │  /health  ← Docker health check    │  │
                                   │  │  shared: cache, saved locations    │  │
                                   │  └──────────────┬─────────────────────┘  │
                                   │   ~/WeatherMCP/data ↔ /app/data (volume) │
                                   └──────────────────┼───────────────────────┘
                                                      ▼
                                    NOAA, Open-Meteo, NOMADS, RainViewer, …
```

One process serves both people and LLMs. The console calls tools through an in-process
MCP client (the SDK's in-memory transport), so it exercises the same code path an AI
client does, and everything shares one cache and one saved-locations file.

---

## Phase 1: Fix the ARM crash (prerequisite)

**Problem:** `@mattnucc/gribberish` (GRIB decoding for NOMADS/model comparison) ships native
builds only for `linux-x64-gnu`, macOS and Windows. There is no `linux-arm64` build.
`src/services/nomads.ts` imports it at module load, so on ARM Linux the whole MCP server
fails to start, taking down all tools, not just the NOMADS ones. The package has a
WebAssembly fallback (`@mattnucc/gribberish-wasm32-wasi`), but npm skips it on ARM because
it is published for `cpu: wasm32`.

**Work:**
- Load gribberish lazily on first use. If it can't load, only `get_forecast_nomads`,
  `get_model_comparison_forecast` (NOMADS models) and NOMADS-sourced `get_forecast`
  report "model data unavailable on this platform"; every other tool keeps working.
- Make GRIB decoding work on ARM:
  - First choice: install the WebAssembly fallback in the image.
  - Fallback: compile gribberish for `aarch64` in a Rust build stage.
- Verify in a `linux/arm64` container (Docker on Apple Silicon runs the same platform as
  the Pi) and time a model comparison.
- Test that a missing GRIB binding doesn't stop the server from starting.

**Results:**
- Reproduced in a `linux/arm64` `node:22-bookworm-slim` container: the server exited at
  startup with `Cannot find module '@mattnucc/gribberish-linux-arm64-gnu'`.
- `src/services/nomads.ts` now loads the decoder with a dynamic `import()` on first use
  (`loadGribParser()`, result cached). `getModelForecast` loads it before probing model
  runs, because the run probe swallows errors and would otherwise download several files
  and report "runs were not reachable".
- Without a decoder: all 18 tools load, other tools work, NOMADS requests fail immediately
  with "NOMADS model data is unavailable on this platform (linux-arm64)…". Model
  comparison notes now show that reason (they used `ApiError.message`, a generic summary,
  instead of `userMessage`).
- **Decision: WebAssembly fallback.** Installing `@mattnucc/gribberish-wasm32-wasi` (same
  version as `@mattnucc/gribberish`) makes NOMADS work on `linux/arm64`. Output was
  byte-identical to the native macOS decoder for the same model runs, and timing matched
  (model comparison ~14 s either way; most of it is download time, since requests fetch
  only a ±2° subregion). No Rust build stage needed. The image install step (Phase 3):
  `npm install --no-save --force @mattnucc/gribberish-wasm32-wasi@<gribberish version>`
  (`--force` gets past npm's `cpu: wasm32` platform check).
- **Lock file fix:** `package-lock.json` had been out of sync with `package.json` since
  the gribberish dependency was added, so `npm ci` failed everywhere. It also lacked the
  `@emnapi/core`/`@emnapi/runtime` peers the WebAssembly runtime needs. Regenerated with
  npm 10 (Node 22's bundled npm); `npm ci` now passes with both npm 10 and npm 11.
- Tests: `tests/unit/nomads-grib-loading.test.ts` (module loads without a decoder, clear
  error, no network request, failure cached, parser delegates when available).
- Unrelated observation: NAM runs returned "model file not found" from NOMADS during
  testing with both decoders, i.e. upstream availability, not this change.

## Phase 2: One server for LLMs and the console

- Split `src/index.ts` into a reusable `createMcpServer()` (tool registry + handlers).
  `node dist/index.js` (stdio) keeps working unchanged for local use.
- `src/web/server.ts` serves:
  - `/mcp`: Streamable HTTP MCP endpoint (SDK transport, stateless)
  - `/`: the console page
  - `/api/*`: console tool calls via an in-process MCP client (no child process)
  - `/health`: container health check
- `LocationStore` gains a configurable data directory (default stays `~/.weather-mcp`).
- Security:
  - Host allowlist on `/mcp` and `/api` (DNS-rebinding protection)
  - Origin checks on console routes
  - Optional bearer token (`WEATHER_MCP_TOKEN`) required on `/mcp` and `/api` when set
- Console: prompts for the token on `401` and remembers it; hides "Use my location" when
  the page isn't a secure context (plain `http://` on the LAN).
- Tests: config parsing, host/token checks, and an SDK client connecting to `/mcp` and
  listing tools.

**Results:**
- `src/index.ts` split into side-effect-free `src/mcpServer.ts` (`createServices()`,
  `createMcpServer()`, `shutdownServices()`) and a small stdio entry point; stdio
  behavior verified unchanged (18 tools, same outputs).
- `src/web/` is now `server.ts` (entry), `app.ts` (routes), `config.ts` (settings),
  `access.ts` (host/origin/token checks), `envDefaults.ts` (`ENABLED_TOOLS=all`).
- The climate explorer (`/api/climate`, added on `main` in parallel) was carried over
  unchanged into `app.ts`.
- The console's token prompt is an in-page sign-in box: `window.prompt()` throws in some
  embedded and home-screen browsers (it did in the Claude desktop browser pane).
- Tests: `tests/unit/web-config.test.ts` (22) and `tests/unit/web-server.test.ts` (12:
  real server on an ephemeral port, SDK client over `/mcp`, console API, 401/403/405
  paths); 151 tests pass across the related files.
- Verified in the browser: tools, climate explorer, and the sign-in flow (wrong token
  rejected, right token remembered) against a token-protected server.

**Settings (environment variables):**

| Variable | Local default | In the container |
|---|---|---|
| `WEB_PORT` | `8787` | `3003` |
| `WEB_HOST` | `127.0.0.1` | `0.0.0.0` |
| `WEB_ALLOWED_HOSTS` | `localhost,127.0.0.1` | `<pi-host>,<pi-ip>` (+ any friendly names) |
| `WEATHER_MCP_TOKEN` | unset (no auth) | long random string |
| `WEATHER_MCP_DATA_DIR` | `~/.weather-mcp` | `/app/data` |
| `ENABLED_TOOLS` | `all` | `all` |

## Phase 3: Docker packaging (built and tested on a Mac)

- `Dockerfile`, multi-stage on `node:22-bookworm-slim` (Debian/glibc, not Alpine: the GRIB
  library's Linux builds are glibc only):
  - Build stage: `npm ci`, `tsc`, plus the Phase 1 ARM fix.
  - Runtime stage: production dependencies, `dist/`, `web/`.
  - Runs as the non-root `node` user (uid 1000), `EXPOSE 3003`, Node-based `HEALTHCHECK`
    (slim images have no `curl`).
- `docker-compose.yml`:

  | Setting | Value |
  |---|---|
  | Container name | `weather-mcp` |
  | Port | `3003:3003` |
  | Data | `./data:/app/data` |
  | Settings | `env_file: .env` |
  | Restart | `unless-stopped` |
  | Memory cap | `768m` |
  | Logging | `json-file`, `max-size: 10m`, `max-file: 3` (protects the SD card) |
  | Hardening | `read_only` root filesystem + `tmpfs /tmp`, `cap_drop: [ALL]`, `no-new-privileges` |

- `.dockerignore` (excludes `.env`, `node_modules`, `.git`, coverage/test output) and
  `.env.example` documenting every setting.
- Test on the Mac: `docker compose up`, console at `http://localhost:3003`, Claude Code
  against `http://localhost:3003/mcp`.

**Results** (Docker 29.8 / Compose v5.5 on Apple Silicon, i.e. `linux/arm64` like the Pi):
- Image `weather-mcp:local`: 292 MB, runs as `node` (uid 1000). The `deps` stage checks
  whether the native GRIB decoder loads and installs the WebAssembly build only if not
  (so `linux/amd64` keeps the native one). Node logs a one-time "WASI is an experimental
  feature" warning on first NOMADS use; harmless.
- Container healthy within seconds; `/health` open, `/api/*` and `/mcp` return 401 without
  the token and work with it.
- Over `/mcp` with the token: 18 tools; `save_location` wrote to the volume;
  `get_current_conditions` by saved name; model comparison with GFS + HRRR decoded via
  WebAssembly (~16 s).
- `docker exec -i weather-mcp node dist/index.js` (stdio fallback): 18 tools, sees the
  same saved locations.
- Saved locations survived `docker compose down` + `up` (container recreated).
- Hardening verified: read-only root filesystem (writes to `/app` and `/home/node`
  fail), `cap_drop: ALL`, `no-new-privileges`, 768 MB limit, log rotation, `init`.
- Console at `http://localhost:3003`: sign-in box, then tools run against the container.
- Fix found while testing: analytics tried to write its salt to the read-only home
  directory (it generates one even when analytics is off). It now uses
  `WEATHER_MCP_DATA_DIR` when set, so the salt lands on the volume.
- `.env.example` no longer sets `ENABLED_TOOLS=basic` (copying it for the container would
  have cut the tools from 18 to 9) and documents the web/Docker settings; `/data/` is
  git-ignored.

## Phase 4: Deploy to the Pi

1. `git clone https://github.com/dapcook/weather-mcp.git ~/WeatherMCP` and check out the
   branch (public repo; no credentials needed on the Pi).
2. Create `~/WeatherMCP/.env` from `.env.example`; generate the token with
   `openssl rand -hex 32`.
3. `mkdir -p ~/WeatherMCP/data`. Optionally copy existing saved locations:
   `scp ~/.weather-mcp/locations.json <pi-user>@<pi-host>:WeatherMCP/data/`.
   From then on the Pi's copy is the one in use.
4. `docker compose up -d --build` (a few minutes on a Pi 5).
5. Verify from the Mac: `/health`, the console in a browser, and Claude listing and
   calling tools.

**Results** (Raspberry Pi 5, 8 GB, 64-bit Raspberry Pi OS, Docker 29.8 / Compose v5.5):
- First `docker compose up -d --build` on the Pi: 51 s; the build logged "No native GRIB
  decoder for aarch64; installing WebAssembly build 0.30.1". Container healthy within
  seconds; image 415 MB as reported by the Pi's Docker.
- The token was generated on the Pi straight into `.env` (mode 600) and never left it
  except as an HTTP header during verification.
- From the Mac over the LAN: `/health` 200; `/api/*` and `/mcp` 401 without the token;
  with it, 18 tools over `/mcp`, current conditions and forecast by saved-location name,
  and a GFS + HRRR model comparison decoded on the Pi (~16 s).
- stdio fallback over SSH (`ssh <pi-user>@<pi-host> docker exec -i weather-mcp node
  dist/index.js`): 18 tools, same saved locations.
- Reachable as `http://<pi-host>:3003` and `http://<pi-ip>:3003`; an unlisted `Host`
  header and a cross-site `Origin` both get 403.
- Console loads from another device and shows the sign-in box; the page is not a secure
  context over plain `http://`, so "Use my location" is hidden as designed.

## Phase 5: Optional extras

- **HTTPS and remote access:** Tailscale on the Pi and client devices; `tailscale serve`
  gives an `https://<machine>.<tailnet>.ts.net` address. That enables "Use my location" and
  Copy (browsers require HTTPS for both) and works away from home without opening router
  ports. Useful when ports 80/443 are already taken on the Pi (e.g. by Pi-hole).
- **Friendly name:** a local DNS record (e.g. Pi-hole Local DNS: `weather.home → <pi-ip>`).
- **Dashboard link:** add a tile to a home dashboard.
- **Local models:** any MCP-capable chat client (e.g. one used with Ollama) can connect to
  the same `/mcp` endpoint.

**Tailscale progress:**
- Installed on the Pi from Tailscale's apt repository (Debian bookworm, signed key; version
  1.102.4). The Pi runs Pi-hole and NetworkManager owns `resolv.conf`, so it is joined with
  `--accept-dns=false`: Tailscale must not take over DNS for the network. Verified before and
  after install: `resolv.conf` unchanged and Pi-hole still answering.
- Ports 80 and 443 belong to Pi-hole, so the HTTPS address will use port **8443**.
- Still to do (needs the account owner): sign the Pi in at the one-time link `tailscale up`
  prints, turn on MagicDNS and **Enable HTTPS** on the tailnet's DNS page, and install
  Tailscale on the client devices. Optionally disable key expiry for the Pi.
- Then: add the Pi's `*.ts.net` name to `WEB_ALLOWED_HOSTS`, run
  `tailscale serve --bg --https=8443 http://127.0.0.1:3003`, and verify the certificate and
  the token check. Never use `tailscale funnel` (public internet).

## Phase 6: Docs and PR

README "Running in Docker / on a Raspberry Pi" section (including the client setup
below), CHANGELOG entry, PR from `feat/docker-deployment`.

**Results:**
- `docs/DOCKER.md`: user guide (requirements, quick start, connecting clients, settings,
  everyday commands, token replacement, saved locations and backups, security, Raspberry
  Pi notes, troubleshooting, going back to local, how it works).
- `docs/CLIENT_SETUP.md`: new "Connecting to a Remote Server (HTTP)" section (Claude Code,
  Claude Desktop via `mcp-remote`, Cursor, VS Code, SSH fallback) and a "Remote Server Not
  Connecting" troubleshooting entry. Claude Code and Claude Desktop were tested end to end;
  the Cursor and VS Code examples follow those clients' documented formats and are marked
  as untested.
- README section right after the Web Console section, plus links from the client and
  documentation lists; `docs/README.md` index; CHANGELOG; CLAUDE.md/AGENTS.md.
- Verified while writing: editing `.env` then `docker compose up -d` recreates the
  container with the new token (old token then returns 401).

---

## Using it

### Connecting AI clients

**Claude Desktop** (chat and Code tab). Its config only launches local programs, so the
`mcp-remote` bridge connects it to the Pi. In
`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "weather": {
      "command": "npx",
      "args": ["-y", "mcp-remote@<pinned-version>", "http://<pi-host>:3003/mcp",
               "--allow-http", "--header", "Authorization:${WEATHER_AUTH}"],
      "env": { "WEATHER_AUTH": "Bearer <token>" }
    }
  }
}
```

Restart Claude Desktop afterwards. `--allow-http` is required because `mcp-remote` only allows
plain `http://` for localhost; with Tailscale HTTPS, drop it and use the `https://…/mcp`
address. To go back to local, restore the `node …/dist/index.js` entry.

**Claude Code CLI** connects over HTTP directly:

```bash
claude mcp add --transport http --scope user weather http://<pi-host>:3003/mcp --header "Authorization: Bearer <token>"
```

**Fallback (no token, no bridge): stdio over SSH**, using existing SSH key access:

```json
"weather": { "command": "ssh", "args": ["<pi-user>@<pi-host>", "docker", "exec", "-i", "weather-mcp", "node", "dist/index.js"] }
```

Each session then runs its own server process inside the container, with a cache separate
from the console's.

### Using the web console

- Home network: `http://<pi-host>:3003`. Devices with unreliable `.local` name support
  (some Android/Windows) can use `http://<pi-ip>:3003` or a local DNS name.
- The first visit asks for the token (if set); the browser remembers it.
- Over plain `http`, everything works except "Use my location" and Copy, which need HTTPS.

### Container commands (on the Pi, in `~/WeatherMCP`)

| Task | Command |
|---|---|
| Status / health | `docker compose ps` · `curl http://localhost:3003/health` |
| Live logs | `docker compose logs -f` |
| Restart | `docker compose restart` |
| Update to latest code | `git pull && docker compose up -d --build` |
| Change settings | edit `.env`, then `docker compose up -d` |
| Stop / start | `docker compose down` · `docker compose up -d` |
| Shell inside | `docker exec -it weather-mcp sh` |
| Back up saved locations | copy `~/WeatherMCP/data/locations.json` |

---

## Risks and decisions

- **WebAssembly GRIB speed on the Pi (Phase 1):** if model comparisons are too slow, switch
  to compiling the native library (longer first build).
- **`mcp-remote`** is a third-party package run by `npx` on the client; pin a version.
- **Pi down = no weather tools in Claude.** Keep the local stdio entry handy for rollback.
- **Saved locations** live only on the Pi after the switch; anything saved locally
  afterwards won't sync.
- **Log growth:** containers without log limits grow logs indefinitely on the SD card;
  the compose file sets limits for this container.
