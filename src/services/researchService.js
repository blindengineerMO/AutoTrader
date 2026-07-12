const finnhub = require('./marketData/finnhubClient');
const webScrapeClient = require('./marketData/webScrapeClient');
const researchRepo = require('../db/repositories/researchRepo');
const providerCredentialRepo = require('../db/repositories/providerCredentialRepo');
const { config } = require('../config');
const logger = require('../utils/logger');

const DEFAULT_WATCHLIST = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'TSLA', 'AMD', 'META', 'SPY', 'QQQ'];

function computeSignals(quotes) {
  return quotes.map((q) => {
    const rangePct = q.open ? ((q.high - q.low) / q.open) * 100 : 0;
    return {
      symbol: q.symbol,
      price: q.current,
      changePct: Number(q.changePct.toFixed(2)),
      volatilityPct: Number(rangePct.toFixed(2)),
      momentum: q.changePct > 1 ? 'bullish' : q.changePct < -1 ? 'bearish' : 'neutral',
    };
  });
}

async function runResearchCycle(watchlist = DEFAULT_WATCHLIST, { userId } = {}) {
  logger.info('Running research cycle', { watchlist });
  const finnhubCredentials = userId ? providerCredentialRepo.getSecret(userId, 'finnhub') : null;
  const finnhubApiKey = finnhubCredentials?.apiKey || config.finnhubApiKey;
  let source = 'finnhub';
  let quotes = [];
  if (finnhubApiKey) {
    quotes = await finnhub.getQuotes(watchlist, { apiKey: finnhubApiKey });
  }
  if (!quotes.length) {
    source = 'web-scrape:yahoo-stooq';
    logger.warn('Finnhub unavailable or unconfigured, falling back to web-scraped market research');
    quotes = await webScrapeClient.getQuotes(watchlist);
  }
  const signals = computeSignals(quotes);

  const snapshot = researchRepo.create({
    source,
    summary: {
      watchlist,
      quoteCount: quotes.length,
      fetchedAt: new Date().toISOString(),
      fallbackUsed: source !== 'finnhub',
      evidence: quotes.map((q) => ({
        symbol: q.symbol,
        current: q.current,
        open: q.open,
        high: q.high,
        low: q.low,
        prevClose: q.prevClose,
        changePct: Number((q.changePct || 0).toFixed(2)),
      })),
    },
    signals,
  });

  logger.info('Research cycle complete', { snapshotId: snapshot.id, signalCount: signals.length });
  return snapshot;
}

module.exports = { runResearchCycle, computeSignals, DEFAULT_WATCHLIST };
