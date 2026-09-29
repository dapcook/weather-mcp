/**
 * Request access checks for the web server: which hostnames it answers to,
 * which browser origins may call it, and the optional bearer token.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

/** Hostname from a Host header value ("example.local:3003", "[::1]:8787", "10.0.0.5") */
export function hostnameFromHostHeader(hostHeader: string): string {
  const value = hostHeader.trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end === -1 ? value : value.slice(1, end);
  }
  // A single colon separates the port; more than one means an (invalid) bare IPv6 address
  const parts = value.split(':');
  return parts.length === 2 ? parts[0] : value;
}

/**
 * Only answer requests addressed to a known name. Blocks DNS rebinding, where a
 * malicious site points its own hostname at this server's address.
 */
export function isAllowedHost(hostHeader: string | undefined, allowedHosts: readonly string[]): boolean {
  if (!hostHeader) {
    return false;
  }
  return allowedHosts.includes(hostnameFromHostHeader(hostHeader));
}

/**
 * Browsers send Origin on cross-site requests; only this server's own names may
 * call it. Requests without Origin (MCP clients, curl) are not from a web page.
 */
export function isAllowedOrigin(origin: string | undefined, allowedHosts: readonly string[]): boolean {
  if (origin === undefined) {
    return true;
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false; // includes the opaque origin "null"
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return false;
  }
  return allowedHosts.includes(url.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1'));
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * Check "Authorization: Bearer <token>". Always true when no token is configured.
 * Compares fixed-length digests in constant time so timing reveals nothing.
 */
export function hasValidToken(authorizationHeader: string | undefined, token: string | undefined): boolean {
  if (!token) {
    return true;
  }
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorizationHeader ?? '');
  if (!match) {
    return false;
  }
  return timingSafeEqual(digest(match[1]), digest(token));
}
