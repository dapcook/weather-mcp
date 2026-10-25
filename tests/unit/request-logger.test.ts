/**
 * The request lifecycle log goes to WEATHER_MCP_DATA_DIR when set, so a container
 * with a read-only home directory can still write it to its data volume.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const event = {
  timestamp: '2026-10-25T12:00:00.000Z',
  requestId: 'req-123',
  tool: 'get_forecast',
  status: 'success' as const,
  durationMs: 42,
};

describe('logRequestLifecycle', () => {
  let dir: string;
  let originalDataDir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'weather-mcp-reqlog-test-'));
    originalDataDir = process.env.WEATHER_MCP_DATA_DIR;
    vi.resetModules(); // the log path is resolved when the module loads
  });

  afterEach(() => {
    if (originalDataDir === undefined) {
      delete process.env.WEATHER_MCP_DATA_DIR;
    } else {
      process.env.WEATHER_MCP_DATA_DIR = originalDataDir;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes requests.log into WEATHER_MCP_DATA_DIR', async () => {
    process.env.WEATHER_MCP_DATA_DIR = dir;
    const { logRequestLifecycle } = await import('../../src/utils/requestLogger.js');

    logRequestLifecycle(event);

    const logPath = join(dir, 'requests.log');
    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, 'utf-8')).toBe(
      '2026-10-25T12:00:00.000Z request_id=req-123 tool=get_forecast status=success duration_ms=42\n'
    );
  });

  it('creates the data directory if it does not exist yet', async () => {
    const nested = join(dir, 'not', 'yet', 'there');
    process.env.WEATHER_MCP_DATA_DIR = nested;
    const { logRequestLifecycle } = await import('../../src/utils/requestLogger.js');

    logRequestLifecycle(event);

    expect(existsSync(join(nested, 'requests.log'))).toBe(true);
  });

  it('treats a blank WEATHER_MCP_DATA_DIR as unset (falls back to the home directory)', async () => {
    process.env.WEATHER_MCP_DATA_DIR = '   ';
    const writes: string[] = [];
    vi.doMock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        existsSync: () => true,
        appendFileSync: (path: string) => {
          writes.push(String(path));
        },
      };
    });
    try {
      const { logRequestLifecycle } = await import('../../src/utils/requestLogger.js');
      logRequestLifecycle(event);
    } finally {
      vi.doUnmock('fs');
    }

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/\.weather-mcp[/\\]requests\.log$/);
    expect(writes[0].startsWith(dir)).toBe(false);
  });
});
