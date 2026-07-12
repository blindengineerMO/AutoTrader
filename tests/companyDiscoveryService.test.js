const companyDiscovery = require('../src/services/companyDiscoveryService');

describe('companyDiscoveryService', () => {
  it('learns quoteable companies from crawled product and company mentions', () => {
    const discovered = companyDiscovery.discoverCompanies({
      news: {
        items: [
          {
            title: 'NVIDIA Blackwell demand rises as new AI products launch',
            description: 'Microsoft Azure and Palantir AIP customers are expanding AI infrastructure spending.',
            link: 'https://example.com/markets/ai-products',
          },
        ],
      },
      learned: {
        observations: [
          {
            title: 'Defense contracts and missile-defense orders climb',
            url: 'https://example.com/companies/defense',
            excerpt: 'War risk is increasing military spending for Lockheed Martin, RTX, missile defense vendors, and new supplier $RKLB.',
            links: [],
          },
        ],
      },
    });

    expect(discovered.map((item) => item.symbol)).toEqual(expect.arrayContaining(['NVDA', 'MSFT', 'PLTR', 'LMT', 'RTX', 'RKLB']));
    expect(discovered.find((item) => item.symbol === 'NVDA').discovery.evidence[0].reason).toMatch(/Crawled/);
    expect(discovered.find((item) => item.symbol === 'RKLB').discovery.evidence[0].reason).toMatch(/new direct ticker/);
  });
});
