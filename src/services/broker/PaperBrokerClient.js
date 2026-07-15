const crypto = require('crypto');
const BrokerClient = require('./BrokerClient');
const brokerAccountRepo = require('../../db/repositories/brokerAccountRepo');
const positionRepo = require('../../db/repositories/positionRepo');
const operationsRepo = require('../../db/repositories/specOperationsRepo');
const alpacaRules = require('../alpacaRulesService');

class PaperBrokerClient extends BrokerClient {
  /**
   * `failureInjection` lets paper/backtest tests exercise broker failure
   * paths (rejects, latency, outage windows) without touching live
   * brokerage code — this class is paper-only already, and injection is
   * additionally disabled outright in production as defense in depth.
   */
  constructor({ userId, startingCashUsd = 10000, failureInjection = null } = {}) {
    super();
    this.userId = userId;
    this.startingCashUsd = startingCashUsd;
    this.account = null;
    this.failureInjection = process.env.NODE_ENV === 'production' ? null : failureInjection;
  }

  isInOutageWindow(now = new Date()) {
    const windows = this.failureInjection?.outageWindows || [];
    const ts = now.getTime();
    return windows.some((window) => ts >= new Date(window.start).getTime() && ts <= new Date(window.end).getTime());
  }

  async applyInjectedLatency() {
    const latencyMs = this.failureInjection?.latencyMs || 0;
    if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
  }

  shouldInjectReject(rng = Math.random) {
    const rate = this.failureInjection?.rejectRate || 0;
    return rate > 0 && rng() < rate;
  }

  async connect() {
    if (this.isInOutageWindow()) throw new Error('Simulated broker outage window: connect() unavailable.');
    await this.applyInjectedLatency();
    this.account = brokerAccountRepo.ensureDefault(this.userId, 'paper');
    if (!Number(this.account.cash_balance_usd)) {
      brokerAccountRepo.updateBalance(this.account.id, this.startingCashUsd, this.startingCashUsd, 'paper');
      this.account = brokerAccountRepo.getDefault(this.userId, 'paper');
    }
    return true;
  }

  async getAccountState() {
    if (!this.account) await this.connect();
    this.account = brokerAccountRepo.getDefault(this.userId, 'paper');
    return {
      cashUsd: Number(this.account.cash_balance_usd || 0),
      buyingPowerUsd: Number(this.account.buying_power_usd || this.account.cash_balance_usd || 0),
    };
  }

  async placeMarketOrder({ runId = null, clientOrderId, symbol, side, quantity, price }) {
    if (this.isInOutageWindow()) throw new Error('Simulated broker outage window: placeMarketOrder() unavailable.');
    await this.applyInjectedLatency();
    if (!this.account) await this.connect();
    if (!clientOrderId) throw new Error('clientOrderId is required for paper broker idempotency');
    const existing = operationsRepo.getPaperBrokerOrder(this.userId, clientOrderId);
    if (existing) {
      return {
        brokerOrderId: existing.broker_order_id,
        status: existing.status,
        fillPrice: existing.fill_price,
        idempotent: true,
      };
    }

    const accountState = await this.getAccountState();
    const fillPrice = Number(price || 100);
    const requestedQty = Number(quantity || 0);
    const notional = fillPrice * requestedQty;
    const brokerOrderId = `paper_${crypto.randomUUID()}`;
    let status = 'filled';
    let reason = null;

    if (!requestedQty || requestedQty <= 0) {
      status = 'rejected';
      reason = 'Quantity must be positive.';
    } else {
      const evaluation = alpacaRules.evaluateOrder({
        userId: this.userId,
        symbol,
        side,
        quantity: requestedQty,
        price: fillPrice,
        asset: { fractionable: true, tradable: true },
      });
      if (!evaluation.allowed) {
        status = 'rejected';
        reason = `Alpaca order rules blocked trade: ${evaluation.failed.join(', ')}`;
      }
    }

    if (status === 'filled' && side === 'buy' && notional > accountState.buyingPowerUsd) {
      status = 'rejected';
      reason = 'Insufficient paper buying power.';
    } else if (status === 'filled' && this.shouldInjectReject()) {
      status = 'rejected';
      reason = 'Simulated failure injection: forced reject.';
    }

    if (status === 'filled') {
      const cash = side === 'buy' ? accountState.cashUsd - notional : accountState.cashUsd + notional;
      brokerAccountRepo.updateBalance(this.account.id, cash, cash, 'paper');
      positionRepo.applyFill({
        userId: this.userId,
        brokerAccountId: this.account.id,
        symbol: normalizeSymbol(symbol),
        side,
        quantity: requestedQty,
        fillPrice,
      });
      this.account = brokerAccountRepo.getDefault(this.userId, 'paper');
    }

    const saved = operationsRepo.savePaperBrokerOrder({
      userId: this.userId,
      runId,
      clientOrderId,
      brokerOrderId,
      symbol,
      side,
      quantity: requestedQty,
      requestedPrice: price,
      fillPrice: status === 'filled' ? fillPrice : null,
      status,
      reason,
      payload: { paper: true, idempotencyKey: clientOrderId },
    });

    return {
      brokerOrderId: saved.broker_order_id,
      status: saved.status,
      fillPrice: saved.fill_price,
      reason: saved.reason,
      idempotent: false,
    };
  }
}

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase().replace(/[^A-Z.]/g, '');
}

module.exports = PaperBrokerClient;
