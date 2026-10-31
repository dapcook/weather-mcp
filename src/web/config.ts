/**
 * Web server settings, read from environment variables and validated at
 * startup so a bad value fails loudly instead of silently widening access.
 *
 *   WEB_HOST           Address to listen on (default 127.0.0.1; 0.0.0.0 in a container)
 *   WEB_PORT           Port to listen on (1024-65535, default 8787)
 *   WEB_ALLOWED_HOSTS  Extra hostnames/IPs browsers and clients may use to reach
 *                      this server, comma-separated (loopback names always allowed)
 *   WEATHER_MCP_TOKEN  If set, /mcp and /api/* require "Authorization: Bearer <token>"
 */

export interface WebConfig {
  host: string;
  port: number;
  /** Lowercased hostnames (no port) accepted in Host and Origin headers */
  allowedHosts: string[];
  /** Shared secret required on /mcp and /api/* when set */
  token?: string;
}

export const DEFAULT_WEB_HOST = '127.0.0.1';
export const DEFAULT_WEB_PORT = 8787;
export const MIN_TOKEN_LENGTH = 16;

/** Always allowed: a DNS-rebinding attack arrives under the attacker's name, never these */
export const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1'];

const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const IPV6_PATTERN = /^[0-9a-f:.]+$/;

function parsePort(value: string | undefined): number {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_WEB_PORT;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`WEB_PORT must be an integer between 1024 and 65535 (got "${value}")`);
  }
  return port;
}

function parseAllowedHosts(value: string | undefined): string[] {
  const extra = (value ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1'))
    .filter(Boolean);

  for (const entry of extra) {
    if (entry.includes('/') || entry.includes('*') || !(HOSTNAME_PATTERN.test(entry) || IPV6_PATTERN.test(entry))) {
      throw new Error(
        `WEB_ALLOWED_HOSTS entries must be plain hostnames or IP addresses without scheme, port, or wildcards (got "${entry}")`
      );
    }
  }

  return [...new Set([...LOOPBACK_HOSTS, ...extra])];
}

function parseToken(value: string | undefined): string | undefined {
  const token = value?.trim();
  if (!token) {
    return undefined;
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `WEATHER_MCP_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters (generate one with: openssl rand -hex 32)`
    );
  }
  return token;
}

export function loadWebConfig(env: NodeJS.ProcessEnv = process.env): WebConfig {
  const host = env.WEB_HOST?.trim() || DEFAULT_WEB_HOST;
  return {
    host,
    port: parsePort(env.WEB_PORT),
    allowedHosts: parseAllowedHosts(env.WEB_ALLOWED_HOSTS),
    token: parseToken(env.WEATHER_MCP_TOKEN),
  };
}
