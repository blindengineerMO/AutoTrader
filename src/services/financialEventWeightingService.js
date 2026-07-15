const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const WEIGHT_DOC_PATH = path.join(__dirname, '..', '..', 'WEIGHT.md');

const CERTAINTY_MULTIPLIERS = {
  confirmed: 1.0,
  announced: 0.9,
  expects: 0.65,
  forecasts: 0.65,
  plans: 0.5,
  may: 0.35,
  could: 0.3,
  considering: 0.25,
  reportedly: 0.4,
  rumored: 0.15,
  anonymous_social_media_claim: 0.05,
  officially_denied: -0.25,
};

const SOURCE_RELIABILITY = {
  sec_filing: 1.0,
  court_or_regulatory_document: 1.0,
  official_government_release: 1.0,
  audited_financial_statement: 1.0,
  company_earnings_release: 0.9,
  company_investor_presentation: 0.75,
  earnings_call_transcript: 0.75,
  recognized_wire_service: 0.85,
  major_financial_news_publication: 0.8,
  industry_trade_publication: 0.7,
  local_news_with_direct_reporting: 0.65,
  analyst_report: 0.65,
  company_press_release: 0.65,
  aggregated_news_summary: 0.45,
  blog_with_identified_author: 0.35,
  social_media_verified_company_account: 0.6,
  social_media_identified_individual: 0.2,
  anonymous_forum_post: 0.05,
  unattributed_repost: 0.02,
};

const CONTEXT_DEPENDENT_TERMS = new Set([
  'lower prices',
  'higher interest rates',
  'oil prices increased',
  'strong dollar',
  'layoffs',
  'acquisition',
  'share repurchase',
  'capital expenditure increased',
  'inventory increased',
  'tax rate declined',
]);

const EVENT_CATEGORIES = [
  'earnings',
  'revenue',
  'guidance',
  'cash_flow',
  'margin',
  'balance_sheet',
  'debt',
  'capital_allocation',
  'customer',
  'product',
  'competition',
  'supply_chain',
  'management',
  'accounting',
  'legal',
  'regulatory',
  'merger_acquisition',
  'cybersecurity',
  'labor',
  'macro',
  'commodity',
  'weather',
  'geopolitical',
  'analyst_revision',
  'insider_transaction',
  'institutional_positioning',
];

const POSITIVE_COMBINATIONS = [
  { pattern: ['revenue beat', 'margin beat', 'raised guidance'], bonus: 2 },
  { pattern: ['organic growth', 'free cash flow growth', 'share count declined'], bonus: 1.5 },
  { pattern: ['debt reduction', 'credit upgrade', 'interest coverage improved'], bonus: 1.5 },
  { pattern: ['regulatory approval', 'commercial launch', 'reimbursement secured'], bonus: 2 },
  { pattern: ['customer growth', 'churn declined', 'pricing increased'], bonus: 1.5 },
];

const NEGATIVE_COMBINATIONS = [
  { pattern: ['revenue miss', 'guidance reduced', 'inventory increased'], penalty: -2 },
  { pattern: ['cash burn increased', 'capital raise', 'going concern'], penalty: -3 },
  { pattern: ['auditor resignation', 'delayed filing', 'internal control weakness'], penalty: -3 },
  { pattern: ['customer loss', 'pricing pressure', 'margin compression'], penalty: -2 },
  { pattern: ['covenant breach', 'liquidity concern', 'refinancing risk'], penalty: -3 },
];

const LEXICON = loadWeightLexicon();

function scoreCandidateEvidence({ candidate = {}, news = { items: [] }, learned = { observations: [] }, chatResearch = null, learnedCategoryMultipliers = {} } = {}) {
  const documents = buildDocuments({ news, learned, chatResearch });
  const seenEventKeys = new Map();
  const events = [];
  for (const document of documents) {
    const scored = scoreDocumentForCandidate(document, candidate, seenEventKeys, { learnedCategoryMultipliers });
    events.push(...scored.events);
  }

  const aggregateScore = round(events.reduce((sum, event) => sum + event.final_event_score, 0));
  const aggregateAbsScore = round(events.reduce((sum, event) => sum + Math.abs(event.final_event_score), 0));
  return {
    model: 'weight.md-event-multiplier-v1',
    documentCount: documents.length,
    aggregateScore,
    aggregateAbsScore,
    normalized: clamp01((aggregateScore + 12) / 24),
    topEvents: events
      .sort((a, b) => Math.abs(b.final_event_score) - Math.abs(a.final_event_score))
      .slice(0, 8),
    categoryImpacts: summarizeCategories(events),
  };
}

function scoreDocumentFinancialEvents({ text = '', title = '', url = '', sourceType = null } = {}) {
  const document = {
    title,
    url,
    text: `${title || ''} ${text || ''}`,
    sourceType,
    credibilityScore: null,
  };
  const result = scoreDocumentForCandidate(document, {}, new Map(), { generic: true });
  const aggregateScore = round(result.events.reduce((sum, event) => sum + event.final_event_score, 0));
  return {
    aggregateScore,
    aggregateAbsScore: round(result.events.reduce((sum, event) => sum + Math.abs(event.final_event_score), 0)),
    events: result.events,
  };
}

function scoreDocumentForCandidate(document, candidate, seenEventKeys, { generic = false, learnedCategoryMultipliers = {} } = {}) {
  const text = cleanText(`${document.title || ''}. ${document.text || ''}`);
  if (!text) return { events: [] };
  const sourceType = inferSourceType(document);
  const sourceReliability = sourceReliabilityMultiplier(sourceType);
  const historicalSourceAccuracy = historicalAccuracyMultiplier(document.credibilityScore);
  const companyRelevance = generic ? 1 : companyRelevanceMultiplier({ candidate, text, url: document.url });
  if (!generic && companyRelevance < 0.25) return { events: [] };

  const clauses = splitContrastClauses(text);
  const events = [];
  for (const clause of clauses) {
    for (const entry of LEXICON) {
      if (!phraseMatches(clause.text, entry.term)) continue;
      const baseWeight = contextualBaseWeight(entry, clause.text);
      if (baseWeight === 0) continue;
      const certainty = inferCertainty(clause.text, document);
      const novelty = noveltyMultiplier({ document, entry, candidate, seenEventKeys });
      const magnitude = magnitudeMultiplier(clause.text);
      const surprise = surpriseMultiplier(clause.text, baseWeight);
      const timeDecay = timeDecayMultiplier(document.publishedAt || document.created_at);
      const penalties = penaltiesForClause(clause.text, document, novelty);
      const learnedCategoryMultiplier = learnedCategoryMultipliers[entry.category] ?? 1;
      const eventScore = baseWeight
        * sourceReliability
        * CERTAINTY_MULTIPLIERS[certainty]
        * companyRelevance
        * magnitude
        * novelty
        * surprise
        * timeDecay
        * historicalSourceAccuracy
        * learnedCategoryMultiplier
        * clause.multiplier;
      const finalScore = round(eventScore - penalties.total);
      if (Math.abs(finalScore) < 0.05) continue;
      events.push({
        document_id: documentId(document),
        ticker: candidate.symbol || null,
        published_at: document.publishedAt || document.created_at || null,
        source: {
          domain: hostname(document.url),
          type: sourceType,
          reliability: sourceReliability,
        },
        event: {
          category: entry.category,
          type: slugify(entry.term),
          base_weight: baseWeight,
          direction: baseWeight > 0 ? 'positive' : 'negative',
        },
        statement: {
          text: clause.text.slice(0, 420),
          subject: candidate.companyName || candidate.symbol || null,
          certainty,
          time_horizon: inferTimeHorizon(clause.text),
        },
        financial_effect: {
          affected_metric: affectedMetric(entry),
          magnitude_relative_to_prior: inferredMagnitudePct(clause.text),
          surprise_relative_to_consensus: inferredSurpriseLabel(clause.text),
          currency: 'USD',
        },
        adjustments: {
          source_multiplier: sourceReliability,
          certainty_multiplier: CERTAINTY_MULTIPLIERS[certainty],
          company_relevance: companyRelevance,
          magnitude_multiplier: magnitude,
          novelty_multiplier: novelty,
          surprise_multiplier: surprise,
          time_decay: timeDecay,
          historical_source_accuracy: historicalSourceAccuracy,
          learned_category_multiplier: learnedCategoryMultiplier,
        },
        penalties,
        final_event_score: finalScore,
        evidence_urls: document.url ? [document.url] : [],
        contradictions: [],
        requires_human_review: penalties.manipulation_risk > 0.5 || certainty === 'rumored',
      });
    }
  }

  for (const combo of combinationEvents({ text, document, candidate, sourceReliability, companyRelevance, historicalSourceAccuracy })) {
    events.push(combo);
  }
  return { events };
}

function buildDocuments({ news, learned, chatResearch }) {
  const docs = [];
  for (const item of news.items || []) {
    docs.push({
      title: item.title || item.source || 'News item',
      url: item.link || item.url || '',
      text: `${item.title || ''}. ${item.description || ''}`,
      sourceType: item.sourceType || 'aggregated_news_summary',
      publishedAt: item.publishedAt,
      credibilityScore: 55,
    });
  }
  for (const item of learned.observations || []) {
    docs.push({
      title: item.title || item.url || 'Learned source',
      url: item.url || '',
      text: `${item.title || ''}. ${item.excerpt || ''}`,
      sourceType: item.sourceType || item.score?.sourceType || 'learned_crawl',
      credibilityScore: item.score?.credibility,
    });
  }
  if (chatResearch) {
    const hints = Array.isArray(chatResearch) ? chatResearch : [chatResearch];
    for (const hint of hints) {
      docs.push({
        title: `${(hint.providers || ['chat']).join(', ')} research hint`,
        url: hint.sourceUrls?.[0] || '',
        text: `${hint.reason || ''}. ${(hint.reasons || []).join('. ')}`,
        sourceType: 'analyst_report',
        credibilityScore: Math.round(50 + Number(hint.confidence || 0.5) * 30),
      });
    }
  }
  return docs;
}

function loadWeightLexicon() {
  let content = '';
  try {
    content = fs.readFileSync(WEIGHT_DOC_PATH, 'utf8');
  } catch {
    content = '';
  }
  const rows = [];
  let section = '';
  let category = 'general';
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('# ')) section = line.toLowerCase();
    if (line.startsWith('## ')) category = mapCategory(line.replace(/^##\s+/, ''));
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((cell) => cell.trim()).filter(Boolean);
    if (cells.length < 2 || /term|---|text/i.test(cells[0])) continue;
    const base = Number(cells[1].replace(/[+]/g, ''));
    if (!Number.isFinite(base)) continue;
    rows.push({
      term: cleanText(cells[0]).toLowerCase(),
      baseWeight: base,
      category,
      section: section.includes('negative') ? 'negative' : section.includes('positive') ? 'positive' : 'general',
      context: cells[2] || '',
    });
  }
  return dedupeLexicon(rows).sort((a, b) => b.term.length - a.term.length);
}

function dedupeLexicon(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = row.term;
    if (!map.has(key) || Math.abs(row.baseWeight) > Math.abs(map.get(key).baseWeight)) map.set(key, row);
  }
  return [...map.values()];
}

function splitContrastClauses(text) {
  return cleanText(text)
    .split(/\b(but|however|although|despite|while)\b/i)
    .reduce((clauses, part, index, arr) => {
      if (/^(but|however)$/i.test(part)) return clauses;
      if (/^(although|despite|while)$/i.test(part)) return clauses;
      const prior = arr[index - 1];
      const multiplier = /but|however/i.test(prior || '') ? 1.25 : /although|despite|while/i.test(prior || '') ? 0.75 : 1;
      if (cleanText(part).length >= 8) clauses.push({ text: cleanText(part), multiplier });
      return clauses;
    }, []);
}

function phraseMatches(text, phrase) {
  const normalizedText = normalize(text);
  const normalizedPhrase = normalize(phrase);
  if (!normalizedPhrase) return false;
  return new RegExp(`\\b${escapeRegex(normalizedPhrase)}\\b`, 'i').test(normalizedText);
}

function contextualBaseWeight(entry, text) {
  let base = Number(entry.baseWeight || 0);
  const normalized = normalize(text);
  if (CONTEXT_DEPENDENT_TERMS.has(entry.term) && !hasContextResolver(normalized)) return 0;
  if (isNegated(normalized, entry.term)) base *= -0.65;
  if (/temporary|one-time|nonrecurring|tax charge|unsustainable/i.test(text)) base *= 0.45;
  return base;
}

function isNegated(text, phrase) {
  const escaped = escapeRegex(normalize(phrase));
  return new RegExp(`\\b(no|not|without|never|neither|fails? to|wasn't|isn't|didn't)\\b(?:\\W+\\w+){0,5}\\W+${escaped}`, 'i').test(text);
}

function hasContextResolver(text) {
  return /(producer|supplier|seller|retailer|buyer|bank|insurer|importer|exporter|cost|margin|accretive|dilutive|below intrinsic|demand|overpayment|leverage|pricing power)/i.test(text);
}

function inferCertainty(text, document) {
  const lower = normalize(text);
  if (/officially denied|denied by/.test(lower)) return 'officially_denied';
  if (/anonymous|unverified social|forum|reddit|stocktwits/.test(lower)) return 'anonymous_social_media_claim';
  for (const key of ['rumored', 'reportedly', 'considering', 'could', 'may', 'plans', 'forecasts', 'expects', 'announced']) {
    if (lower.includes(key)) return key;
  }
  if (/(confirmed|completed|filed|reported|won|awarded|approved|dismissed|closed)/.test(lower)) return 'confirmed';
  if (/press-release|company_press_release|company/.test(document.sourceType || '')) return 'announced';
  return 'confirmed';
}

function sourceReliabilityMultiplier(sourceType) {
  return SOURCE_RELIABILITY[sourceType] ?? 0.55;
}

function inferSourceType(document) {
  const url = String(document.url || '').toLowerCase();
  const host = hostname(url);
  const sourceType = String(document.sourceType || '').toLowerCase();
  if (/sec\.gov|edgar/.test(url)) return 'sec_filing';
  if (/court|justice\.gov|ftc\.gov|fda\.gov|sec\.gov|regulator/.test(url)) return 'court_or_regulatory_document';
  if (/\.gov\b|bls\.gov|bea\.gov|census\.gov|eia\.gov|treasury\.gov|federalreserve\.gov/.test(host)) return 'official_government_release';
  if (/earnings/.test(sourceType)) return 'company_earnings_release';
  if (/press/.test(sourceType)) return 'company_press_release';
  if (/reuters|apnews|associatedpress|bloomberg/.test(host)) return 'recognized_wire_service';
  if (/wsj|ft\.com|cnbc|marketwatch|finance\.yahoo|barrons|forbes/.test(host)) return 'major_financial_news_publication';
  if (/blog|substack|medium/.test(host)) return 'blog_with_identified_author';
  if (/x\.com|twitter|stocktwits|reddit|facebook/.test(host)) return 'social_media_identified_individual';
  if (/chat|analyst/.test(sourceType)) return 'analyst_report';
  if (/news|rss|search/.test(sourceType)) return 'aggregated_news_summary';
  return 'industry_trade_publication';
}

function companyRelevanceMultiplier({ candidate, text, url }) {
  const symbol = String(candidate.symbol || '').toUpperCase();
  const company = normalize(candidate.companyName || '');
  const normalized = normalize(`${text} ${url || ''}`);
  if (symbol && new RegExp(`(\\$|\\b)${escapeRegex(symbol)}\\b`, 'i').test(text)) return 1;
  if (company && normalized.includes(company)) return 0.95;
  const aliases = (candidate.discovery?.evidence || []).map((item) => item.reason || '').join(' ');
  if (aliases && aliases.split(/\W+/).some((word) => word.length > 4 && normalized.includes(word.toLowerCase()))) return 0.65;
  const geoBoost = geographicRelevanceBoost({ candidate, normalized });
  if (candidate.theme && normalized.includes(String(candidate.theme).split('+')[0].toLowerCase())) return Math.min(1, 0.55 + geoBoost);
  return Math.min(1, 0.2 + geoBoost);
}

// Headquarters disruptions ripple through the whole company; supply-chain
// (manufacturing) sites hit production directly; customer/retail exposure is
// revenue-side and more indirect. Locations with no known exposure type
// (bare `primaryLocations` entries) get the weakest weight.
const EXPOSURE_TYPE_WEIGHT = {
  headquarters: 0.45,
  supply_chain: 0.4,
  customer_market: 0.3,
  retail: 0.25,
  office: 0.2,
  mentioned: 0.15,
};

const SEVERITY_MULTIPLIERS = [
  { pattern: /catastrophic|devastating|widespread|state of emergency|nationwide/, multiplier: 1.3 },
  { pattern: /major|severe|significant disruption|mass (casualty|casualties)/, multiplier: 1.15 },
  { pattern: /minor|localized|contained|limited impact/, multiplier: 0.6 },
];

function geographicSeverityMultiplier(text) {
  for (const { pattern, multiplier } of SEVERITY_MULTIPLIERS) {
    if (pattern.test(text)) return multiplier;
  }
  return 1;
}

// When a location-coordinator profile is attached to the candidate and the event
// text names a place where the company has geographic exposure, raise relevance
// so geo events (war/disaster/strike/gas) correlate to geographically-exposed
// companies even when the company isn't named in the event. Scaled by the type
// of exposure (headquarters > supply chain > customer market > retail) and by
// the event's apparent severity. Self-contained (no cross-service require) to
// avoid a circular dependency with the crawler.
function geographicRelevanceBoost({ candidate, normalized }) {
  const profile = candidate.locationProfile;
  if (!profile) return 0;

  const weightByLocation = new Map();
  const setWeight = (location, weight) => {
    const term = normalize(location);
    if (term.length < 3) return;
    weightByLocation.set(term, Math.max(weightByLocation.get(term) || 0, weight));
  };
  for (const exposure of profile.exposures || []) {
    setWeight(exposure.location, EXPOSURE_TYPE_WEIGHT[exposure.type] ?? EXPOSURE_TYPE_WEIGHT.mentioned);
  }
  for (const location of profile.manufacturing || []) setWeight(location, EXPOSURE_TYPE_WEIGHT.supply_chain);
  for (const location of profile.topSalesRegions || []) setWeight(location, EXPOSURE_TYPE_WEIGHT.customer_market);
  for (const location of profile.primaryLocations || []) {
    const term = normalize(location);
    if (term.length >= 3 && !weightByLocation.has(term)) weightByLocation.set(term, EXPOSURE_TYPE_WEIGHT.mentioned);
  }

  let matchedWeight = 0;
  for (const [term, weight] of weightByLocation) {
    if (normalized.includes(term)) matchedWeight = Math.max(matchedWeight, weight);
  }
  if (!matchedWeight) return 0;
  return round(matchedWeight * geographicSeverityMultiplier(normalized));
}

function noveltyMultiplier({ document, entry, candidate, seenEventKeys }) {
  const key = [
    candidate.symbol || '',
    entry.term,
    normalize(document.title || '').slice(0, 80),
    hostname(document.url || ''),
  ].join('|');
  const count = seenEventKeys.get(key) || 0;
  seenEventKeys.set(key, count + 1);
  if (count === 0) return 1;
  if (count === 1) return 0.3;
  return 0.05;
}

function magnitudeMultiplier(text) {
  const pct = inferredMagnitudePct(text);
  if (pct >= 25) return 1.6;
  if (pct >= 10) return 1.3;
  if (pct >= 5) return 1.0;
  if (pct >= 2) return 0.8;
  if (pct >= 0.5) return 0.5;
  if (/\b(transformative|major|billion|bn)\b/i.test(text)) return 1.3;
  if (/\b(material|significant)\b/i.test(text)) return 1.0;
  if (/\bsmall|minor|immaterial\b/i.test(text)) return 0.2;
  return 0.8;
}

function inferredMagnitudePct(text) {
  const percentages = [...String(text || '').matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map((match) => Number(match[1]));
  return percentages.length ? Math.max(...percentages) : null;
}

function surpriseMultiplier(text, baseWeight) {
  const lower = normalize(text);
  if (/far below|well below|sharply below/.test(lower)) return baseWeight > 0 ? -1.5 : 1.5;
  if (/below expectations|missed expectations|below consensus|weaker than expected/.test(lower)) return baseWeight > 0 ? -1 : 1;
  if (/slightly below/.test(lower)) return baseWeight > 0 ? -0.5 : 0.5;
  if (/far above|well above|sharply above/.test(lower)) return baseWeight > 0 ? 1.5 : -1.5;
  if (/above expectations|exceeded expectations|above consensus|better than expected/.test(lower)) return baseWeight > 0 ? 1 : -1;
  if (/slightly above/.test(lower)) return baseWeight > 0 ? 0.5 : -0.5;
  if (/in line/.test(lower)) return 0.1;
  return 1;
}

function inferredSurpriseLabel(text) {
  const lower = normalize(text);
  if (/below expectations|below consensus|missed expectations/.test(lower)) return 'below_expectations';
  if (/above expectations|above consensus|exceeded expectations/.test(lower)) return 'above_expectations';
  if (/in line/.test(lower)) return 'in_line';
  return null;
}

function timeDecayMultiplier(value) {
  if (!value) return 1;
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return 1;
  const ageDays = Math.max(0, (Date.now() - ts) / 86400000);
  if (ageDays <= 2) return 1;
  if (ageDays <= 14) return 0.85;
  if (ageDays <= 45) return 0.65;
  return 0.35;
}

function historicalAccuracyMultiplier(score) {
  if (!Number.isFinite(Number(score))) return 0.75;
  return clamp(Number(score) / 100, 0.35, 1.05);
}

function penaltiesForClause(text, document, novelty) {
  const lower = normalize(`${text} ${document.url || ''}`);
  const manipulationRisk = /(penny stock|pump|viral|anonymous|rumor|stock tip|guaranteed|short squeeze)/.test(lower) ? 0.8 : 0;
  const ambiguityPenalty = /(may|could|possible|unclear|uncertain|mixed)/.test(lower) ? 0.25 : 0;
  const contradictionPenalty = /(but|however|despite|although)/.test(lower) ? 0.3 : 0;
  const duplicatePenalty = novelty < 0.3 ? 0.4 : 0;
  const dataQualityPenalty = /(unverified|unaudited|preliminary|estimated)/.test(lower) ? 0.3 : 0;
  return {
    manipulation_risk: manipulationRisk,
    ambiguity_penalty: ambiguityPenalty,
    contradiction_penalty: contradictionPenalty,
    duplicate_penalty: duplicatePenalty,
    data_quality_penalty: dataQualityPenalty,
    total: round(manipulationRisk + ambiguityPenalty + contradictionPenalty + duplicatePenalty + dataQualityPenalty),
  };
}

function combinationEvents({ text, document, candidate, sourceReliability, companyRelevance, historicalSourceAccuracy }) {
  const lower = normalize(text);
  const events = [];
  for (const combo of POSITIVE_COMBINATIONS) {
    if (combo.pattern.every((phrase) => lower.includes(phrase))) {
      events.push(combinationEvent({ combo, document, candidate, score: combo.bonus, sourceReliability, companyRelevance, historicalSourceAccuracy }));
    }
  }
  for (const combo of NEGATIVE_COMBINATIONS) {
    if (combo.pattern.every((phrase) => lower.includes(phrase))) {
      events.push(combinationEvent({ combo, document, candidate, score: combo.penalty, sourceReliability, companyRelevance, historicalSourceAccuracy }));
    }
  }
  return events;
}

function combinationEvent({ combo, document, candidate, score, sourceReliability, companyRelevance, historicalSourceAccuracy }) {
  const finalScore = round(score * sourceReliability * companyRelevance * historicalSourceAccuracy);
  return {
    document_id: documentId(document),
    ticker: candidate.symbol || null,
    source: { domain: hostname(document.url), type: inferSourceType(document), reliability: sourceReliability },
    event: {
      category: score > 0 ? 'combination_positive' : 'combination_negative',
      type: combo.pattern.map(slugify).join('__'),
      base_weight: score,
      direction: score > 0 ? 'positive' : 'negative',
    },
    statement: { text: combo.pattern.join(' + '), subject: candidate.companyName || candidate.symbol || null, certainty: 'confirmed', time_horizon: 'mixed' },
    adjustments: { source_multiplier: sourceReliability, company_relevance: companyRelevance, historical_source_accuracy: historicalSourceAccuracy },
    penalties: { total: 0 },
    final_event_score: finalScore,
    evidence_urls: document.url ? [document.url] : [],
    contradictions: [],
    requires_human_review: false,
  };
}

function summarizeCategories(events) {
  const map = new Map();
  for (const event of events) {
    const key = event.event.category;
    map.set(key, round((map.get(key) || 0) + event.final_event_score));
  }
  return [...map.entries()]
    .map(([category, score]) => ({ category, score }))
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
    .slice(0, 12);
}

function mapCategory(label) {
  const lower = normalize(label).replace(/and/g, ' ');
  if (/earning/.test(lower)) return 'earnings';
  if (/revenue/.test(lower)) return 'revenue';
  if (/margin|cash flow|efficiency/.test(lower)) return lower.includes('cash') ? 'cash_flow' : 'margin';
  if (/balance|credit|debt|solvency/.test(lower)) return 'debt';
  if (/product|customer|competition|operation/.test(lower)) return 'product';
  if (/corporate action/.test(lower)) return 'capital_allocation';
  if (/legal|political/.test(lower)) return 'legal';
  if (/regulatory/.test(lower)) return 'regulatory';
  if (/macro|industry/.test(lower)) return 'macro';
  if (/accounting|governance/.test(lower)) return 'accounting';
  return EVENT_CATEGORIES.find((category) => lower.includes(category.replace('_', ' '))) || 'general';
}

function affectedMetric(entry) {
  if (/revenue|sales|bookings|backlog/.test(entry.term)) return 'revenue';
  if (/margin|cash flow|working capital|inventory/.test(entry.term)) return 'margin_cash_flow';
  if (/debt|liquidity|credit|covenant|default|bankruptcy/.test(entry.term)) return 'balance_sheet';
  if (/guidance|forecast|outlook/.test(entry.term)) return 'forecast';
  return entry.category;
}

function inferTimeHorizon(text) {
  const lower = normalize(text);
  if (/next year|fy ?\d{2,4}|full-year|full year|current fiscal year/.test(lower)) return 'current_fiscal_year';
  if (/long term|multi-year|through 20\d{2}/.test(lower)) return 'long_term';
  if (/quarter|q[1-4]/.test(lower)) return 'quarterly';
  if (/today|now|completed|reported/.test(lower)) return 'current';
  return 'unspecified';
}

function documentId(document) {
  return crypto.createHash('sha256').update(`${document.url || ''}|${document.title || ''}|${document.text || ''}`.slice(0, 4000)).digest('hex');
}

function hostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalize(value) {
  return cleanText(value).toLowerCase();
}

function slugify(value) {
  return normalize(value).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'event';
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function round(value) {
  return Math.round(Number(value || 0) * 10000) / 10000;
}

module.exports = {
  CERTAINTY_MULTIPLIERS,
  SOURCE_RELIABILITY,
  EVENT_CATEGORIES,
  loadWeightLexicon,
  scoreCandidateEvidence,
  scoreDocumentFinancialEvents,
};
