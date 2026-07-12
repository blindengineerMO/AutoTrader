const specRepo = require('../../db/repositories/specResearchRepo');

function ingestHistoricalDataset({
  userId,
  datasetVersion,
  sourceName = 'historical-pit-import',
  sourceUrl = null,
  observedAt = new Date().toISOString(),
  availableAt = observedAt,
  revisionVersion = 1,
  universeVersion = datasetVersion,
  securities = [],
  bars = [],
  corporateActions = [],
  calendarDays = [],
  market = 'US',
}) {
  if (!userId) throw new Error('userId is required');
  if (!datasetVersion) throw new Error('datasetVersion is required');

  const rawSource = specRepo.saveRawSource({
    userId,
    sourceName,
    sourceUrl,
    observedAt,
    availableAt,
    revisionVersion,
    payload: {
      datasetVersion,
      universeVersion,
      counts: {
        securities: securities.length,
        bars: bars.length,
        corporateActions: corporateActions.length,
        calendarDays: calendarDays.length,
      },
    },
  });

  const normalizedSecurities = securities.map((security) => ({
    ...security,
    isActive: security.isActive ?? !security.delistingDate,
    isTradeable: security.isTradeable ?? !security.delistingDate,
  }));
  for (const security of normalizedSecurities) {
    specRepo.upsertSecurity(userId, security);
  }

  const memberships = normalizedSecurities.map((security) => ({
    symbol: security.symbol,
    permanentId: security.permanentId,
    memberFrom: security.listingDate || null,
    memberTo: security.delistingDate || null,
    reason: security.delistingDate ? 'retained_delisted_security' : 'active_security',
    sourceRawId: rawSource.id,
  }));
  specRepo.saveUniverseMemberships({ userId, universeVersion, memberships });

  specRepo.saveMarketBars({
    userId,
    bars: bars.map((bar) => ({
      ...bar,
      dataSource: bar.dataSource || sourceName,
      sourceRawId: rawSource.id,
      revisionVersion,
    })),
  });
  specRepo.saveCorporateActions({
    userId,
    actions: corporateActions.map((action) => ({
      ...action,
      sourceRawId: rawSource.id,
      revisionVersion,
    })),
  });
  specRepo.saveMarketCalendarDays({
    market,
    days: calendarDays.map((day) => ({
      ...day,
      sourceRawId: rawSource.id,
    })),
  });

  return {
    rawSource,
    universeVersion,
    counts: {
      securities: normalizedSecurities.length,
      bars: bars.length,
      corporateActions: corporateActions.length,
      calendarDays: calendarDays.length,
      memberships,
    },
  };
}

module.exports = { ingestHistoricalDataset };
