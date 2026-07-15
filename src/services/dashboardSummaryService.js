const brokerAccountRepo = require('../db/repositories/brokerAccountRepo');
const positionRepo = require('../db/repositories/positionRepo');
const pnlRepo = require('../db/repositories/pnlRepo');
const orderRepo = require('../db/repositories/orderRepo');
const settingsRepo = require('../db/repositories/settingsRepo');
const decisionReportRepo = require('../db/repositories/decisionReportRepo');
const providerCredentialRepo = require('../db/repositories/providerCredentialRepo');
const webScrapeClient = require('./marketData/webScrapeClient');
const simulationAccountReconciliation = require('./simulationAccountReconciliationService');
const brainMesh = require('./brainMeshService');
const simulationCashFunding = require('./simulationCashFundingService');
const { startOfTodayUtc } = require('../utils/time');
const { config } = require('../config');

async function buildDashboardSummary(userId, { quoteProvider = webScrapeClient } = {}) {
  const settings = settingsRepo.get(userId);
  const brokerAccount = settings?.simulation_mode_enabled
    ? simulationAccountReconciliation.reconcileSimulationAccount(userId, settings)
    : brokerAccountRepo.getDefault(userId);
  const positions = positionRepo.listByUser(userId);
  const quotesBySymbol = await loadQuotes(positions, quoteProvider);
  const enrichedPositions = positions.map((position) => enrichPosition(position, quotesBySymbol.get(position.symbol)));
  const positionsMarketValueUsd = roundMoney(enrichedPositions.reduce((sum, position) => sum + position.market_value_usd, 0));
  const positionsCostBasisUsd = roundMoney(enrichedPositions.reduce((sum, position) => sum + position.cost_basis_usd, 0));
  const unrealizedPnlUsd = roundMoney(enrichedPositions.reduce((sum, position) => sum + position.unrealized_pnl_usd, 0));
  const realizedTodayPnl = roundMoney(pnlRepo.sumSince(userId, startOfTodayUtc()));
  const cashBalanceUsd = roundMoney(brokerAccount?.cash_balance_usd || 0);
  const portfolioValueUsd = roundMoney(cashBalanceUsd + positionsMarketValueUsd);
  const todaysPnl = roundMoney(realizedTodayPnl + unrealizedPnlUsd);
  const recentOrders = orderRepo.listByUser(userId, 10);
  const latestReports = decisionReportRepo.listByUser(userId, 3);
  const bmclConversations = brainMesh.listCompletedConversationSummaries(userId, 50);
  const alpacaAccount = buildAlpacaDashboardSummary(userId, brokerAccount);
  const simulationFunding = simulationCashFunding.getDashboardFunding(userId);

  return {
    brokerAccount,
    positions: enrichedPositions,
    todaysPnl,
    realizedTodayPnl,
    unrealizedPnlUsd,
    portfolioValueUsd,
    positionsMarketValueUsd,
    positionsCostBasisUsd,
    recentOrders,
    latestReports,
    bmclConversations,
    alpacaAccount,
    simulationFunding,
    settings,
    operatingMode: settings?.simulation_mode_enabled ? 'simulation' : settings?.trading_enabled ? 'live-ready' : 'simulation-reporting',
  };
}

async function loadQuotes(positions, quoteProvider) {
  if (!positions.length || !quoteProvider?.getQuotes) return new Map();
  try {
    const quotes = await quoteProvider.getQuotes(positions.map((position) => position.symbol));
    return new Map((quotes || []).map((quote) => [quote.symbol, quote]));
  } catch {
    return new Map();
  }
}

function enrichPosition(position, quote) {
  const quantity = Number(position.quantity || 0);
  const avgCost = Number(position.avg_cost_usd || 0);
  const marketPrice = Number(quote?.current || avgCost || 0);
  const marketValue = roundMoney(quantity * marketPrice);
  const costBasis = roundMoney(quantity * avgCost);
  return {
    ...position,
    market_price_usd: roundMoney(marketPrice),
    market_value_usd: marketValue,
    cost_basis_usd: costBasis,
    unrealized_pnl_usd: roundMoney(marketValue - costBasis),
    quote_source: quote?.source || (quote ? 'quote' : 'avg_cost_fallback'),
  };
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function buildAlpacaDashboardSummary(userId, brokerAccount) {
  const saved = providerCredentialRepo.getSecret(userId, 'alpaca') || {};
  const paper = parseBoolean(saved.paper, config.alpaca.paper);
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const quarterStart = new Date(Date.UTC(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) * 3, 1));
  const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  return {
    mode: paper ? 'paper' : 'live',
    configured: Boolean((saved.keyId || config.alpaca.keyId) && (saved.secretKey || config.alpaca.secretKey)),
    accountId: saved.brokerAccountId || saved.accountId || config.alpaca.brokerAccountId || null,
    cashBalanceUsd: roundMoney(brokerAccount?.cash_balance_usd || brokerAccount?.cashUsd || 0),
    buyingPowerUsd: roundMoney(brokerAccount?.buying_power_usd || brokerAccount?.buyingPowerUsd || 0),
    tradeCounts: {
      month: orderRepo.countSince(userId, sqliteUtc(monthStart)),
      quarter: orderRepo.countSince(userId, sqliteUtc(quarterStart)),
      year: orderRepo.countSince(userId, sqliteUtc(yearStart)),
    },
  };
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return Boolean(fallback);
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'paper'].includes(String(value).trim().toLowerCase());
}

function sqliteUtc(date) {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

module.exports = {
  buildDashboardSummary,
};
