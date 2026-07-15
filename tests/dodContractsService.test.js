const dodContracts = require('../src/services/dodContractsService');

const RSS_XML = `<?xml version="1.0" encoding="utf-8"?>
<rss><channel>
  <item>
    <title>Contracts for July 14, 2026</title>
    <link>https://www.war.gov/News/Contracts/Contract/Article/1/contracts-for-july-14-2026/</link>
    <description>Daily contract announcement summary.</description>
    <pubDate>Tue, 14 Jul 2026 21:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

const ANNOUNCEMENT_HTML = `
<main>
  <h1>Contracts for July 14, 2026</h1>
  <time datetime="2026-07-14T21:00:00Z"></time>
  <div class="body">
    <p>Lockheed Martin Corp., Bethesda, Maryland, is awarded a $145,000,000 firm-fixed-price contract for missile defense software and tactical aircraft support. Work will be performed in Orlando, Florida, and Ukraine, and is expected to be completed by July 2028. Fiscal 2026 research, development, test and evaluation funds in the amount of $145,000,000 are being obligated at the time of award. Air Force Life Cycle Management Center, Wright-Patterson Air Force Base, Ohio, is the contracting activity.</p>
    <p>Boeing Co., Arlington, Virginia, is awarded a $32.5 million modification for aircraft sustainment. Work will be performed in St. Louis, Missouri, and is expected to be completed by March 2027. Naval Air Systems Command, Patuxent River, Maryland, is the contracting activity.</p>
  </div>
</main>`;

describe('dodContractsService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses RSS contract announcement references', () => {
    const refs = dodContracts.parseContractsRss(RSS_XML);

    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      title: 'Contracts for July 14, 2026',
      url: 'https://www.war.gov/News/Contracts/Contract/Article/1/contracts-for-july-14-2026/',
      sourceType: 'rss',
    });
  });

  it('extracts contract rows, award values, branch, and inferred conflict caveats from announcement pages', () => {
    const announcement = dodContracts.parseAnnouncementPage(ANNOUNCEMENT_HTML, {
      title: 'Contracts for July 14, 2026',
      url: 'https://www.war.gov/News/Contracts/Contract/Article/1/contracts-for-july-14-2026/',
    });

    expect(announcement.contracts).toHaveLength(2);
    expect(announcement.contracts[0]).toMatchObject({
      contractorName: 'Lockheed Martin Corp.',
      awardValue: 145000000,
      branch: 'Air Force',
      placeOfPerformance: 'Orlando, Florida, and Ukraine',
      demandType: 'defense-technology-contract-demand',
    });
    expect(announcement.contracts[0].conflictInference).toMatchObject({
      inferred: true,
      confidence: 'medium',
    });
    expect(announcement.contracts[1]).toMatchObject({
      contractorName: 'Boeing Co.',
      awardValue: 32500000,
      branch: 'Navy',
    });
  });

  it('collects, evaluates, and compacts DoD daily contract context for BMCL', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => ({
      ok: true,
      text: async () => String(url).includes('/Article/1/') ? ANNOUNCEMENT_HTML : RSS_XML,
    }));
    const events = [];
    const context = await dodContracts.collectDodContractsContext({
      limit: 2,
      onEvent: (event) => events.push(event),
    });

    expect(context.available).toBe(true);
    expect(context.contractCount).toBe(2);
    expect(context.totalAnnouncedValue).toBe(177500000);
    expect(context.innovationContractCount).toBeGreaterThan(0);
    expect(events.map((event) => event.phase)).toContain('dod-contracts');

    const compact = dodContracts.compactForBmcl(context);
    expect(compact).toMatchObject({
      provider: 'dod-daily-contracts',
      available: true,
      contractCount: 2,
    });
    expect(compact.topContracts[0]).toMatchObject({
      contractorName: 'Lockheed Martin Corp.',
      awardValue: 145000000,
    });
    expect(compact.bmclUse).toMatch(/DoD\/War.gov/);
    expect(compact.caveat).toMatch(/USAspending/);
  });

  it('scores direct contractor matches as defense revenue-catalyst evidence', () => {
    const context = dodContracts.evaluateDodContractsContext({
      announcements: [dodContracts.parseAnnouncementPage(ANNOUNCEMENT_HTML, {
        title: 'Contracts for July 14, 2026',
        url: 'https://www.war.gov/News/Contracts/Contract/Article/1/contracts-for-july-14-2026/',
      })],
    });
    const score = dodContracts.scoreCandidate({
      candidate: { symbol: 'LMT', companyName: 'Lockheed Martin', sector: 'defense aerospace contractor' },
      dodContractsContext: context,
    });

    expect(score.compositeScore).toBeGreaterThan(60);
    expect(score.signals[0].contractorName).toBe('Lockheed Martin Corp.');
    expect(score.explanation).toMatch(/DoD daily contracts found/);
  });
});
