/**
 * Unit tests for HRRR's CONUS-domain pre-check in NOMADSService
 *
 * getHrrrForecast validates coordinates against HRRR's CONUS domain before
 * making any network request, so this is testable without mocking HTTP.
 */

import { describe, it, expect } from 'vitest';
import { NOMADSService } from '../../src/services/nomads.js';
import { InvalidLocationError } from '../../src/errors/ApiError.js';

describe('NOMADSService.getHrrrForecast domain validation', () => {
  const service = new NOMADSService();

  it('rejects coordinates well outside CONUS (e.g. Tokyo) before any network call', async () => {
    await expect(service.getHrrrForecast(35.6762, 139.6503, 1)).rejects.toThrow(InvalidLocationError);
  });

  it('rejects coordinates north of the CONUS domain (e.g. Anchorage, AK)', async () => {
    await expect(service.getHrrrForecast(61.2181, -149.9003, 1)).rejects.toThrow(InvalidLocationError);
  });

  it('rejects coordinates west of the CONUS domain (e.g. Honolulu, HI)', async () => {
    await expect(service.getHrrrForecast(21.3069, -157.8583, 1)).rejects.toThrow(InvalidLocationError);
  });

  it('rejects invalid latitude/longitude before the domain check', async () => {
    await expect(service.getHrrrForecast(999, -94.2106, 1)).rejects.toThrow(/Invalid latitude/);
  });
});
