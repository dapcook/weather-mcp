import { describe, it, expect } from 'vitest';
import { loadWebConfig, LOOPBACK_HOSTS, DEFAULT_WEB_HOST, DEFAULT_WEB_PORT } from '../../src/web/config.js';
import { hasValidToken, hostnameFromHostHeader, isAllowedHost, isAllowedOrigin } from '../../src/web/access.js';

describe('loadWebConfig', () => {
  it('defaults to loopback-only with no token', () => {
    expect(loadWebConfig({})).toEqual({
      host: DEFAULT_WEB_HOST,
      port: DEFAULT_WEB_PORT,
      allowedHosts: LOOPBACK_HOSTS,
      token: undefined,
    });
  });

  it('reads container-style settings', () => {
    const config = loadWebConfig({
      WEB_HOST: '0.0.0.0',
      WEB_PORT: '3003',
      WEB_ALLOWED_HOSTS: ' Pi.Local, 10.0.0.5 ,weather.home,[fd00::5]',
      WEATHER_MCP_TOKEN: 'a'.repeat(32),
    });
    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(3003);
    expect(config.allowedHosts).toEqual([...LOOPBACK_HOSTS, 'pi.local', '10.0.0.5', 'weather.home', 'fd00::5']);
    expect(config.token).toBe('a'.repeat(32));
  });

  it('treats a blank token as no token', () => {
    expect(loadWebConfig({ WEATHER_MCP_TOKEN: '   ' }).token).toBeUndefined();
  });

  it.each(['80', '70000', '3003.5', 'abc'])('rejects WEB_PORT=%s', (port) => {
    expect(() => loadWebConfig({ WEB_PORT: port })).toThrow(/WEB_PORT/);
  });

  it.each(['http://pi.local', 'pi.local:3003', '*.local', 'bad host', 'a/b'])('rejects allowed host "%s"', (entry) => {
    expect(() => loadWebConfig({ WEB_ALLOWED_HOSTS: entry })).toThrow(/WEB_ALLOWED_HOSTS/);
  });

  it('rejects a short token', () => {
    expect(() => loadWebConfig({ WEATHER_MCP_TOKEN: 'short' })).toThrow(/at least 16 characters/);
  });
});

describe('host and origin checks', () => {
  const allowed = [...LOOPBACK_HOSTS, 'pi.local', '10.0.0.5'];

  it('extracts hostnames from Host headers', () => {
    expect(hostnameFromHostHeader('Pi.Local:3003')).toBe('pi.local');
    expect(hostnameFromHostHeader('10.0.0.5')).toBe('10.0.0.5');
    expect(hostnameFromHostHeader('[::1]:8787')).toBe('::1');
  });

  it('accepts allowed names with or without a port', () => {
    expect(isAllowedHost('pi.local:3003', allowed)).toBe(true);
    expect(isAllowedHost('10.0.0.5', allowed)).toBe(true);
    expect(isAllowedHost('[::1]:3003', allowed)).toBe(true);
  });

  it('rejects unknown or missing hosts (DNS rebinding)', () => {
    expect(isAllowedHost('evil.example:3003', allowed)).toBe(false);
    expect(isAllowedHost('pi.local.evil.example', allowed)).toBe(false);
    expect(isAllowedHost(undefined, allowed)).toBe(false);
  });

  it('allows requests without an Origin (non-browser clients)', () => {
    expect(isAllowedOrigin(undefined, allowed)).toBe(true);
  });

  it('allows same-site origins over http or https', () => {
    expect(isAllowedOrigin('http://pi.local:3003', allowed)).toBe(true);
    expect(isAllowedOrigin('https://pi.local', allowed)).toBe(true);
  });

  it('rejects other sites, opaque and non-web origins', () => {
    expect(isAllowedOrigin('https://evil.example', allowed)).toBe(false);
    expect(isAllowedOrigin('null', allowed)).toBe(false);
    expect(isAllowedOrigin('file://pi.local', allowed)).toBe(false);
  });
});

describe('hasValidToken', () => {
  const token = 'x'.repeat(32);

  it('passes everything when no token is configured', () => {
    expect(hasValidToken(undefined, undefined)).toBe(true);
  });

  it('accepts the right bearer token (scheme is case-insensitive)', () => {
    expect(hasValidToken(`Bearer ${token}`, token)).toBe(true);
    expect(hasValidToken(`bearer ${token}`, token)).toBe(true);
  });

  it('rejects a missing, wrong, or malformed header', () => {
    expect(hasValidToken(undefined, token)).toBe(false);
    expect(hasValidToken(`Bearer ${'y'.repeat(32)}`, token)).toBe(false);
    expect(hasValidToken(`Bearer ${token.slice(1)}`, token)).toBe(false);
    expect(hasValidToken(token, token)).toBe(false);
    expect(hasValidToken(`Basic ${token}`, token)).toBe(false);
  });
});
