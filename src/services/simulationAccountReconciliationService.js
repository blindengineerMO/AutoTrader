const brokerAccountRepo = require('../db/repositories/brokerAccountRepo');
const orderRepo = require('../db/repositories/orderRepo');
const settingsRepo = require('../db/repositories/settingsRepo');

function reconcileSimulationAccount(userId, settings = settingsRepo.get(userId)) {
  const account = brokerAccountRepo.ensureDefault(userId);
  if (!settings?.simulation_mode_enabled) return account;

  const startingCash = roundMoney(settings.simulation_starting_cash_usd || 0);
  const expectedCash = orderRepo.listFilledSimulationByUser(userId).reduce((cash, order) => {
    const notional = roundMoney(Number(order.quantity || 0) * Number(order.fill_price || 0));
    return order.side === 'sell' ? cash + notional : cash - notional;
  }, startingCash);
  const roundedCash = roundMoney(expectedCash);

  if (Math.abs(roundedCash - Number(account.cash_balance_usd || 0)) > 0.004 || account.status !== 'simulation') {
    brokerAccountRepo.updateBalance(account.id, roundedCash, roundedCash, 'simulation');
    return brokerAccountRepo.getDefault(userId);
  }

  return account;
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

module.exports = {
  reconcileSimulationAccount,
};
