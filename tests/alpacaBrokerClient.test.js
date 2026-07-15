const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'tmp-alpaca-broker.db');
process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-secret';
process.env.ALPACA_KEY_ID = '';
process.env.ALPACA_SECRET_KEY = '';

for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_PATH + suffix)) fs.unlinkSync(TEST_DB_PATH + suffix);
}

const migrate = require('../src/db/migrate');
migrate();

const userRepo = require('../src/db/repositories/userRepo');
const brokerAccountRepo = require('../src/db/repositories/brokerAccountRepo');
const settingsRepo = require('../src/db/repositories/settingsRepo');
const providerConfigService = require('../src/services/providerConfigService');
const AlpacaBrokerClient = require('../src/services/broker/AlpacaBrokerClient');

function createUser() {
  return userRepo.createUser({
    email: `alpaca-${Date.now()}-${Math.random()}@example.com`,
    passwordHash: 'x',
    dailyLossLimitUsd: 10,
    maxTradesPerSymbolPer24h: 3,
  });
}

describe('AlpacaBrokerClient', () => {
  it('uses saved Alpaca credentials and normalizes account state', async () => {
    const user = createUser();
    const clientOptions = [];
    providerConfigService.saveProvider(user.id, 'alpaca', {
      keyId: 'ak-test',
      secretKey: 'secret-test',
      paper: 'true',
      baseUrl: 'https://paper-api.alpaca.markets',
    });

    const broker = new AlpacaBrokerClient({
      userId: user.id,
      clientFactory: (options) => {
        clientOptions.push(options);
        return {
          getAccount: async () => ({
            cash: '123.45',
            buying_power: '234.56',
            status: 'ACTIVE',
            currency: 'USD',
          }),
        };
      },
    });

    expect(broker.isConfigured()).toBe(true);
    await broker.connect();
    const accountState = await broker.getAccountState();

    expect(clientOptions[0]).toEqual({
      keyId: 'ak-test',
      secretKey: 'secret-test',
      paper: true,
      baseUrl: 'https://paper-api.alpaca.markets',
    });
    expect(accountState.cashUsd).toBe(123.45);
    expect(accountState.buyingPowerUsd).toBe(234.56);
    expect(accountState.status).toBe('ACTIVE');
  });

  it('places market orders using Alpaca order fields', async () => {
    const user = createUser();
    const submittedOrders = [];
    providerConfigService.saveProvider(user.id, 'alpaca', {
      keyId: 'ak-order',
      secretKey: 'secret-order',
      paper: 'false',
      baseUrl: 'https://api.alpaca.markets',
    });

    const broker = new AlpacaBrokerClient({
      userId: user.id,
      clientFactory: () => ({
        getAccount: async () => ({ cash: '1000', buying_power: '1000', status: 'ACTIVE' }),
        createOrder: async (order) => {
          submittedOrders.push(order);
          return {
            id: 'alpaca-order-1',
            status: 'filled',
            filled_avg_price: '14.25',
          };
        },
      }),
    });

    const result = await broker.placeMarketOrder({
      symbol: ' aapl ',
      side: 'BUY',
      quantity: 2,
      clientOrderId: 'client-1',
    });

    expect(submittedOrders[0]).toEqual({
      symbol: 'AAPL',
      qty: '2',
      side: 'buy',
      type: 'market',
      time_in_force: 'day',
      client_order_id: 'client-1',
    });
    expect(result).toMatchObject({
      brokerOrderId: 'alpaca-order-1',
      status: 'filled',
      fillPrice: 14.25,
    });
  });

  it('submits Alpaca fractional quantities only after fractionable asset confirmation', async () => {
    const user = createUser();
    settingsRepo.update(user.id, {
      fractionalTradingEnabled: 1,
      fractionalMinNotionalUsd: 1,
      maxBuyOrderNotionalUsd: 20,
    });
    const submittedOrders = [];
    const assetLookups = [];
    providerConfigService.saveProvider(user.id, 'alpaca', {
      keyId: 'ak-fractional',
      secretKey: 'secret-fractional',
      paper: 'true',
    });

    const broker = new AlpacaBrokerClient({
      userId: user.id,
      clientFactory: () => ({
        getAccount: async () => ({ cash: '1000', buying_power: '1000', status: 'ACTIVE' }),
        getAsset: async (symbol) => {
          assetLookups.push(symbol);
          return { symbol, tradable: true, fractionable: true };
        },
        createOrder: async (order) => {
          submittedOrders.push(order);
          return {
            id: 'alpaca-fractional-order-1',
            status: 'filled',
            filled_avg_price: '20',
          };
        },
      }),
    });

    const result = await broker.placeMarketOrder({
      symbol: 'aapl',
      side: 'buy',
      quantity: 0.25,
      price: 20,
      clientOrderId: 'fractional-1',
    });

    expect(assetLookups).toEqual(['AAPL']);
    expect(submittedOrders[0]).toMatchObject({
      symbol: 'AAPL',
      qty: '0.25',
      side: 'buy',
      type: 'market',
      time_in_force: 'day',
    });
    expect(result.status).toBe('filled');
  });

  it('rejects fractional orders when Alpaca reports the asset is not fractionable', async () => {
    const user = createUser();
    providerConfigService.saveProvider(user.id, 'alpaca', {
      keyId: 'ak-not-fractionable',
      secretKey: 'secret-not-fractionable',
      paper: 'true',
    });

    const broker = new AlpacaBrokerClient({
      userId: user.id,
      clientFactory: () => ({
        getAccount: async () => ({ cash: '1000', buying_power: '1000', status: 'ACTIVE' }),
        getAsset: async () => ({ symbol: 'XYZ', tradable: true, fractionable: false }),
        createOrder: async () => {
          throw new Error('createOrder should not be called for non-fractionable assets');
        },
      }),
    });

    await expect(broker.placeMarketOrder({
      symbol: 'XYZ',
      side: 'buy',
      quantity: 0.25,
      price: 20,
    })).rejects.toThrow(/not fractionable/);
  });

  it('creates new default broker accounts as alpaca accounts', () => {
    const user = createUser();
    const account = brokerAccountRepo.ensureDefault(user.id);
    expect(account.broker).toBe('alpaca');
  });
});
