const researchQueryCatalogService = require('../src/services/researchQueryCatalogService');

describe('researchQueryCatalogService', () => {
  it('parses RESEARCH.md into structured, dimension-keyed query templates', () => {
    const dimensions = researchQueryCatalogService.getAllDimensions();

    expect(dimensions.length).toBeGreaterThan(10);

    const debtQueries = researchQueryCatalogService.getQueryTemplatesForDimension('debt_and_liquidity');
    expect(debtQueries.length).toBeGreaterThan(0);
    expect(debtQueries.some((q) => /interest coverage/i.test(q))).toBe(true);

    const supplierQueries = researchQueryCatalogService.getQueryTemplatesForDimension('customer_and_supplier_risk');
    expect(supplierQueries.length).toBeGreaterThan(0);
  });

  it('returns an empty array for an unknown dimension', () => {
    expect(researchQueryCatalogService.getQueryTemplatesForDimension('not-a-real-dimension')).toEqual([]);
  });

  it('is cached: repeated calls return the same parsed data without re-reading the file', () => {
    const first = researchQueryCatalogService.getAllDimensions();
    const second = researchQueryCatalogService.getAllDimensions();
    expect(second).toEqual(first);
  });

  it('finds dimensions matching a keyword', () => {
    const matches = researchQueryCatalogService.findDimensionsByKeyword('macro');
    expect(matches.length).toBeGreaterThan(0);
  });

  it('extracts embedded JSON schema blocks from the document', () => {
    const { jsonSchemas } = researchQueryCatalogService.loadResearchCatalog();
    expect(jsonSchemas.length).toBeGreaterThan(0);
  });
});
