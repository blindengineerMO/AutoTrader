const brain = require('brain.js/dist/browser.js');
const webScrapeClient = require('./marketData/webScrapeClient');
const forecastRunRepo = require('../db/repositories/forecastRunRepo');

const HORIZON_DAYS = 90;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ROLLOUTS = 200;

function gaussianRandom() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

function buildForecastSeries(closes) {
  const logReturns = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
  const mean = logReturns.reduce((sum, r) => sum + r, 0) / logReturns.length;
  const variance = logReturns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / logReturns.length;
  const std = Math.sqrt(variance) || 1e-6;
  const normalized = logReturns.map((r) => (r - mean) / std);

  const net = new brain.recurrent.LSTMTimeStep({
    inputSize: 1,
    hiddenLayers: [10],
    outputSize: 1,
  });
  net.train([normalized], { iterations: 60, errorThresh: 0.01, log: false });

  const seed = normalized.slice(-30);
  const forecastNormalized = Array.from(net.forecast(seed, HORIZON_DAYS));
  const medianLogReturns = forecastNormalized.map((v) => v * std + mean);

  const lastClose = closes[closes.length - 1];
  const rollouts = [];
  for (let r = 0; r < ROLLOUTS; r += 1) {
    let price = lastClose;
    const path = [];
    for (let day = 0; day < HORIZON_DAYS; day += 1) {
      const noise = gaussianRandom() * std;
      price *= Math.exp(medianLogReturns[day] + noise);
      path.push(price);
    }
    rollouts.push(path);
  }

  const series = [];
  for (let day = 0; day < HORIZON_DAYS; day += 1) {
    const dayPrices = rollouts.map((path) => path[day]).sort((a, b) => a - b);
    series.push({
      day: day + 1,
      p10: Number(percentile(dayPrices, 0.1).toFixed(2)),
      p50: Number(percentile(dayPrices, 0.5).toFixed(2)),
      p90: Number(percentile(dayPrices, 0.9).toFixed(2)),
    });
  }
  return series;
}

async function getForecast(userId, symbol) {
  const cached = forecastRunRepo.getLatest(userId, symbol);
  if (cached && Date.now() - new Date(cached.generated_at).getTime() < CACHE_TTL_MS) {
    return { symbol, generatedAt: cached.generated_at, days: cached.series, cached: true };
  }
  const closes = await webScrapeClient.getDailyCloses(symbol, '2y');
  const series = buildForecastSeries(closes);
  const saved = forecastRunRepo.save({ userId, symbol, horizonDays: HORIZON_DAYS, series });
  return { symbol, generatedAt: saved.generated_at, days: series, cached: false };
}

module.exports = { getForecast };
