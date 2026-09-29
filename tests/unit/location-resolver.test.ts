import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocationStore } from '../../src/services/locationStore.js';
import { applySavedLocation, resolveLocation } from '../../src/utils/locationResolver.js';

describe('locationResolver', () => {
  let locationStore: LocationStore;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'weather-mcp-resolver-test-'));
    locationStore = new LocationStore(join(tempDir, 'locations.json'));
    locationStore.set('home', {
      name: 'Seattle, WA',
      latitude: 47.6062,
      longitude: -122.3321,
      alternateNames: ["Sister's Place"],
    });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('resolveLocation', () => {
    it('resolves a saved alias case-insensitively', () => {
      const result = resolveLocation({ location_name: '  HOME ' }, locationStore);
      expect(result).toEqual({
        latitude: 47.6062,
        longitude: -122.3321,
        source: 'saved_location',
        location_name: 'home',
      });
    });

    it('resolves an alternate name to its alias', () => {
      const result = resolveLocation({ location_name: "sister's place" }, locationStore);
      expect(result.location_name).toBe('home');
    });

    it('passes validated coordinates through', () => {
      const result = resolveLocation({ latitude: 40, longitude: -105 }, locationStore);
      expect(result).toEqual({ latitude: 40, longitude: -105, source: 'coordinates' });
    });

    it('lists available locations when the name is unknown', () => {
      expect(() => resolveLocation({ location_name: 'cabin' }, locationStore)).toThrow(/Available locations: home/);
    });
  });

  describe('applySavedLocation', () => {
    it('replaces location_name with the saved coordinates and keeps other args', () => {
      const result = applySavedLocation({ location_name: 'home', radius: 25 }, locationStore);
      expect(result).toEqual({ latitude: 47.6062, longitude: -122.3321, radius: 25 });
    });

    it('prefers location_name over coordinates supplied alongside it', () => {
      const result = applySavedLocation({ location_name: 'home', latitude: 1, longitude: 2 }, locationStore);
      expect(result).toMatchObject({ latitude: 47.6062, longitude: -122.3321 });
    });

    it('returns args unchanged when no location_name is given', () => {
      const args = { latitude: 40, longitude: -105, forecast: true };
      expect(applySavedLocation(args, locationStore)).toBe(args);
    });

    it('explains both options when no location is given at all', () => {
      const guidance = /Either location_name OR \(latitude \+ longitude\) must be provided/;
      expect(() => applySavedLocation(undefined, locationStore)).toThrow(guidance);
      expect(() => applySavedLocation({}, locationStore)).toThrow(guidance);
      expect(() => applySavedLocation({ radius: 10 }, locationStore)).toThrow(guidance);
    });

    it('leaves partial coordinates for the handler to validate', () => {
      const args = { latitude: 40 };
      expect(applySavedLocation(args, locationStore)).toBe(args);
    });

    it('rejects an empty or non-string location_name', () => {
      expect(() => applySavedLocation({ location_name: '   ' }, locationStore)).toThrow('location_name cannot be empty');
      expect(() => applySavedLocation({ location_name: 42 }, locationStore)).toThrow('location_name must be a string');
    });

    it('throws a helpful error for an unknown saved location', () => {
      expect(() => applySavedLocation({ location_name: 'cabin' }, locationStore)).toThrow(/Saved location "cabin" not found/);
    });
  });
});
