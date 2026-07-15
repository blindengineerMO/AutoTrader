const db = require('../db/connection');

const latestReportsStmt = db.prepare(`
  SELECT id, mode, live_ready, summary_json, created_at
  FROM decision_reports
  ORDER BY created_at DESC, id DESC
  LIMIT ?
`);

function getPublicHomeSignal({ limit = 40 } = {}) {
  const reports = latestReportsStmt.all(limit).map(deserializeReport).filter(Boolean);
  const currentCutoff = Date.now() - 24 * 60 * 60 * 1000;
  const currentPick = selectTopBuy(reports.filter((report) => Date.parse(report.createdAt || 0) >= currentCutoff));
  const fallbackPick = currentPick || selectTopBuy(reports);

  if (!fallbackPick) {
    return {
      status: 'scanning',
      topBuy: null,
      message: 'AI council is scanning for the next high-conviction buy candidate.',
    };
  }

  return {
    status: currentPick ? 'current' : 'last',
    topBuy: fallbackPick,
    message: currentPick
      ? `${fallbackPick.symbol} is the current highest-ranked AI buy candidate.`
      : `${fallbackPick.symbol} is the most recent buy candidate from the latest completed decision reports.`,
  };
}

function selectTopBuy(reports = []) {
  const candidates = [];
  for (const report of reports) {
    for (const action of report.summary?.actions || []) {
      if (cleanAction(action.action || action.actionBias) !== 'buy') continue;
      const symbol = cleanSymbol(action.symbol);
      if (!symbol) continue;
      candidates.push({
        symbol,
        action: 'buy',
        score: scoreAction(action),
        reportId: report.id,
        reportMode: report.mode,
        reportCreatedAt: report.createdAt,
        status: action.status || 'candidate',
        reason: action.reason || action.rationale || report.summary?.overallRationale || 'Decision report identified a buy candidate.',
        sourceCount: countSources(report, action),
      });
    }
  }
  return candidates.sort((a, b) => b.score - a.score || Date.parse(b.reportCreatedAt || 0) - Date.parse(a.reportCreatedAt || 0))[0] || null;
}

function scoreAction(action = {}) {
  const score = Number(
    action.score
      ?? action.evidence?.localAiScore
      ?? action.localAiScore
      ?? action.evidence?.score
      ?? action.confidence
      ?? 0
  );
  return Number.isFinite(score) && score > 0 ? Math.round(score * 10) / 10 : 50;
}

function countSources(report, action) {
  const sourceStack = report.summary?.sourceStack;
  const actionSources = action.evidence?.sources || action.sources;
  if (Array.isArray(actionSources) && actionSources.length) return actionSources.length;
  if (Array.isArray(sourceStack) && sourceStack.length) return sourceStack.length;
  return report.summary?.researchNarrative?.sourceCount || report.summary?.sourcesEvaluated || 0;
}

function deserializeReport(row) {
  try {
    return {
      id: row.id,
      mode: row.mode,
      liveReady: Boolean(row.live_ready),
      summary: JSON.parse(row.summary_json || '{}'),
      createdAt: row.created_at,
    };
  } catch {
    return null;
  }
}

function cleanSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase().replace(/[^A-Z0-9.-]/g, '').slice(0, 12);
}

function cleanAction(action) {
  return String(action || '').trim().toLowerCase();
}

module.exports = { getPublicHomeSignal };
