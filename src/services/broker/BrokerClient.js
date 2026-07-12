/**
 * Interface every broker implementation must satisfy. Keeping this thin and
 * explicit means the rules engine and order execution layer never depend on
 * Robinhood-specific behavior directly.
 */
class BrokerClient {
  async connect() {
    throw new Error('connect() not implemented');
  }

  /** @returns {Promise<{cashUsd: number, buyingPowerUsd: number}>} */
  async getAccountState() {
    throw new Error('getAccountState() not implemented');
  }

  /** @returns {Promise<{brokerOrderId: string, status: string, fillPrice: number|null}>} */
  async placeMarketOrder({ symbol, side, quantity }) {
    throw new Error('placeMarketOrder() not implemented');
  }
}

module.exports = BrokerClient;
