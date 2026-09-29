# Running in Docker (and on a Raspberry Pi)

One container runs the whole Weather MCP server:

- **`/mcp`**: the MCP endpoint, so AI clients on other devices can use the weather tools over your network
- **`/`**: the [web console](./WEB_CONSOLE.md), for running the tools and exploring climate history in a browser
- **`/health`**: a health check for Docker

Saved locations live in a folder on the host, so they survive rebuilds and updates.

The image builds for both `linux/amd64` and `linux/arm64`. It has been tested on Apple Silicon (which runs the same `arm64` containers) and on a **Raspberry Pi 5 (8 GB) with 64-bit Raspberry Pi OS (Debian 12)**. A Pi 4 with a 64-bit OS should work too; a 32-bit OS will not.

> **Home network only.** Don't expose this to the internet. It serves plain `http://`, and the access token is the only lock. See [Security](#security).

## Requirements

- Docker and Docker Compose v2 (`docker compose version`)
- A 64-bit operating system on the Pi (`uname -m` should print `aarch64`)
- About 1 GB of free RAM for the container, and disk space for the image (about 400 MB on a Pi 5) plus Docker's build cache, which `docker builder prune` reclaims

## Quick start

```bash
git clone https://github.com/dapcook/weather-mcp.git ~/WeatherMCP   # or the repository you're reading this in
cd ~/WeatherMCP

cp .env.example .env
```

Edit `.env` and set at least these two lines (uncomment them):

```bash
# A long random secret. Generate one with:  openssl rand -hex 32
WEATHER_MCP_TOKEN=...

# The names and addresses you will use to reach the server (no http://, no port)
WEB_ALLOWED_HOSTS=raspberrypi.local,192.168.1.20
```

Then create the data folder and start it:

```bash
mkdir -p data          # before the first start, so your user owns it (not root)
docker compose up -d --build
```

The first build takes about a minute on a Pi 5. Check that it's healthy:

```bash
docker compose ps                        # STATUS should say "(healthy)"
curl http://localhost:3003/health
```

Now open **http://raspberrypi.local:3003** in a browser (use your own hostname or IP). The console asks for your token once and remembers it in that browser.

## Connecting AI clients

Every client needs the same three things:

| | |
|---|---|
| **URL** | `http://<host>:3003/mcp` |
| **Transport** | Streamable HTTP |
| **Header** | `Authorization: Bearer <your token>` |

Copy-paste setups for Claude Desktop, Claude Code, Cursor, VS Code and others are in **[Connecting to a remote server](./CLIENT_SETUP.md#connecting-to-a-remote-server-http)**.

If you'd rather not use a token or a bridge, any client that launches local commands can run the server inside the container over SSH:

```json
"weather": {
  "command": "ssh",
  "args": ["<user>@<host>", "docker", "exec", "-i", "weather-mcp", "node", "dist/index.js"]
}
```

Each session then starts its own server process, with its own cache separate from the console's.

## Settings

Settings go in `.env` (see `.env.example` for the full list, with comments). After changing `.env`, run `docker compose up -d`. Compose recreates the container with the new values.

| Setting | Default | Purpose |
|---|---|---|
| `WEATHER_MCP_TOKEN` | *(none)* | Required in practice. Clients send it as `Authorization: Bearer <token>`. At least 16 characters. |
| `WEB_ALLOWED_HOSTS` | *(none)* | Hostnames and IPs you'll use, comma-separated. Requests using any other name get `403`. `localhost` is always allowed. |
| `WEATHER_MCP_PORT` | `3003` | The port published on the Docker host. |
| `ENABLED_TOOLS` | `all` | Which tools are exposed (`basic`, `standard`, `full`, `all`, or a list). |
| `LOG_LEVEL` | `1` | `0` debug, `1` info, `2` warn, `3` error. |
| `NCEI_API_TOKEN` | *(none)* | Optional; enables official NOAA climate normals for US locations. |

The container itself fixes `WEB_HOST=0.0.0.0`, `WEB_PORT=3003` and `WEATHER_MCP_DATA_DIR=/app/data`; the compose file publishes the port and mounts `./data` there. Analytics stays off unless you set `ANALYTICS_ENABLED=true`.

## Everyday commands

Run these in the project folder (`~/WeatherMCP`):

| Task | Command |
|---|---|
| Status and health | `docker compose ps` |
| Live logs | `docker compose logs -f` |
| Restart | `docker compose restart` |
| Stop / start | `docker compose down` / `docker compose up -d` |
| Update to the latest code | `git pull && docker compose up -d --build` |
| Shell inside the container | `docker exec -it weather-mcp sh` |
| Replace the token | see below |

**Replacing the token** (for example if it leaked). This changes it in `.env` and recreates the container; the old token stops working immediately, so update your clients afterwards:

```bash
sed -i "s/^WEATHER_MCP_TOKEN=.*/WEATHER_MCP_TOKEN=$(openssl rand -hex 32)/" .env && docker compose up -d
```

(On macOS, use `sed -i ''` instead of `sed -i`.)

## Saved locations and backups

Saved locations are stored in `./data/locations.json` on the host, next to `docker-compose.yml`.

- **Back up:** copy that file.
- **Move from another machine:** copy its `locations.json` into `./data/` before starting, or after stopping the container. If you're switching from a local setup, the file is `~/.weather-mcp/locations.json`.
- **Only one copy is used.** Once the container is the one your clients use, locations saved on your other machine won't appear here.
- **Permissions:** the container runs as user ID 1000 (`node`). On a Raspberry Pi the first user is normally 1000, so `mkdir -p data` as that user is enough. If your user is different, run `sudo chown 1000:1000 data`.

## Security

- **Set a token.** Without `WEATHER_MCP_TOKEN`, anyone who can reach port 3003 can use every tool, including saving and deleting locations. The server logs a warning if it's listening beyond localhost without one.
- **Treat the token like a password.** Keep `.env` out of git (it's already ignored), and remember that Claude Desktop and Cursor store the token in plain text in their config files.
- **Plain HTTP means the token crosses your network unencrypted.** That is acceptable on a trusted home network but not on shared or public networks.
- **Keep it off the internet.** Don't forward port 3003 on your router. To reach it from outside your home, use a private network such as [Tailscale](https://tailscale.com); `tailscale serve` can also give the console a proper `https://` address.
- **The container is locked down:** it runs as a non-root user, with a read-only filesystem (only `/app/data` and `/tmp` are writable), all Linux capabilities dropped, `no-new-privileges`, and a 768 MB memory limit.
- **Requests are checked for hostname and origin.** Names not in `WEB_ALLOWED_HOSTS` (DNS-rebinding protection) and browser requests from other websites (cross-site protection) get `403`.

## Raspberry Pi notes

- **Model data (NOMADS) on ARM.** The library that decodes GFS/NAM/HRRR forecast files has no native build for `linux/arm64`. The image installs its WebAssembly build automatically, which produces identical output at the same speed (a three-model comparison takes about 15 seconds either way). Node prints a one-time "WASI is an experimental feature" warning the first time it's used; that's harmless.
- **SD card wear.** The compose file rotates container logs (3 files of 10 MB). Docker itself keeps the image and build cache on the card too; `docker builder prune` reclaims build cache.
- **Ports.** Something else may already be using 3003 (for example another app on the Pi). Set `WEATHER_MCP_PORT` in `.env` to pick another port. Ports 80 and 443 are often taken by tools such as Pi-hole, which is one reason the console isn't on them.
- **Name resolution.** `raspberrypi.local` relies on mDNS, which some Android and Windows setups don't resolve. Use the Pi's IP address there (add it to `WEB_ALLOWED_HOSTS`), preferably with a fixed address set in your router.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `docker compose ps` shows `unhealthy` or restarting | Read `docker compose logs`. A bad setting (for example a token under 16 characters, or a malformed `WEB_ALLOWED_HOSTS`) stops the server at startup with a message that names the setting. |
| `403 Forbidden host` | The name or IP you typed isn't in `WEB_ALLOWED_HOSTS`. Add it and run `docker compose up -d`. |
| `401` or a sign-in box that keeps returning | The token is wrong. Compare it with `WEATHER_MCP_TOKEN` in `.env`, and check for a leftover placeholder such as `Bearer <token>` in a client config. |
| Port already in use | Another program has 3003. Set `WEATHER_MCP_PORT` in `.env`. |
| Saved locations aren't kept or the container can't write | `./data` is owned by another user. Run `sudo chown 1000:1000 data`. |
| "NOMADS model data is unavailable on this platform" | The GRIB decoder didn't load. Rebuild with `docker compose build --no-cache`; if it persists, open an issue with the output of `docker compose logs`. Other tools keep working. |
| NAM shows "model file not found" | NOAA hasn't posted that NAM run yet; try again later. GFS and HRRR are unaffected. |
| **Use my location** button is missing | Browsers only allow it on `https://` or `localhost`. Use Tailscale HTTPS, or type coordinates or a place name. |
| A client shows no weather tools | Restart the client, then check its log. Claude Desktop's is `~/Library/Logs/Claude/mcp-server-weather.log` on macOS. |

## Going back to a local setup

Point your clients back at the local command (`node /path/to/weather-mcp/dist/index.js`, or `npx -y @dangahagan/weather-mcp@latest`; see the [Client Setup Guide](./CLIENT_SETUP.md)) and, if you like, `docker compose down`. Your `./data` folder stays where it is.

## How it works

The image is built in stages on `node:22-bookworm-slim`: compile the TypeScript, install production dependencies (adding the WebAssembly GRIB decoder when the native one won't load), then assemble a small runtime image. Debian is used instead of Alpine because the decoder's native Linux builds need glibc.

The server is a single Node process. `/mcp` is a stateless Streamable HTTP endpoint; the web console reaches the same tools through an in-process MCP client, so the browser and AI clients share one cache and one set of saved locations. See [Application Flow](./APPLICATION_FLOW.md) and the [Docker deployment plan](./planning/DOCKER_DEPLOYMENT_PLAN.md) for the design and test results.
