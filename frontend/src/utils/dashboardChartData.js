export function buildPositionChartData(positions = []) {
  const rows = Array.isArray(positions) ? positions : [];
  const openPositions = rows.filter((position) => Number(position?.quantity || 0) > 0);
  if (!openPositions.length) return { labels: ['No positions'], values: [0] };
  return {
    labels: openPositions.map((position) => String(position.symbol || 'Unknown')),
    values: openPositions.map((position) => roundMoney(position.market_value_usd)),
  };
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}
