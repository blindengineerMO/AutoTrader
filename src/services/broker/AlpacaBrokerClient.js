const Alpaca = require('@alpacahq/alpaca-trade-api');
const BrokerClient = require('./BrokerClient');
const { config } = require('../../config');
const providerCredentialRepo = require('../../db/repositories/providerCredentialRepo');

class AlpacaBrokerClient extends BrokerClient {
  constructor({ userId, clientFactory = null } = {}) {
    super();
    this.userId = userId;
    this.clientFactory = clientFactory || ((options) => new Alpaca(options));
    this.client = null;
    this.live = false;
    this.lastAccount = null;
  }

  getCredentials() {
    const saved = this.userId ? providerCredentialRepo.getSecret(this.userId, 'alpaca') : null;
    const paper = parseBoolean(saved?.paper, config.alpaca.paper);
    const baseUrl = saved?.baseUrl || config.alpaca.baseUrl || defaultBaseUrl(paper);
    return {
      keyId: saved?.keyId || config.alpaca.keyId,
      secretKey: saved?.secretKey || config.alpaca.secretKey,
      paper,
      baseUrl,
    };
  }

  isConfigured() {
    const credentials = this.getCredentials();
    return Boolean(credentials.keyId && credentials.secretKey);
  }

  async connect() {
    const credentials = this.getCredentials();
    if (!credentials.keyId || !credentials.secretKey) {
      throw new Error('Alpaca API key ID and secret key are required.');
    }
    this.client = this.clientFactory({
      keyId: credentials.keyId,
      secretKey: credentials.secretKey,
      paper: credentials.paper,
      baseUrl: credentials.baseUrl,
    });
    this.lastAccount = await this.client.getAccount();
    this.live = true;
    return true;
  }

  async getAccountState() {
    if (!this.client) await this.connect();
    this.lastAccount = await this.client.getAccount();
    return {
      cashUsd: money(this.lastAccount.cash),
      buyingPowerUsd: money(this.lastAccount.buying_power),
      status: this.lastAccount.status || null,
      currency: this.lastAccount.currency || 'USD',
      raw: this.lastAccount,
    };
  }

  async placeMarketOrder({ symbol, side, quantity, clientOrderId = null }) {
    if (!this.client) await this.connect();
    const normalizedSymbol = normalizeSymbol(symbol);
    const normalizedSide = normalizeSide(side);
    const qty = Number(quantity || 0);
    if (!normalizedSymbol) throw new Error('Symbol is required.');
    if (!normalizedSide) throw new Error('Order side must be buy or sell.');
    if (!Number.isFinite(qty) || qty <= 0) throw new Error('Quantity must be positive.');

    const order = await this.client.createOrder({
      symbol: normalizedSymbol,
      qty: String(qty),
      side: normalizedSide,
      type: 'market',
      time_in_force: 'day',
      client_order_id: clientOrderId || undefined,
    });
    const finalOrder = await this.waitForTerminalOrder(order);
    return {
      brokerOrderId: finalOrder.id || finalOrder.client_order_id || clientOrderId,
      status: normalizeStatus(finalOrder.status),
      fillPrice: money(finalOrder.filled_avg_price),
      raw: finalOrder,
    };
  }

  async waitForTerminalOrder(order) {
    if (!order?.id || isTerminalStatus(order.status) || typeof this.client.getOrder !== 'function') return order;
    let latest = order;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await delay(500);
      latest = await this.client.getOrder(order.id);
      if (isTerminalStatus(latest.status)) return latest;
    }
    return latest;
  }
}

function defaultBaseUrl(paper) {
  return paper ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets';
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return Boolean(fallback);
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'paper'].includes(String(value).trim().toLowerCase());
}

function money(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase().replace(/[^A-Z0-9.-]/g, '');
}

function normalizeSide(side) {
  const normalized = String(side || '').trim().toLowerCase();
  if (normalized === 'buy' || normalized === 'sell') return normalized;
  return null;
}

function normalizeStatus(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (
    [
      'filled',
      'partially_filled',
      'accepted',
      'new',
      'pending_new',
      'accepted_for_bidding',
      'pending_cancel',
      'pending_replace',
    ].includes(normalized)
  ) {
    return normalized;
  }
  if (['rejected', 'canceled', 'expired', 'done_for_day', 'replaced', 'stopped', 'suspended', 'calculated'].includes(normalized)) {
    return normalized;
  }
  return normalized || 'submitted';
}

function isTerminalStatus(status) {
  return [
    'filled',
    'partially_filled',
    'rejected',
    'canceled',
    'expired',
    'done_for_day',
    'replaced',
    'stopped',
    'suspended',
    'calculated',
  ].includes(String(status || '').trim().toLowerCase());
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = AlpacaBrokerClient;
