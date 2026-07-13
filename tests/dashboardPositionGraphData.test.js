describe('dashboard position graph data', () => {
  it('uses actual per-position market values instead of synthetic telemetry', async () => {
    const { buildPositionChartData } = await import('../frontend/src/utils/dashboardChartData.js');

    const graph = buildPositionChartData([
      { symbol: 'F', quantity: 2, market_value_usd: 28 },
      { symbol: 'NVDA', quantity: 1, market_value_usd: 120.126 },
      { symbol: 'CASH', quantity: 0, market_value_usd: 999 },
    ]);

    expect(graph.labels).toEqual(['F', 'NVDA']);
    expect(graph.values).toEqual([28, 120.13]);
  });

  it('returns a stable empty state when there are no open positions', async () => {
    const { buildPositionChartData } = await import('../frontend/src/utils/dashboardChartData.js');

    expect(buildPositionChartData([])).toEqual({ labels: ['No positions'], values: [0] });
  });
});
