/**
 * Unit tests for lazy loading of the GRIB decoder in NOMADSService
 *
 * @mattnucc/gribberish ships native binaries for only some platforms (none for
 * linux-arm64). The decoder is loaded on first use so that a platform without
 * it loses only NOMADS data instead of the whole MCP server failing to start.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

async function importNomadsWithDecoder(decoder: () => unknown) {
  vi.resetModules();
  vi.doMock('@mattnucc/gribberish', decoder);
  const nomads = await import('../../src/services/nomads.js');
  const errors = await import('../../src/errors/ApiError.js');
  nomads.resetGribParserForTesting();
  return { ...nomads, ...errors };
}

describe('NOMADS GRIB decoder loading', () => {
  afterEach(() => {
    vi.doUnmock('@mattnucc/gribberish');
    vi.resetModules();
  });

  describe('when the native decoder cannot load (e.g. linux-arm64)', () => {
    const missingDecoder = () => {
      throw new Error("Cannot find native binding. Cannot find module '@mattnucc/gribberish-linux-arm64-gnu'");
    };

    it('still lets the NOMADS service module load', async () => {
      const { NOMADSService } = await importNomadsWithDecoder(missingDecoder);
      expect(() => new NOMADSService()).not.toThrow();
    });

    it('reports a clear, platform-specific error', async () => {
      const { loadGribParser, ServiceUnavailableError } = await importNomadsWithDecoder(missingDecoder);
      const error = await loadGribParser().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ServiceUnavailableError);
      expect((error as InstanceType<typeof ServiceUnavailableError>).userMessage).toMatch(
        /NOMADS model data is unavailable on this platform \(.+\): the GRIB decoder could not be loaded/
      );
    });

    it('fails a forecast before making any network request', async () => {
      const { NOMADSService, ServiceUnavailableError } = await importNomadsWithDecoder(missingDecoder);
      const service = new NOMADSService();
      const client = (service as unknown as { client: { get: (...args: unknown[]) => unknown } }).client;
      const get = vi.spyOn(client, 'get');

      await expect(service.getForecast(12.3456, 45.6789, 1)).rejects.toBeInstanceOf(ServiceUnavailableError);
      expect(get).not.toHaveBeenCalled();
    });

    it('remembers the failure instead of retrying the load', async () => {
      const decoder = vi.fn(missingDecoder);
      const { loadGribParser } = await importNomadsWithDecoder(decoder);
      await expect(loadGribParser()).rejects.toThrow();
      await expect(loadGribParser()).rejects.toThrow();
      expect(decoder).toHaveBeenCalledTimes(1);
    });
  });

  describe('when the decoder loads', () => {
    it('returns a parser that delegates to parseMessagesFromBuffer', async () => {
      const parseMessagesFromBuffer = vi.fn(() => [{ key: 'TMP', data: [1, 2, 3] }]);
      const { loadGribParser } = await importNomadsWithDecoder(() => ({ parseMessagesFromBuffer }));

      const parse = await loadGribParser();
      const buffer = Buffer.from('GRIB');
      expect(parse(buffer)).toEqual([{ key: 'TMP', data: [1, 2, 3] }]);
      expect(parseMessagesFromBuffer).toHaveBeenCalledWith(buffer);
    });
  });
});
