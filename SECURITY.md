# Security Policy

## Supported Versions

We release patches for security vulnerabilities for the following versions:

| Version | Supported          |
| ------- | ------------------ |
| 1.7.x   | :white_check_mark: |
| 1.6.x   | :white_check_mark: |
| 1.5.x   | :white_check_mark: |
| 1.4.x   | :white_check_mark: |
| 1.3.x   | :white_check_mark: |
| 1.2.x   | :white_check_mark: |
| 1.1.x   | :white_check_mark: |
| 1.0.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

We take the security of the Weather MCP Server seriously. If you believe you have found a security vulnerability, please report it to us as described below.

### Where to Report

**Please do NOT report security vulnerabilities through public GitHub issues.**

Instead, please report them via one of the following methods:

1. **GitHub Security Advisory** (Preferred): Use the [GitHub Security Advisory](https://github.com/weather-mcp/weather-mcp/security/advisories/new) feature
2. **Email**: Send an email to the project maintainer via GitHub profile contact information
3. **GitHub Issues**: For non-critical security concerns, you may open a regular issue with the `security` label

### What to Include

Please include the following information in your report:

- Type of vulnerability (e.g., buffer overflow, SQL injection, cross-site scripting, etc.)
- Full paths of source file(s) related to the manifestation of the vulnerability
- The location of the affected source code (tag/branch/commit or direct URL)
- Any special configuration required to reproduce the issue
- Step-by-step instructions to reproduce the issue
- Proof-of-concept or exploit code (if possible)
- Impact of the issue, including how an attacker might exploit it

### Response Timeline

- **Acknowledgment**: We will acknowledge receipt of your vulnerability report within **48 hours**
- **Initial Assessment**: We will provide an initial assessment of the vulnerability within **7 days**
- **Fix Timeline**:
  - **Critical vulnerabilities**: Patch within 7-14 days
  - **High vulnerabilities**: Patch within 14-30 days
  - **Medium vulnerabilities**: Patch in next regular release
  - **Low vulnerabilities**: May be addressed in future releases

### Security Update Policy

- Security patches will be released as soon as possible after verification
- Security advisories will be published after patches are available
- CVE IDs will be requested for vulnerabilities when appropriate
- Security releases will be clearly marked in release notes

## Security Best Practices for Users

### Dependency Security

This project keeps its runtime dependencies few to reduce attack surface:

- `@modelcontextprotocol/sdk` - Official MCP SDK from Anthropic
- `axios` - HTTP client
- `dotenv` - Environment variable loader
- `luxon` - Time zone and date handling
- `mqtt` - Blitzortung lightning feed
- `ngeohash` - Geohash encoding (lightning subscriptions)
- `@mattnucc/gribberish` - GRIB decoding for NOMADS model data (a native module; its WebAssembly build is used on platforms without a native one)

**Automated Scanning:**

Run dependency audits regularly:
```bash
npm run audit
```

To automatically fix vulnerabilities (when safe):
```bash
npm run audit:fix
```

### GitHub Dependabot

We recommend enabling GitHub Dependabot for automated dependency updates:

1. Dependabot is enabled by default for public GitHub repositories
2. Configure `.github/dependabot.yml` if you want to customize update frequency
3. Review and merge Dependabot PRs promptly

Example `.github/dependabot.yml`:
```yaml
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
    open-pull-requests-limit: 10
```

### Environment Security

- Never commit `.env` files or API keys to version control
- This server uses **public APIs only** and requires no authentication credentials
- Use environment variables for configuration (see README.md)

### Deployment Security

- Run the server with minimum necessary privileges
- Keep Node.js updated to the latest LTS version
- Use `npm ci` instead of `npm install` in production for reproducible builds
- Consider running in a containerized environment for isolation; the included `Dockerfile` and `docker-compose.yml` run as a non-root user with a read-only filesystem and all Linux capabilities dropped (see [docs/DOCKER.md](./docs/DOCKER.md#security))
- If you expose the HTTP endpoint beyond your own machine, set `WEATHER_MCP_TOKEN` and `WEB_ALLOWED_HOSTS` (see below)

## Known Security Considerations

### No Authentication Required for the Weather APIs

This MCP server uses public weather APIs (NOAA, Open-Meteo, and others) that do not require API keys or authentication. This is by design and reduces security complexity. The only optional credential is a free NCEI token (`NCEI_API_TOKEN`) for official US climate normals.

### Network-Exposed Mode (HTTP `/mcp` and Web Console)

By default the server uses stdio and opens no network port. `npm run web` (and the Docker container) additionally serve an MCP endpoint at `/mcp` and a web console over HTTP:

- **Localhost by default:** it listens on `127.0.0.1` unless `WEB_HOST` says otherwise. The container listens on all interfaces and expects a token.
- **Set a token when reachable by others:** `WEATHER_MCP_TOKEN` (16+ characters) is required as `Authorization: Bearer <token>` on `/mcp` and the console's `/api/*` routes, and is compared in constant time. Without it, anyone who can reach the port can use every tool, including saving and deleting saved locations. The server logs a warning when it listens beyond localhost without one.
- **Host and Origin checks:** requests must use `localhost` or a name in `WEB_ALLOWED_HOSTS` (blocks DNS rebinding), and browser requests must come from those same names (blocks cross-site requests).
- **Plain HTTP:** the server does not provide TLS, so the token travels unencrypted. Use it on a trusted network, or put it behind a private network or reverse proxy that provides HTTPS. Do not forward its port to the internet.
- **Console API limits:** `POST` bodies must be JSON and are capped at 64 KB; only tools the server lists can be called, and every call goes through the normal input validation
- **Logs:** request paths are logged without their query strings, because those carry coordinates and place names
- **Stateless `/mcp`:** each request gets its own MCP server and transport, so nothing is shared between clients except the read-only weather caches and the saved-locations file.

### Data Privacy

- **Location Data**: Coordinates are processed for API requests, and redacted in logs (rounded to about 1.1 km) unless `LOG_PII=true`
- **Saved Locations**: If you use the saved locations feature, the names and coordinates you choose are stored in a local JSON file (`~/.weather-mcp/locations.json`, or `locations.json` in `WEATHER_MCP_DATA_DIR`). They can identify where you live or visit, so keep that file (or the Docker `data/` folder) private and out of version control. The file itself stays on your machine, but the coordinates in it are sent to the weather services whenever you query a saved location (like any other query), and a place you save by name is looked up through Nominatim
- **No Other Personal Data**: No account, email, or other personal information is collected
- **Local Cache**: Weather data is cached in memory on the machine running the server
- **No Tracking by Default**: Anonymous usage analytics are opt-in (`ANALYTICS_ENABLED=true`, off by default), and never include coordinates or location names

### Network Security

- External API calls use **HTTPS**, with certificate validation enabled by default (via axios), with one exception: the lightning feed (`get_lightning_activity`) connects to the Blitzortung community MQTT broker, which is **plain, unencrypted MQTT**. It only receives geohash subscriptions (roughly 4 to 40 km precision, not exact coordinates); set `BLITZORTUNG_MQTT_URL` to a TLS broker to avoid this (see `.env.example`)
- Place searches send the place name you typed to Nominatim, the US Census geocoder, and/or Open-Meteo
- The web console's radar map makes your browser (not the server) request map tiles from Esri and RainViewer

## Security Testing

### Current Security Controls

✅ **Implemented:**
- Comprehensive input validation with runtime type checking
- Error sanitization to prevent information leakage
- No hardcoded secrets or credentials
- Strong TypeScript typing with strict mode
- Graceful shutdown and resource cleanup
- Structured logging
- Comprehensive test coverage (131+ tests)

### Recommended Security Testing

1. **Dependency Auditing**: `npm run audit` (weekly)
2. **Static Analysis**: TypeScript strict mode catches many issues
3. **Input Fuzzing**: Test coordinate inputs with edge cases
4. **Error Path Testing**: Verify error messages don't leak sensitive info

## Security Audit History

- **2025-11-10**: Comprehensive security audit for v1.6.0 release (See SECURITY_AUDIT.md)
  - Overall Security Posture: **A- (Excellent, 93/100)**
  - Risk Level: **LOW**
  - Zero critical or high-severity vulnerabilities
  - 1,042 tests passing with 100% pass rate
  - Code Quality: A+ (97.5/100)

- **2025-11-06**: Initial comprehensive security audit for v1.5.0
  - Overall Security Posture: **B+ (Good)**
  - Risk Level: **LOW**
  - Zero critical or high-severity vulnerabilities
  - All recommended critical fixes implemented

## Scope Exclusions

The following are **out of scope** for security reports:

- Vulnerabilities in third-party APIs (NOAA, Open-Meteo)
- Runtime environment security (Node.js, OS)
- Network infrastructure
- Physical security
- Social engineering

## Additional Resources

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)
- [npm Security Best Practices](https://docs.npmjs.com/security-best-practices)
- [GitHub Security Features](https://docs.github.com/en/code-security)

## Questions?

If you have questions about this security policy, please open a GitHub issue with the `question` label.

---

**Last Updated**: November 10, 2025
**Next Security Review**: May 2026 (6 months) or upon major version release
