const BrokerClient = require('./BrokerClient');
const { config } = require('../../config');
const providerCredentialRepo = require('../../db/repositories/providerCredentialRepo');

/**
 * Robinhood has no official public trading API. This client is a shell for
 * an unofficial/reverse-engineered integration (session login + device
 * verification, similar to what libraries like robin_stocks implement for
 * Python). It intentionally does NOT attempt a live login until real
 * credentials are supplied — wiring this up to a real account is a decision
 * the user makes explicitly, not something to do silently.
 */
class RobinhoodBrokerClient extends BrokerClient {
  constructor({ userId } = {}) {
    super();
    this.session = null;
    this.userId = userId;
    this.credentials = null;
  }

  isConfigured() {
    const credentials = this.getCredentials();
    return Boolean(credentials.username && credentials.password);
  }

  getCredentials() {
    if (this.credentials) return this.credentials;
    const saved = this.userId ? providerCredentialRepo.getSecret(this.userId, 'robinhood') : null;
    this.credentials = {
      username: saved?.username || config.robinhood.username,
      password: saved?.password || config.robinhood.password,
      mfaSecret: saved?.mfaSecret || config.robinhood.mfaSecret,
    };
    return this.credentials;
  }

  async connect() {
    if (!this.isConfigured()) {
      throw new Error(
        'Robinhood credentials are not configured (ROBINHOOD_USERNAME/ROBINHOOD_PASSWORD). ' +
          'This is expected until a real account is deliberately wired up.'
      );
    }
    // NOT IMPLEMENTED: real login flow (username/password + MFA + device
    // token) against Robinhood's unofficial endpoints. Left unimplemented
    // until the user is ready to connect a real account, at which point this
    // should be built and tested against that specific account.
    throw new Error('Robinhood live login is not yet implemented.');
  }

  async getAccountState() {
    throw new Error('Robinhood live integration not implemented.');
  }

  async placeMarketOrder(_order) {
    throw new Error('Robinhood live integration not implemented.');
  }
}

module.exports = RobinhoodBrokerClient;
