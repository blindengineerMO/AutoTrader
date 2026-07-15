const BrokerClient = require('./BrokerClient');

/**
 * In-memory broker used for dry runs, tests, and default operation until a
 * real broker is wired up. Fills orders instantly at a caller-supplied price.
 */
class MockBrokerClient extends BrokerClient {
  constructor({ startingCashUsd = 100 } = {}) {
    super();
    this.cashUsd = startingCashUsd;
    this.orderCounter = 0;
  }

  async connect() {
    return true;
  }

  async getAccountState() {
    // equityUsd omitted: this mock doesn't track position value, so callers
    // fall back to cash + positionRepo cost basis for an equity estimate.
    return { cashUsd: this.cashUsd, buyingPowerUsd: this.cashUsd, equityUsd: null };
  }

  async placeMarketOrder({ symbol, side, quantity, price }) {
    this.orderCounter += 1;
    const fillPrice = price ?? 100;
    const cost = fillPrice * quantity;
    if (side === 'buy') {
      if (cost > this.cashUsd) {
        return { brokerOrderId: `mock-${this.orderCounter}`, status: 'rejected', fillPrice: null };
      }
      this.cashUsd -= cost;
    } else {
      this.cashUsd += cost;
    }
    return { brokerOrderId: `mock-${this.orderCounter}`, status: 'filled', fillPrice };
  }
}

module.exports = MockBrokerClient;
