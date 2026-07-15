const usaspending = require('../src/services/usaspendingAwardsService');

const AWARD_RESPONSE = {
  page_metadata: { total: 2 },
  results: [
    {
      'Award ID': 'CONT_AWD_123',
      'Recipient Name': 'Lockheed Martin Corporation',
      'Award Amount': 125000000,
      'Start Date': '2026-01-15',
      'End Date': '2028-01-14',
      'Awarding Agency': 'Department of Defense',
      'Awarding Sub Agency': 'Department of the Air Force',
      'Funding Agency': 'Department of Defense',
      'Description': 'Missile defense sustainment and tactical aircraft support for Ukraine security assistance',
      'Place of Performance Country Code': 'UKR',
      'Place of Performance State Code': '',
      PSC: '1410',
      NAICS: '336414',
    },
    {
      'Award ID': 'CONT_AWD_456',
      'Recipient Name': 'Acme Bridge Builders Inc',
      'Award Amount': 32000000,
      'Start Date': '2026-02-01',
      'End Date': '2027-02-01',
      'Awarding Agency': 'Department of Transportation',
      'Description': 'Bridge infrastructure construction and engineering services',
      'Place of Performance Country Code': 'USA',
      'Place of Performance State Code': 'MO',
      PSC: 'Y1LB',
      NAICS: '237310',
    },
  ],
};

describe('usaspendingAwardsService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds USAspending award-search filters for defense contractor research', () => {
    const request = usaspending.buildAwardSearchRequest({
      recipientNames: ['Lockheed Martin'],
      awardingAgency: 'Department of Defense',
      placeOfPerformanceCountry: 'Afghanistan',
      pscCodes: ['1410'],
      naicsCodes: ['336414'],
      dateRange: { start: '2020-01-01', end: '2026-12-31' },
      keywords: ['missile defense'],
    });

    expect(request.filters).toMatchObject({
      recipient_search_text: ['Lockheed Martin'],
      award_type_codes: ['A', 'B', 'C', 'D'],
      place_of_performance_locations: [{ country: 'AFG' }],
      psc_codes: ['1410'],
      naics_codes: ['336414'],
      keywords: ['missile defense'],
      time_period: [{ start_date: '2020-01-01', end_date: '2026-12-31' }],
    });
    expect(request.filters.agencies[0]).toMatchObject({
      type: 'awarding',
      tier: 'toptier',
      name: 'Department of Defense',
    });
  });

  it('collects, scores, and compacts federal award context for BMCL', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => ({
      ok: true,
      json: async () => String(url).includes('spending_by_award_count')
        ? { results: [{ awardType: 'contracts', count: 2 }] }
        : AWARD_RESPONSE,
      text: async () => '',
    }));
    const events = [];
    const context = await usaspending.collectFederalAwardsContext({
      recipientNames: ['Lockheed Martin'],
      awardingAgency: 'Department of Defense',
      placeOfPerformanceCountry: 'UKR',
      limit: 2,
      onEvent: (event) => events.push(event),
    });

    expect(context.available).toBe(true);
    expect(context.returnedAwardCount).toBe(2);
    expect(context.totalObligated).toBe(157000000);
    expect(context.defenseAwardCount).toBe(1);
    expect(context.infrastructureAwardCount).toBe(1);
    expect(context.inferredConflictAwardCount).toBe(1);
    expect(context.inferredConflictAwards[0].conflictInference).toMatchObject({
      inferred: true,
      confidence: 'medium',
    });
    expect(events.map((event) => event.phase)).toContain('usaspending-awards');

    const compact = usaspending.compactForBmcl(context);
    expect(compact.provider).toBe('usaspending');
    expect(compact.topAwards[0]).toMatchObject({
      recipientName: 'Lockheed Martin Corporation',
      amount: 125000000,
      demandType: 'defense-government-demand',
    });
    expect(compact.bmclUse).toMatch(/war\/conflict relationships as inferred/);
  });

  it('scores direct contractor matches as government-demand evidence', () => {
    const context = usaspending.evaluateFederalAwardsContext({
      awards: usaspending.normalizeAwards(AWARD_RESPONSE.results),
    });
    const score = usaspending.scoreCandidate({
      candidate: { symbol: 'LMT', companyName: 'Lockheed Martin', sector: 'defense aerospace contractor' },
      awardsContext: context,
    });

    expect(score.compositeScore).toBeGreaterThan(60);
    expect(score.signals[0].recipientName).toBe('Lockheed Martin Corporation');
    expect(score.explanation).toMatch(/federal award row/);
  });
});
