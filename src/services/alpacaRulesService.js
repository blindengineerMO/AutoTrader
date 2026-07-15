const DOC_URL = 'https://docs.alpaca.markets/us/docs/fractional-trading';
const VERSION = 'alpaca-rules-v1';

function getRulesSummary({ userId } = {}) {
  const settings = userId ? getSettingsRepo().get(userId) : null;
  return {
    provider: 'alpaca',
    version: VERSION,
    docUrl: DOC_URL,
    fractionalTradingEnabled: settings ? settings.fractional_trading_enabled !== 0 : true,
    fractionalMinNotionalUsd: Number(settings?.fractional_min_notional_usd || 1),
    maxBuyOrderNotionalUsd: Number(settings?.max_buy_order_notional_usd || 100),
    rules: [
      'Alpaca accounts are allowed to trade fractional shares by default in live and paper environments.',
      'Fractional orders require the asset to be tradable and fractionable=true in Alpaca asset metadata.',
      'Fractional order requests can use qty or notional, but not both; this app uses quantity-based market orders.',
      'Fractional quantities can use up to 9 decimal places.',
      'Fractional orders use time_in_force=day for supported market/limit/stop/stop-limit orders.',
      'Fractional short sales are not supported; fractional sell orders must be long sells against owned quantity.',
      'Fractional day trades count toward day trade count and this app also counts them toward max trades per symbol per 24h.',
      'The same max buy per order notional protection applies to whole-share and fractional buy orders.',
    ],
    agentGuidance: 'Use fractional quantity only when fractional trading is enabled, Alpaca asset metadata confirms fractionable=true, estimated buy notional is within maxBuyOrderNotionalUsd, and the result does not bypass any existing trade-count, kill-switch, cash, or position rules.',
  };
}

function evaluateOrder({ userId, symbol, side, quantity, price, asset = null } = {}) {
  const summary = getRulesSummary({ userId });
  const normalizedSide = String(side || '').toLowerCase();
  const qty = Number(quantity || 0);
  const px = Number(price || 0);
  const notional = qty > 0 && px > 0 ? qty * px : 0;
  const fractional = isFractionalQuantity(qty);
  const failed = [];
  const warnings = [];

  if (!symbol) failed.push('symbol-required');
  if (!['buy', 'sell'].includes(normalizedSide)) failed.push('side-must-be-buy-or-sell');
  if (!Number.isFinite(qty) || qty <= 0) failed.push('quantity-must-be-positive');
  if (decimalPlaces(qty) > 9) failed.push('fractional-quantity-exceeds-9-decimals');
  if (fractional && !summary.fractionalTradingEnabled) failed.push('fractional-trading-disabled-in-settings');
  if (fractional && asset && asset.fractionable !== true) failed.push('alpaca-asset-not-fractionable');
  if (fractional && normalizedSide === 'sell' && !asset) warnings.push('confirm-owned-long-position-before-fractional-sell');
  if (normalizedSide === 'buy' && notional > summary.maxBuyOrderNotionalUsd) failed.push('max-buy-order-notional-exceeded');
  if (fractional && notional > 0 && notional < summary.fractionalMinNotionalUsd) failed.push('fractional-minimum-notional-not-met');

  return {
    provider: 'alpaca',
    version: VERSION,
    symbol,
    side: normalizedSide,
    quantity: qty,
    price: px,
    notionalUsd: roundMoney(notional),
    fractional,
    allowed: failed.length === 0,
    failed,
    warnings,
    rules: summary,
  };
}

function isFractionalQuantity(quantity) {
  const qty = Number(quantity || 0);
  return Number.isFinite(qty) && Math.abs(qty - Math.round(qty)) > 1e-9;
}

function decimalPlaces(value) {
  const text = String(value || '');
  if (/e-/i.test(text)) {
    const [mantissa, exponent] = text.toLowerCase().split('e-');
    const mantissaDecimals = mantissa.includes('.') ? mantissa.split('.')[1].length : 0;
    return Number(exponent || 0) + mantissaDecimals;
  }
  if (/e\+/i.test(text)) return 0;
  if (!text.includes('.')) return 0;
  return text.split('.')[1].replace(/0+$/, '').length;
}

function roundQuantity(value) {
  const qty = Number(value || 0);
  if (!Number.isFinite(qty)) return 0;
  return Number(qty.toFixed(9));
}

function roundMoney(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? Number(numeric.toFixed(2)) : 0;
}

function getSettingsRepo() {
  return require('../db/repositories/settingsRepo');
}

module.exports = {
  DOC_URL,
  VERSION,
  getRulesSummary,
  evaluateOrder,
  isFractionalQuantity,
  decimalPlaces,
  roundQuantity,
};
