const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-alpaca-documents.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const providerConfigService = require('../src/services/providerConfigService');
const alpacaDocumentService = require('../src/services/alpacaDocumentService');

describe('alpacaDocumentService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('syncs Alpaca account documents and stores redirected download URLs', async () => {
    const user = userRepo.createUser({
      email: `alpaca-docs-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });
    providerConfigService.saveProvider(user.id, 'alpaca', {
      keyId: 'broker-key',
      secretKey: 'broker-secret',
      paper: 'true',
      brokerBaseUrl: 'https://broker-api.sandbox.alpaca.markets',
      brokerAccountId: 'acct-123',
    });

    global.fetch = async (url, options = {}) => {
      const urlString = String(url);
      if (urlString === 'https://download.alpaca.markets/doc-1.pdf') {
        return {
          ok: true,
          status: 200,
          headers: new Map([['content-type', 'application/pdf']]),
          arrayBuffer: async () => Uint8Array.from(Buffer.from('statement-pdf')).buffer,
        };
      }
      expect(options.headers.Authorization).toBe(`Basic ${Buffer.from('broker-key:broker-secret').toString('base64')}`);
      if (urlString.includes('/documents?')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              id: 'doc-1',
              type: 'account_statement',
              date: '2026-06-30',
              name: 'June statement',
            },
          ],
        };
      }
      if (urlString.endsWith('/documents/doc-1/download')) {
        return {
          ok: false,
          status: 301,
          headers: new Map([['location', 'https://download.alpaca.markets/doc-1.pdf']]),
        };
      }
      return { ok: true, status: 200, json: async () => [] };
    };

    const result = await alpacaDocumentService.syncMonthlyDocuments(user.id, {
      types: ['account_statement'],
      now: new Date('2026-07-14T12:00:00Z'),
    });
    const page = alpacaDocumentService.queryDocuments(user.id, { pageSize: 5 });

    expect(result.skipped).toBe(false);
    expect(result.items).toHaveLength(1);
    expect(page.total).toBe(1);
    expect(page.items[0].document_id).toBe('doc-1');
    expect(page.items[0].download_url).toBe('https://download.alpaca.markets/doc-1.pdf');
    expect(page.items[0].local_path).toContain('doc-1.pdf');
    expect(page.items[0].content_type).toBe('application/pdf');
    expect(page.items[0].file_size_bytes).toBeGreaterThan(0);
    expect(page.items[0].status).toBe('downloaded');
  });

  it('reports a skipped sync when Broker API credentials are incomplete', async () => {
    const user = userRepo.createUser({
      email: `alpaca-docs-skipped-${Date.now()}@example.com`,
      passwordHash: 'x',
      dailyLossLimitUsd: 10,
      maxTradesPerSymbolPer24h: 3,
    });

    const result = await alpacaDocumentService.syncMonthlyDocuments(user.id);

    expect(result.skipped).toBe(true);
    expect(result.reason).toContain('broker account ID');
  });
});
