const secOwnership = require('../src/services/secInstitutionalOwnershipService');

const SEC_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>SC 13D - Acme Activist Fund LP for Acme Robotics Inc</title>
    <updated>2026-07-14T12:00:00-04:00</updated>
    <link href="https://www.sec.gov/Archives/edgar/data/1234567/0001234567-26-000001-index.htm" />
    <summary>Form SC 13D CIK 1234567 Issuer: Acme Robotics Inc Ticker: ACME Percent Owned: 9.8% activist board proposal accession number 0001234567-26-000001</summary>
  </entry>
  <entry>
    <title>13F-HR - North Star Capital Management</title>
    <updated>2026-07-14T11:00:00-04:00</updated>
    <link href="/Archives/edgar/data/7654321/0007654321-26-000002-index.htm" />
    <summary>Form 13F-HR CIK 7654321 investment manager holdings new position in Safe Utility Inc Ticker: SAFE accession number 0007654321-26-000002</summary>
  </entry>
</feed>`;

const SEC_13F_XML = `<?xml version="1.0" encoding="UTF-8"?>
<informationTable>
  <infoTable>
    <nameOfIssuer>Safe Utility Inc</nameOfIssuer>
    <cusip>987654AA9</cusip>
    <value>125000</value>
    <shrsOrPrnAmt>
      <sshPrnamt>4100</sshPrnamt>
    </shrsOrPrnAmt>
    <investmentDiscretion>SOLE</investmentDiscretion>
  </infoTable>
</informationTable>`;

describe('secInstitutionalOwnershipService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses SEC 13D/13F Atom entries into ownership signals', () => {
    const rows = secOwnership.parseOwnershipAtomFeed(SEC_ATOM, {
      id: 'sec-current-sc-13d-atom',
      url: secOwnership.SEC_13D_ATOM_URL,
      formType: 'SC 13D',
      ownershipType: 'activist-beneficial-ownership',
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      formType: 'SC 13D',
      ownershipType: 'activist-beneficial-ownership',
      filerName: 'Acme Activist Fund LP',
      issuerName: 'Acme Robotics Inc',
      symbol: 'ACME',
      percentOwned: 9.8,
      signalType: 'activist-or-control-stake',
    });
    expect(rows[0].influenceScore).toBeGreaterThan(65);
    expect(rows[1]).toMatchObject({
      formType: '13F-HR',
      signalType: 'delayed-institutional-manager-holdings',
      symbol: 'SAFE',
    });
  });

  it('evaluates ownership context and scores matching candidates', () => {
    const entries = secOwnership.parseOwnershipAtomFeed(SEC_ATOM, {
      id: 'sec-current-sc-13d-atom',
      url: secOwnership.SEC_13D_ATOM_URL,
      formType: 'SC 13D',
    });
    const context = secOwnership.evaluateOwnershipContext({ entries });

    expect(context.available).toBe(true);
    expect(context.entryCount).toBe(2);
    expect(context.activistSignalCount).toBe(1);
    expect(context.institutionalSignalCount).toBe(1);
    expect(context.topBeneficialOwners[0].symbol).toBe('ACME');

    const score = secOwnership.scoreCandidate({
      candidate: { symbol: 'ACME', companyName: 'Acme Robotics Inc', theme: 'small cap activist ownership' },
      ownershipContext: context,
    });
    expect(score.compositeScore).toBeGreaterThan(50);
    expect(score.signals[0].formType).toBe('SC 13D');
    expect(score.explanation).toMatch(/13F\/13D\/13G/);
  });

  it('collects SEC ownership feeds and compacts BMCL snapshots', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => SEC_ATOM,
    });
    const events = [];
    const context = await secOwnership.collectInstitutionalOwnershipContext({
      userAgent: 'AutoTrader test test@example.com',
      feedTypes: ['SC 13D'],
      limit: 1,
      onEvent: (event) => events.push(event),
    });

    expect(context.available).toBe(true);
    expect(context.entries).toHaveLength(1);
    expect(events.map((event) => event.phase)).toContain('sec-ownership');

    const compact = secOwnership.compactForBmcl(context);
    expect(compact.provider).toBe('sec-edgar-ownership');
    expect(compact.topActivistSignals).toHaveLength(1);
    expect(compact.bmclUse).toMatch(/13F\/13D\/13G/);
  });

  it('parses 13F information table details when available', () => {
    const detail = secOwnership.parseOwnershipDocument(SEC_13F_XML, {
      formType: '13F-HR',
      url: 'https://www.sec.gov/Archives/edgar/data/7654321/000765432126000002/infotable.xml',
    });

    expect(detail.holdings[0]).toMatchObject({
      issuerName: 'Safe Utility Inc',
      cusip: '987654AA9',
      value: 125000,
      shares: 4100,
      investmentDiscretion: 'SOLE',
    });
  });
});
