const cheerio = require('cheerio');
const { config } = require('../config');
const providerCredentialRepo = require('../db/repositories/providerCredentialRepo');
const { resilientFetch } = require('../utils/resilientFetch');

const SEC_13F_ATOM_URL = 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=13F-HR&count=100&output=atom';
const SEC_13D_ATOM_URL = 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=SC%2013D&count=100&output=atom';
const SEC_13G_ATOM_URL = 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=SC%2013G&count=100&output=atom';

const SEC_OWNERSHIP_SOURCES = [
  {
    id: 'sec-current-13f-hr-atom',
    label: 'SEC current 13F-HR institutional manager filings Atom feed',
    url: SEC_13F_ATOM_URL,
    formType: '13F-HR',
    ownershipType: 'institutional-holdings',
  },
  {
    id: 'sec-current-sc-13d-atom',
    label: 'SEC current Schedule 13D activist/beneficial ownership Atom feed',
    url: SEC_13D_ATOM_URL,
    formType: 'SC 13D',
    ownershipType: 'activist-beneficial-ownership',
  },
  {
    id: 'sec-current-sc-13g-atom',
    label: 'SEC current Schedule 13G passive/qualified beneficial ownership Atom feed',
    url: SEC_13G_ATOM_URL,
    formType: 'SC 13G',
    ownershipType: 'passive-beneficial-ownership',
  },
];

async function collectInstitutionalOwnershipContext({
  userId,
  userAgent,
  timeoutMs = 8000,
  limit = 60,
  feedTypes,
  includeDetails = false,
  onEvent = () => {},
} = {}) {
  const resolvedUserAgent = resolveUserAgent({ userId, userAgent });
  if (!resolvedUserAgent) {
    return evaluateOwnershipContext({
      entries: [],
      failures: [{
        source: 'sec-ownership-feeds',
        error: 'SEC ownership feeds skipped; configure SEC_EDGAR_USER_AGENT or the SEC EDGAR provider User-Agent.',
      }],
      limit,
    });
  }

  const selected = selectSources(feedTypes);
  const boundedLimit = clampInt(limit, 1, 160);
  const settled = await Promise.allSettled(selected.map(async (source) => {
    const xml = await fetchSecText(source.url, { userAgent: resolvedUserAgent, timeoutMs });
    const entries = parseOwnershipAtomFeed(xml, source).slice(0, boundedLimit);
    emit(onEvent, 'sec-ownership', 44, 'debug', 'Fetched SEC institutional ownership feed.', {
      source: source.id,
      url: source.url,
      formType: source.formType,
      entries: entries.length,
    });
    if (!includeDetails) return entries;
    return enrichEntriesWithDetails(entries.slice(0, Math.min(12, boundedLimit)), { userAgent: resolvedUserAgent, timeoutMs, onEvent });
  }));

  const entries = [];
  const failures = [];
  settled.forEach((result, index) => {
    const source = selected[index];
    if (result.status === 'fulfilled') {
      entries.push(...result.value);
    } else {
      failures.push({ source: source.id, url: source.url, error: result.reason.message });
      emit(onEvent, 'sec-ownership', 44, 'warn', 'SEC ownership feed unavailable; continuing with remaining feeds.', {
        source: source.id,
        url: source.url,
        error: result.reason.message,
      });
    }
  });

  return evaluateOwnershipContext({ entries, failures, limit: boundedLimit });
}

function parseOwnershipAtomFeed(xml, source = {}) {
  const $ = cheerio.load(String(xml || ''), { xmlMode: true });
  return $('entry').toArray().map((entry) => {
    const node = $(entry);
    const title = cleanText(node.find('title').first().text());
    const summary = cleanText(node.find('summary').first().text());
    const link = node.find('link').first().attr('href') || '';
    const filingText = cleanText(`${title} ${summary}`);
    const formType = extractFormType(filingText) || source.formType || '';
    const filedAt = normalizeDate(node.find('updated').first().text() || extractFiledDate(filingText));
    const accessionNumber = extractAccessionNumber(filingText, link);
    const cik = extractCik(filingText, link);
    const filerName = extractFilerName(title, formType);
    const issuerName = extractIssuerName(filingText);
    const symbol = cleanSymbol(extractTicker(filingText));
    const percentOwned = extractPercentOwned(filingText);
    const ownershipType = ownershipTypeForForm(formType, source.ownershipType);
    return {
      sourceId: source.id,
      sourceUrl: source.url,
      formType,
      ownershipType,
      title,
      summary,
      url: absolutizeSecUrl(link),
      filedAt,
      accessionNumber,
      cik,
      filerName,
      issuerName,
      symbol,
      percentOwned,
      signalType: signalTypeForForm(formType),
      influenceScore: scoreOwnershipSignal({ formType, percentOwned, summary: filingText }),
      caveat: caveatForForm(formType),
    };
  }).filter((entry) => entry.title || entry.url || entry.formType);
}

async function enrichEntriesWithDetails(entries, { userAgent, timeoutMs, onEvent = () => {} } = {}) {
  const enriched = [];
  for (const entry of entries) {
    try {
      const detailUrl = entry.url;
      if (!detailUrl) {
        enriched.push(entry);
        continue;
      }
      const text = await fetchSecText(detailUrl, { userAgent, timeoutMs });
      const detail = parseOwnershipDocument(text, entry);
      enriched.push({ ...entry, ...detail, detailFetched: true });
      emit(onEvent, 'sec-ownership', 45, 'debug', 'Fetched SEC ownership filing detail.', {
        formType: entry.formType,
        url: detailUrl,
        filerName: entry.filerName,
        issuerName: detail.issuerName || entry.issuerName,
      });
    } catch (err) {
      enriched.push({ ...entry, detailFetched: false, detailError: err.message });
    }
  }
  return enriched;
}

function parseOwnershipDocument(content, entry = {}) {
  const $ = cheerio.load(String(content || ''), { xmlMode: /<\?xml|<informationTable|<edgarSubmission/i.test(String(content || '')) });
  $('script, style').remove();
  const text = cleanText($.text());
  const infoRows = parseInformationTableRows($, entry);
  const issuerName = extractIssuerName(text) || infoRows[0]?.issuerName || entry.issuerName || '';
  const symbol = cleanSymbol(extractTicker(text) || entry.symbol || infoRows[0]?.symbol);
  const percentOwned = extractPercentOwned(text) ?? entry.percentOwned ?? null;
  const positionValue = parseMoney(
    text.match(/\b(?:value|market value)\s*[:=]?\s*\$?([\d,.]+(?:\s*(?:thousand|million|billion|k|m|b))?)/i)?.[1]
  );
  const shares = parseMoney(text.match(/\b(?:shares|sshprnamt|amount)\s*[:=]?\s*([\d,.]+(?:\s*(?:k|m|b))?)/i)?.[1]);
  return {
    issuerName,
    symbol,
    percentOwned,
    positionValue,
    shares,
    holdings: infoRows.slice(0, 20),
    summaryText: text.slice(0, 900),
  };
}

function parseInformationTableRows($, entry = {}) {
  const rows = [];
  $('infoTable').each((_, table) => {
    const node = $(table);
    const issuerName = cleanText(node.find('nameOfIssuer').first().text());
    const cusip = cleanText(node.find('cusip').first().text()).toUpperCase();
    const value = parseMoney(node.find('value').first().text());
    const shares = parseMoney(node.find('sshPrnamt').first().text());
    const putCall = cleanText(node.find('putCall').first().text());
    const investmentDiscretion = cleanText(node.find('investmentDiscretion').first().text());
    if (!issuerName && !cusip) return;
    rows.push({
      issuerName,
      cusip,
      value,
      shares,
      putCall,
      investmentDiscretion,
      sourceUrl: entry.url,
    });
  });
  return rows;
}

function evaluateOwnershipContext({ entries = [], failures = [], limit = 60 } = {}) {
  const normalized = dedupeEntries(entries)
    .sort((a, b) => String(b.filedAt || '').localeCompare(String(a.filedAt || '')))
    .slice(0, clampInt(limit, 1, 160));
  const activistSignals = normalized.filter((entry) => /13D/i.test(entry.formType));
  const passiveSignals = normalized.filter((entry) => /13G/i.test(entry.formType));
  const institutionalSignals = normalized.filter((entry) => /13F/i.test(entry.formType));
  const newPositionSignals = normalized.filter((entry) => /new position|new stake|initial|acquired|beneficial owner|sole voting|shared voting/i.test(`${entry.title} ${entry.summary} ${entry.summaryText || ''}`));
  const reductionSignals = normalized.filter((entry) => /reduced|decreased|sold|disposed|termination|below 5|cease/i.test(`${entry.title} ${entry.summary} ${entry.summaryText || ''}`));
  const concentratedSignals = normalized.filter((entry) => Number(entry.percentOwned) >= 8);
  const activistPressureScore = clampScore(42 + activistSignals.length * 6 + average(activistSignals.map((entry) => entry.influenceScore - 50)) * 0.35);
  const passiveOwnershipScore = clampScore(45 + passiveSignals.length * 2 + concentratedSignals.length * 3);
  const institutionalDemandScore = clampScore(45 + institutionalSignals.length * 1.8 + newPositionSignals.length * 3 - reductionSignals.length * 3);
  const concentrationRiskScore = clampScore(38 + concentratedSignals.length * 5 + activistSignals.length * 2);
  const opportunityScore = clampScore(institutionalDemandScore * 0.42 + passiveOwnershipScore * 0.22 + activistPressureScore * 0.18 + (100 - concentrationRiskScore) * 0.18);
  const riskScore = clampScore(concentrationRiskScore * 0.42 + activistPressureScore * 0.28 + reductionSignals.length * 4 + failures.length * 1.5);
  const momentum = activistSignals.length ? 'sec-activist-ownership-watch'
    : newPositionSignals.length > reductionSignals.length ? 'sec-institutional-accumulation'
      : reductionSignals.length ? 'sec-ownership-reduction-watch'
        : 'sec-ownership-mixed';

  return {
    available: normalized.length > 0,
    provider: 'sec-edgar-ownership',
    fetchedAt: new Date().toISOString(),
    sourceList: sourceList(),
    failures,
    entryCount: normalized.length,
    formCounts: countBy(normalized, (entry) => entry.formType || 'unknown'),
    activistSignalCount: activistSignals.length,
    passiveSignalCount: passiveSignals.length,
    institutionalSignalCount: institutionalSignals.length,
    newPositionSignalCount: newPositionSignals.length,
    reductionSignalCount: reductionSignals.length,
    concentratedOwnerCount: concentratedSignals.length,
    activistPressureScore,
    passiveOwnershipScore,
    institutionalDemandScore,
    concentrationRiskScore,
    opportunityScore,
    riskScore,
    momentum,
    entries: normalized,
    topActivistSignals: activistSignals.slice(0, 12),
    topInstitutionalSignals: institutionalSignals.slice(0, 12),
    topBeneficialOwners: [...normalized].sort((a, b) => (b.percentOwned || 0) - (a.percentOwned || 0)).slice(0, 12),
    topReductions: reductionSignals.slice(0, 12),
    quoteDelayNote: 'SEC 13F holdings are delayed and do not reveal real-time current positions. Schedule 13D/13G beneficial ownership reports can indicate large owners or activist pressure, but issuer/ticker mapping and filing details must be verified before scoring live trades.',
    narrative: normalized.length
      ? `SEC ownership ${momentum}: ${normalized.length} recent 13F/13D/13G filing entries, ${activistSignals.length} activist/watch signals, ${institutionalSignals.length} institutional manager filings, ${concentratedSignals.length} concentrated owners.`
      : 'SEC institutional ownership context unavailable or empty; configure SEC User-Agent and retry later.',
  };
}

function scoreCandidate({ candidate, ownershipContext }) {
  if (!ownershipContext?.available) {
    return {
      normalized: 0.5,
      compositeScore: 50,
      exposure: 0,
      signals: [],
      explanation: 'SEC ownership feeds unavailable.',
    };
  }
  const symbol = cleanSymbol(candidate?.symbol);
  const companyName = cleanText(candidate?.companyName);
  const signals = (ownershipContext.entries || []).filter((entry) => matchesCandidate(entry, { symbol, companyName }));
  const exposure = clamp01(signals.length ? 0.42 + signals.length * 0.08 : candidateOwnershipExposure(candidate));
  const directScore = signals.length ? average(signals.map((entry) => entry.influenceScore)) : ownershipContext.opportunityScore;
  const activistPenalty = signals.some((entry) => /13D/i.test(entry.formType)) ? 0.05 : 0;
  const reductionPenalty = signals.filter((entry) => /reduced|decreased|sold|disposed|termination|below 5|cease/i.test(`${entry.summary} ${entry.summaryText || ''}`)).length * 0.05;
  const normalized = clamp01(0.5 + ((directScore - 50) / 100) * exposure + ((ownershipContext.institutionalDemandScore - 50) / 900) - activistPenalty - reductionPenalty);
  return {
    normalized,
    compositeScore: Math.round(normalized * 100),
    exposure: Math.round(exposure * 100),
    signals: signals.slice(0, 8),
    contextOpportunityScore: ownershipContext.opportunityScore,
    contextRiskScore: ownershipContext.riskScore,
    explanation: signals.length
      ? `SEC ownership signals for ${symbol || companyName || 'candidate'} include ${signals.length} 13F/13D/13G filing(s): ${signals.slice(0, 3).map((entry) => `${entry.formType} ${entry.filerName || entry.issuerName || 'filer'} influence ${entry.influenceScore}`).join(', ')}. Verify filings because 13F data is delayed and 13D/13G mappings can require document review.`
      : `${symbol || companyName || 'Candidate'} had no direct SEC ownership feed hit; applying broad institutional ownership context ${ownershipContext.opportunityScore}/${ownershipContext.riskScore}.`,
  };
}

function compactForBmcl(context = {}) {
  return {
    available: Boolean(context.available),
    provider: 'sec-edgar-ownership',
    fetchedAt: context.fetchedAt,
    momentum: context.momentum,
    opportunityScore: context.opportunityScore,
    riskScore: context.riskScore,
    activistPressureScore: context.activistPressureScore,
    passiveOwnershipScore: context.passiveOwnershipScore,
    institutionalDemandScore: context.institutionalDemandScore,
    concentrationRiskScore: context.concentrationRiskScore,
    entryCount: context.entryCount || 0,
    activistSignalCount: context.activistSignalCount || 0,
    passiveSignalCount: context.passiveSignalCount || 0,
    institutionalSignalCount: context.institutionalSignalCount || 0,
    newPositionSignalCount: context.newPositionSignalCount || 0,
    reductionSignalCount: context.reductionSignalCount || 0,
    concentratedOwnerCount: context.concentratedOwnerCount || 0,
    topActivistSignals: (context.topActivistSignals || []).slice(0, 8).map(compactOwnershipSignal),
    topInstitutionalSignals: (context.topInstitutionalSignals || []).slice(0, 8).map(compactOwnershipSignal),
    topBeneficialOwners: (context.topBeneficialOwners || []).slice(0, 8).map(compactOwnershipSignal),
    topReductions: (context.topReductions || []).slice(0, 8).map(compactOwnershipSignal),
    failures: (context.failures || []).slice(0, 6),
    sources: sourceList(),
    caveat: context.quoteDelayNote || 'SEC ownership feeds are official filing-discovery evidence; verify issuer/ticker mapping and remember 13F data is delayed.',
    bmclUse: 'Use as official SEC 13F/13D/13G ownership evidence for institutional accumulation/reduction, activist stakes, large beneficial owners, concentrated ownership, and hedge-fund/institutional manager debate. Agents should corroborate issuer/ticker mappings with SEC filing documents, company submissions, broker/Finnhub quotes, market data, and news before live scoring or orders.',
  };
}

function compactOwnershipSignal(entry = {}) {
  return {
    formType: entry.formType,
    ownershipType: entry.ownershipType,
    signalType: entry.signalType,
    filerName: entry.filerName,
    issuerName: entry.issuerName,
    symbol: entry.symbol,
    cik: entry.cik,
    percentOwned: entry.percentOwned,
    filedAt: entry.filedAt,
    accessionNumber: entry.accessionNumber,
    influenceScore: entry.influenceScore,
    url: entry.url,
    caveat: entry.caveat,
  };
}

function resolveUserAgent({ userId, userAgent } = {}) {
  if (userAgent) return userAgent;
  const credentials = userId ? providerCredentialRepo.getSecret(userId, 'sec-edgar') : null;
  return credentials?.userAgent || credentials?.contact || config.secEdgarUserAgent || '';
}

async function fetchSecText(url, { userAgent, timeoutMs = 8000 } = {}) {
  const res = await resilientFetch(url, {
    headers: {
      'User-Agent': userAgent,
      Accept: 'application/atom+xml,application/xml,text/xml,text/html,*/*',
    },
    redirect: 'follow',
  }, {
    bucket: 'sec-edgar',
    timeoutMs,
  });
  if (!res.ok) throw new Error(`SEC ownership request failed: ${res.status} ${url}`);
  return res.text();
}

function selectSources(feedTypes) {
  const filters = new Set((Array.isArray(feedTypes) ? feedTypes : [feedTypes]).filter(Boolean).map((item) => cleanText(item).toUpperCase()));
  if (!filters.size) return SEC_OWNERSHIP_SOURCES;
  return SEC_OWNERSHIP_SOURCES.filter((source) => filters.has(source.formType.toUpperCase()) || filters.has(source.id.toUpperCase()));
}

function sourceList() {
  return SEC_OWNERSHIP_SOURCES.map((source) => ({
    name: source.label,
    type: source.ownershipType,
    formType: source.formType,
    url: source.url,
  }));
}

function signalTypeForForm(formType) {
  if (/13D/i.test(formType)) return 'activist-or-control-stake';
  if (/13G/i.test(formType)) return 'large-passive-or-qualified-beneficial-owner';
  if (/13F/i.test(formType)) return 'delayed-institutional-manager-holdings';
  return 'ownership-filing';
}

function ownershipTypeForForm(formType, fallback) {
  if (/13D/i.test(formType)) return 'activist-beneficial-ownership';
  if (/13G/i.test(formType)) return 'passive-beneficial-ownership';
  if (/13F/i.test(formType)) return 'institutional-holdings';
  return fallback || 'ownership-filing';
}

function caveatForForm(formType) {
  if (/13F/i.test(formType)) return '13F holdings are delayed and do not reveal real-time current positions.';
  if (/13D/i.test(formType)) return 'Schedule 13D can indicate activist/control intent; verify the filing document and issuer mapping.';
  if (/13G/i.test(formType)) return 'Schedule 13G is often passive or qualified beneficial ownership; verify ownership percentage and filer status.';
  return 'Verify SEC filing details before scoring.';
}

function scoreOwnershipSignal({ formType, percentOwned, summary }) {
  let score = 50;
  if (/13D/i.test(formType)) score += 14;
  if (/13G/i.test(formType)) score += 5;
  if (/13F/i.test(formType)) score += 2;
  if (Number(percentOwned) >= 10) score += 8;
  else if (Number(percentOwned) >= 5) score += 4;
  if (/activist|control|board|nominee|strategic alternative|proposal|letter/i.test(summary || '')) score += 8;
  if (/new position|new stake|initial|acquired|beneficial owner|sole voting|shared voting/i.test(summary || '')) score += 6;
  if (/reduced|decreased|sold|disposed|termination|below 5|cease/i.test(summary || '')) score -= 12;
  return clampScore(score);
}

function matchesCandidate(entry, { symbol, companyName }) {
  const text = [entry.symbol, entry.issuerName, entry.summary, entry.title, entry.summaryText].join(' ').toLowerCase();
  if (symbol && entry.symbol === symbol) return true;
  if (symbol && new RegExp(`\\b${escapeRegExp(symbol)}\\b`, 'i').test(text)) return true;
  if (companyName && text.includes(companyName.toLowerCase())) return true;
  return false;
}

function candidateOwnershipExposure(candidate = {}) {
  const text = [candidate.symbol, candidate.companyName, candidate.theme, candidate.discovery?.method, ...(candidate.discovery?.tags || [])].join(' ').toLowerCase();
  const terms = ['activist', 'institutional', 'hedge fund', 'ownership', 'governance', 'undervalued', 'buyback', 'small cap', 'mid cap', 'turnaround', 'strategic'];
  return clamp01(0.16 + terms.filter((term) => text.includes(term)).length * 0.08);
}

function extractFormType(text) {
  return cleanText(text.match(/\b(13F-HR|SC\s*13D\/A|SC\s*13G\/A|SC\s*13D|SC\s*13G|13F)\b/i)?.[1]).toUpperCase().replace(/\s+/g, ' ');
}

function extractFiledDate(text) {
  return text.match(/\b(?:Filed|Accepted|Updated)\s*[:=]?\s*(20\d{2}-\d{2}-\d{2}(?:T[0-9:.+-]+Z?)?|\d{1,2}\/\d{1,2}\/20\d{2})/i)?.[1] || '';
}

function extractAccessionNumber(text, url) {
  return cleanText(text.match(/\b\d{10}-\d{2}-\d{6}\b/)?.[0]
    || String(url || '').match(/\b\d{10}-\d{2}-\d{6}\b/)?.[0]
    || String(url || '').match(/accession_number=([0-9-]+)/i)?.[1]);
}

function extractCik(text, url) {
  const cik = text.match(/\bCIK\s*[:=]?\s*(\d{1,10})\b/i)?.[1]
    || String(url || '').match(/[?&]CIK=(\d{1,10})/i)?.[1]
    || String(url || '').match(/\/data\/(\d{1,10})\//i)?.[1];
  return cik ? String(cik).padStart(10, '0') : '';
}

function extractFilerName(title, formType) {
  const text = cleanText(title);
  if (!text) return '';
  const withoutForm = cleanText(text.replace(new RegExp(`\\b${escapeRegExp(formType)}\\b`, 'i'), ''));
  return cleanText(withoutForm.split(/ for | filed by /i)[0].replace(/^[-\s]+/, '')).slice(0, 140);
}

function extractIssuerName(text) {
  return cleanText(
    text.match(/\b(?:Issuer|Subject Company|Name of Issuer|Company Name|Title of Class)\s*[:=]?\s*([A-Z0-9&.,'() -]{2,140}?)(?:\s{2,}|\s+\||\s+(?:CUSIP|CIK|Ticker|Item|Percent|%|Class)\b|$)/i)?.[1]
  );
}

function extractTicker(text) {
  return text.match(/\b(?:Ticker|Trading Symbol|Symbol)\s*[:=]?\s*([A-Z][A-Z0-9.-]{0,7})\b/i)?.[1] || '';
}

function extractPercentOwned(text) {
  const match = text.match(/\b(?:percent(?:\s+owned)?|percentage(?:\s+owned)?|amount beneficially owned|aggregate amount|ownership)\s*(?:of class)?\s*[:=]?\s*(\d{1,3}(?:\.\d+)?)\s*%/i)
    || text.match(/\b(\d{1,3}(?:\.\d+)?)\s*%\s*(?:of class|beneficially owned|ownership|voting)/i);
  const parsed = Number(match?.[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeDate(value) {
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) return date.toISOString();
  return cleanText(value);
}

function absolutizeSecUrl(value) {
  if (!value) return '';
  try {
    return new URL(value, 'https://www.sec.gov').toString();
  } catch {
    return value;
  }
}

function dedupeEntries(entries) {
  const seen = new Set();
  return entries.filter((entry) => {
    const key = [entry.formType, entry.accessionNumber, entry.url, entry.filerName, entry.issuerName, entry.filedAt].join(':');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function countBy(items, selector) {
  return items.reduce((counts, item) => {
    const key = selector(item);
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

function cleanSymbol(value) {
  const symbol = cleanText(value).toUpperCase().replace(/[^A-Z0-9.-]/g, '');
  return /^[A-Z][A-Z0-9.-]{0,7}$/.test(symbol) ? symbol : '';
}

function cleanText(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseMoney(value) {
  const text = cleanText(value).replace(/[$,]/g, '').toLowerCase();
  const match = text.match(/^(-?\d+(?:\.\d+)?)\s*(thousand|million|billion|k|m|b)?$/);
  if (!match) return null;
  const base = Number(match[1]);
  const mult = { thousand: 1e3, k: 1e3, million: 1e6, m: 1e6, billion: 1e9, b: 1e9 }[match[2]] || 1;
  return Number.isFinite(base) ? base * mult : null;
}

function average(values) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return 50;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function clampScore(value) {
  return Math.round(clamp(value, 0, 100));
}

function clampInt(value, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function emit(onEvent, phase, progress, level, message, data) {
  onEvent({ phase, progress, level, message, data });
}

module.exports = {
  SEC_13F_ATOM_URL,
  SEC_13D_ATOM_URL,
  SEC_13G_ATOM_URL,
  SEC_OWNERSHIP_SOURCES,
  collectInstitutionalOwnershipContext,
  parseOwnershipAtomFeed,
  parseOwnershipDocument,
  evaluateOwnershipContext,
  scoreCandidate,
  compactForBmcl,
  sourceList,
};
