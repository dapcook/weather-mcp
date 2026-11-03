/**
 * What the user sees when Open-Meteo answers 429 (rate limited).
 *
 * Runs the real OpenMeteoService against a local server that returns canned 429
 * responses, so the error handling is exercised end to end without the network.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { OpenMeteoService } from '../../src/services/openmeteo.js';
import { RateLimitError, formatErrorForUser } from '../../src/errors/ApiError.js';

type Reply = (res: ServerResponse) => void;

describe('Open-Meteo rate limit (HTTP 429)', () => {
  let server: Server;
  let service: OpenMeteoService;
  let requests = 0;
  let reply: Reply;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      requests += 1;
      reply(res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    service = new OpenMeteoService({ baseURL: `http://127.0.0.1:${port}/v1`, timeout: 5000 });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    requests = 0;
  });

  const load = () => service.getDailyTemperatureRecord(39.01, -94.21, '2024-01-01', '2024-01-31');
  const sendJson = (res: ServerResponse, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(429, { 'Content-Type': 'application/json', ...headers });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const caught = async (): Promise<RateLimitError> => {
    const error = await load().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    return error as RateLimitError;
  };

  it("passes on Open-Meteo's own explanation of which limit was hit", async () => {
    reply = (res) => sendJson(res, { error: true, reason: 'Minutely API request limit exceeded. Please try again in one minute.' });
    const error = await caught();
    expect(error.statusCode).toBe(429);
    expect(error.service).toBe('OpenMeteo');
    expect(error.userMessage).toContain('Minutely API request limit exceeded. Please try again in one minute.');
    expect(error.userMessage).toContain('cover many days count as several calls');
  });

  it('links to Open-Meteo, never to NOAA', async () => {
    reply = (res) => sendJson(res, { error: true, reason: 'Hourly API request limit exceeded.' });
    const error = await caught();
    expect(error.helpLinks.length).toBeGreaterThan(0);
    expect(error.helpLinks.every((link) => link.startsWith('https://open-meteo.com/'))).toBe(true);

    const shown = formatErrorForUser(error);
    expect(shown).toContain('open-meteo.com/en/pricing');
    expect(shown).not.toMatch(/weather\.gov|noaa\.gov/);
  });

  it('shows how long to wait when Open-Meteo sends Retry-After', async () => {
    reply = (res) => sendJson(res, { error: true, reason: 'Minutely API request limit exceeded.' }, { 'Retry-After': '45' });
    const error = await caught();
    expect(error.retryAfter).toBe(45);
    expect(error.userMessage).toContain('Retry after 45 seconds.');
  });

  it.each(['0', '-5', 'soon', '99999', 'Wed, 21 Oct 2026 07:28:00 GMT'])('ignores an unusable Retry-After (%s)', async (value) => {
    reply = (res) => sendJson(res, { error: true, reason: 'Limit.' }, { 'Retry-After': value });
    const error = await caught();
    expect(error.retryAfter).toBeUndefined();
    expect(error.userMessage).not.toContain('Retry after');
  });

  it('still gives a useful message when the response has no reason', async () => {
    reply = (res) => sendJson(res, '');
    const error = await caught();
    expect(error.userMessage).toContain('Open-Meteo is limiting requests from this connection');
    expect(error.userMessage).toContain('about a minute');
  });

  it('copes with a non-JSON or non-string reason', async () => {
    reply = (res) => sendJson(res, '<html>Too Many Requests</html>');
    expect((await caught()).userMessage).toContain('Open-Meteo is limiting requests');

    reply = (res) => sendJson(res, { error: true, reason: { nested: 'object' } });
    expect((await caught()).userMessage).toContain('Open-Meteo is limiting requests');
  });

  it('cleans the reason before showing it: control characters removed, length capped', async () => {
    reply = (res) => sendJson(res, { error: true, reason: `Too\u0000 many\r\n\trequests ${'x'.repeat(500)}` });
    const { userMessage } = await caught();
    // eslint-disable-next-line no-control-regex
    expect(userMessage).not.toMatch(/[\u0000-\u0008\u000b-\u001f]/);
    expect(userMessage).toContain('Too many requests x');
    expect(userMessage).not.toContain('x'.repeat(201));
  });

  it('makes one request and does not retry within the same minute', async () => {
    reply = (res) => sendJson(res, { error: true, reason: 'Minutely API request limit exceeded.' });
    await caught();
    expect(requests).toBe(1);
  });
});
