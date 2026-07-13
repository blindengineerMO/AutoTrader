const gdeltDoc = require('../src/services/gdeltDocService');

describe('gdeltDocService', () => {
  it('builds DOC 2.0 article-list URLs for search packs', () => {
    const url = gdeltDoc.buildDocUrl({
      query: '(startup OR company) ("raised funding" OR "funding round" OR "series A")',
      timespan: '7d',
      maxrecords: 250,
    });

    expect(url).toContain('https://api.gdeltproject.org/api/v2/doc/doc?');
    expect(url).toContain('mode=artlist');
    expect(url).toContain('format=json');
    expect(url).toContain('sort=datedesc');
    expect(url).toContain('timespan=7d');
    expect(url).toContain('maxrecords=250');
    expect(decodeURIComponent(url)).toContain('(startup OR company) ("raised funding" OR "funding round" OR "series A")');
  });

  it('normalizes GDELT articles into autonomous news items', () => {
    const articles = gdeltDoc.normalizeArticles({
      articles: [
        {
          url: 'https://example.com/startup',
          title: 'Acme Robotics raised funding for warehouse automation',
          seendate: '20260713090000',
          domain: 'example.com',
          language: 'English',
          sourcecountry: 'US',
          tone: '1.25',
        },
        { title: '', url: 'https://example.com/skip' },
      ],
    }, gdeltDoc.SEARCH_PACKS.find((pack) => pack.id === 'funding'));

    expect(articles).toHaveLength(1);
    expect(articles[0]).toMatchObject({
      sourceType: 'gdelt-doc',
      source: 'GDELT funding rounds',
      title: 'Acme Robotics raised funding for warehouse automation',
      link: 'https://example.com/startup',
      region: 'US',
      domain: 'example.com',
      gdeltPack: 'funding',
    });
    expect(articles[0].tone).toBe(1.25);
  });

  it('extracts entity leads from funding, IPO, acquisition, and ticker headlines', () => {
    const fundingPack = gdeltDoc.SEARCH_PACKS.find((pack) => pack.id === 'funding');
    const articles = [
      {
        title: 'Acme Robotics raised funding for warehouse automation',
        description: 'Series A round brings new growth.',
        url: 'https://example.com/acme',
      },
      {
        title: 'Beta Systems (BETA) filed to go public',
        description: 'IPO filing mentions initial public offering.',
        url: 'https://example.com/beta',
      },
    ];

    const leads = gdeltDoc.extractEntityLeads(articles, fundingPack);

    expect(leads.map((lead) => lead.name)).toEqual(expect.arrayContaining(['Acme Robotics', 'BETA']));
    expect(leads.find((lead) => lead.symbol === 'BETA')?.type).toBe('gdelt-direct-ticker');
    expect(leads.find((lead) => lead.name === 'Acme Robotics')?.evidence[0].url).toBe('https://example.com/acme');
  });

  it('dedupes articles by URL', () => {
    const deduped = gdeltDoc.dedupeArticles([
      { title: 'One', url: 'https://example.com/one' },
      { title: 'Duplicate', url: 'https://example.com/one' },
      { title: 'Two', url: 'https://example.com/two' },
    ]);

    expect(deduped).toHaveLength(2);
    expect(deduped.map((item) => item.url)).toEqual(['https://example.com/one', 'https://example.com/two']);
  });
});
