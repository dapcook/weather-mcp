import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import { NOAAService } from '../../src/services/noaa.js';
import { handleGetForecastDiscussion } from '../../src/handlers/forecastDiscussionHandler.js';
import { parseAfdText, extractJargonMatches } from '../../src/utils/forecastDiscussion.js';
import { DataNotFoundError, ValidationError } from '../../src/errors/ApiError.js';

const SAMPLE_AFD_TEXT = `
000
FXUS63 KEAX 212325
AFDEAX

Area Forecast Discussion
National Weather Service Kansas City/Pleasant Hill MO
525 PM CST Sat Nov 21 2026

.KEY MESSAGES...

- Gusty southerly winds around 25-30 mph today ahead of a cold front.

- Widespread showers (80-95%) tonight with isolated thunderstorms.

&&
.DISCUSSION...
Issued at 327 PM CST Sat Nov 21 2026

Current analysis reveals a 500mb trough over the Rockies pushing a
cold front east. WAA ahead of the front keeps highs in the upper 60s.
The NBM and ECMWF agree well on QPF amounts around 0.50 inches after
06Z, though the HRRR shows slightly higher CAPE near the LLJ.

&&
.AVIATION...
For the 00Z TAFs: VFR conditions will drop to MVFR and IFR ceilings
overnight as FROPA occurs.
$$
`;

describe('forecastDiscussion utilities', () => {
  it('parses NWS AFD office header, sections, and reflows wrapped paragraphs', () => {
    const parsed = parseAfdText(SAMPLE_AFD_TEXT);
    expect(parsed.officeName).toBe('National Weather Service Kansas City/Pleasant Hill MO');
    expect(parsed.headlineTime).toBe('525 PM CST Sat Nov 21 2026');
    expect(parsed.sections).toHaveLength(3);

    expect(parsed.sections[0].id).toBe('key_messages');
    expect(parsed.sections[0].title).toBe('Key Messages');
    expect(parsed.sections[0].content).toContain('- Gusty southerly winds around 25-30 mph today ahead of a cold front.');

    expect(parsed.sections[1].id).toBe('discussion');
    expect(parsed.sections[1].content).toContain('*Issued at 327 PM CST Sat Nov 21 2026*');
    expect(parsed.sections[1].content).toContain('Current analysis reveals a 500mb trough over the Rockies pushing a cold front east.');

    expect(parsed.sections[2].id).toBe('aviation');
    expect(parsed.sections[2].content).not.toContain('$$');
  });

  it('extracts relevant meteorological jargon explanations', () => {
    const matches = extractJargonMatches(SAMPLE_AFD_TEXT);
    const terms = matches.map((m) => m.term);
    expect(terms).toContain('WAA');
    expect(terms).toContain('500mb / 850mb / 700mb');
    expect(terms).toContain('Trough');
    expect(terms).toContain('NBM');
    expect(terms).toContain('ECMWF / Euro');
    expect(terms).toContain('QPF');
    expect(terms).toContain('CAPE');
    expect(terms).toContain('LLJ');
    expect(terms).toContain('FROPA');
    expect(terms).toContain('VFR / MVFR / IFR / LIFR');
    expect(terms).toContain('Zulu (Z / UTC)');
  });
});

describe('NoaaService.getForecastDiscussion & handler', () => {
  let server: Server;
  let baseUrl = '';
  let emptyAfd = false;

  beforeEach(async () => {
    emptyAfd = false;
    server = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      const url = req.url || '';
      if (url.startsWith('/points/')) {
        res.end(JSON.stringify({
          properties: {
            gridId: 'EAX',
            cwa: 'EAX',
            gridX: 44,
            gridY: 51,
            forecast: `${baseUrl}/gridpoints/EAX/44,51/forecast`,
            forecastHourly: `${baseUrl}/gridpoints/EAX/44,51/forecast/hourly`,
            observationStations: `${baseUrl}/gridpoints/EAX/44,51/stations`,
          },
        }));
        return;
      }
      if (url.startsWith('/products/types/AFD/locations/')) {
        res.end(JSON.stringify({
          '@graph': emptyAfd
            ? []
            : [
                {
                  id: 'prod-123',
                  issuingOffice: 'KEAX',
                  issuanceTime: '2026-11-21T23:25:00+00:00',
                  productCode: 'AFD',
                  productName: 'Area Forecast Discussion',
                },
              ],
        }));
        return;
      }
      if (url === '/products/prod-123') {
        res.end(JSON.stringify({
          id: 'prod-123',
          issuingOffice: 'KEAX',
          issuanceTime: '2026-11-21T23:25:00+00:00',
          productCode: 'AFD',
          productName: 'Area Forecast Discussion',
          productText: SAMPLE_AFD_TEXT,
        }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ detail: 'Not found' }));
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('fetches, parses, and returns structured AFD with jargon matches', async () => {
    const service = new NOAAService({ baseURL: baseUrl });
    const res = await service.getForecastDiscussion(39.0115, -94.2106);
    expect(res.wfo).toBe('EAX');
    expect(res.issuingOffice).toBe('KEAX');
    expect(res.sections).toHaveLength(3);
    expect(res.jargon.length).toBeGreaterThan(5);
  });

  it('throws DataNotFoundError when office has no AFD products', async () => {
    emptyAfd = true;
    const service = new NOAAService({ baseURL: baseUrl });
    await expect(service.getForecastDiscussion(39.0115, -94.2106)).rejects.toThrow(DataNotFoundError);
  });

  it('formats markdown output with section filter and jargon guide toggle', async () => {
    const service = new NOAAService({ baseURL: baseUrl });
    const fullRes = await handleGetForecastDiscussion(
      { latitude: 39.0115, longitude: -94.2106 },
      service
    );
    expect(fullRes.content[0].text).toContain('# NWS Area Forecast Discussion (EAX)');
    expect(fullRes.content[0].text).toContain('## Key Messages');
    expect(fullRes.content[0].text).toContain('## Novice Forecaster Jargon Guide');
    expect(fullRes.content[0].text).toContain('Warm Air Advection');

    const filteredRes = await handleGetForecastDiscussion(
      { latitude: 39.0115, longitude: -94.2106, section: 'key_messages', include_jargon_guide: false },
      service
    );
    expect(filteredRes.content[0].text).toContain('## Key Messages');
    expect(filteredRes.content[0].text).not.toContain('## Aviation');
    expect(filteredRes.content[0].text).not.toContain('## Novice Forecaster Jargon Guide');
  });

  it('rejects invalid section filter', async () => {
    const service = new NOAAService({ baseURL: baseUrl });
    await expect(
      handleGetForecastDiscussion({ latitude: 39.0115, longitude: -94.2106, section: 'bogus' }, service)
    ).rejects.toThrow(ValidationError);
  });
});
