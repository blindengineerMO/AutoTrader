const crypto = require('crypto');
const providerCredentialRepo = require('../db/repositories/providerCredentialRepo');
const researchSourceRepo = require('../db/repositories/researchSourceRepo');
const finnhub = require('./marketData/finnhubClient');
const alpacaAssetClient = require('./marketData/alpacaAssetClient');
const crawler = require('./crawleeResearchCrawlerService');
const companyDiscovery = require('./companyDiscoveryService');
const brainMesh = require('./brainMeshService');
const { config } = require('../config');

const runs = new Map();

function startAgentResearchRun({ userId, name, createAgent }) {
  const cleanName = cleanText(name);
  if (!cleanName) throw new Error('Agent name is required');
  const run = {
    id: `ar_${crypto.randomBytes(8).toString('hex')}`,
    userId,
    name: cleanName,
    status: 'queued',
    phase: 'queued',
    progress: 0,
    terminal: [],
    agent: null,
    error: null,
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  runs.set(run.id, run);
  setImmediate(() => executeRun(run.id, createAgent));
  return publicRun(run);
}

function getAgentResearchRun(userId, id) {
  const run = runs.get(id);
  if (!run || run.userId !== userId) return null;
  return publicRun(run);
}

async function executeRun(runId, createAgent) {
  const run = runs.get(runId);
  if (!run) return;
  const conversation = brainMesh.startConversation({
    userId: run.userId,
    topic: `agent-research:${run.name}`,
    metadata: { agentResearchRunId: run.id, agentName: run.name },
  });
  const onEvent = (event) => append(run, event);

  try {
    setRun(run, { status: 'running', phase: 'research-questions', progress: 5 });
    append(run, {
      phase: 'research-questions',
      progress: 5,
      level: 'info',
      message: `Building autonomous investment-personality research questions for ${run.name}.`,
      data: { questions: buildResearchQuestions(run.name) },
    });
    brainMesh.tell({
      from: 'agent.research.builder',
      to: ['brain.research.source', 'brain.discovery.company', 'brain.intelligence.company'],
      kind: 'event',
      op: 'agent.research.started',
      ctx: { userId: run.userId, agentResearchRunId: run.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: { name: run.name, questions: buildResearchQuestions(run.name) },
    });

    setRun(run, { phase: 'crawlee-agent-profile', progress: 12 });
    const crawl = await crawler.crawlAutonomousResearch({
      queries: buildResearchQuestions(run.name),
      maxRequests: 180,
      maxFollowUps: 28,
      minContinuationScore: 1.45,
      maxWaves: 10,
      maxSearchExpansions: 72,
      maxRuntimeMs: 8 * 60 * 1000,
      onEvent,
    });

    setRun(run, { phase: 'profile-extraction', progress: 58 });
    append(run, {
      phase: 'profile-extraction',
      progress: 58,
      level: 'debug',
      message: 'Parsing crawled pages for investment style, ownership, deals, source URLs, and public-company clues.',
      data: { pages: crawl.pages.length, failures: crawl.failures.length },
    });

    const sourceUrls = learnAgentSources(run.userId, run.name, crawl.pages);
    const discovered = discoverInvestmentCompanies(crawl.pages, crawl.entityLeads || []);
    const finnhubResearch = await enrichCompaniesWithFinnhub({
      userId: run.userId,
      name: run.name,
      companies: discovered,
      onEvent,
    });
    const enrichedSymbols = new Set(finnhubResearch.map((item) => item.symbol));
    const eligibleDiscovered = discovered.filter((item) => enrichedSymbols.has(item.symbol));
    const profile = buildProfileFromResearch({ name: run.name, pages: crawl.pages, sourceUrls, discovered: eligibleDiscovered, finnhubResearch });

    setRun(run, { phase: 'agent-profile-save', progress: 88 });
    append(run, {
      phase: 'agent-profile-save',
      progress: 88,
      level: 'info',
      message: 'Saving researched agent profile, metadata, sources, and company opportunity map.',
      data: {
        sourceUrls: sourceUrls.length,
        companies: eligibleDiscovered.map((item) => item.symbol).slice(0, 12),
        finnhubCompanies: finnhubResearch.filter((item) => item.available).length,
      },
    });

    const agent = createAgent(run.userId, profile);
    brainMesh.tell({
      from: agent.brain_id,
      to: ['agent.research.builder', 'agent.council.moderator', 'brain.reporting'],
      kind: 'event',
      op: 'agent.profile.ready',
      ctx: { userId: run.userId, agentResearchRunId: run.id, agentId: agent.id },
      conv: conversation.id,
      trace: conversation.metadata.trace,
      body: {
        agentId: agent.id,
        name: agent.name,
        sourceUrls: agent.sourceUrls,
        watchSymbols: agent.bias?.watchSymbols || [],
        opportunityMap: profile.model?.opportunityMap || [],
      },
    });

    setRun(run, {
      status: 'complete',
      phase: 'complete',
      progress: 100,
      agent,
      updated_at: new Date().toISOString(),
    });
    append(run, {
      phase: 'complete',
      progress: 100,
      level: 'info',
      message: `Agent ${agent.name} is ready with ${agent.sourceUrls.length} source URLs and ${(agent.bias?.watchSymbols || []).length} watch symbols.`,
      data: { agentId: agent.id, workspace: agent.workspace },
    });
    brainMesh.completeConversation(conversation.id, run.userId, {
      completedBy: agent.brain_id,
      completedOp: 'agent.profile.ready',
      completedAt: new Date().toISOString(),
      agentId: agent.id,
      agentResearchRunId: run.id,
    });
  } catch (err) {
    setRun(run, { status: 'failed', phase: 'failed', error: err.message, progress: 100 });
    append(run, {
      phase: 'failed',
      progress: 100,
      level: 'error',
      message: 'Agent research run failed.',
      data: { error: err.message },
    });
  }
}

function buildResearchQuestions(name) {
  return [
    `How did ${name} do in investments last year`,
    `What companies does ${name} invest in`,
    `What companies does ${name} have ownership in`,
    `What was the highest value deal completed by ${name}`,
    `stock ticker information for companies ${name} bought in the last year`,
    `What companies is ${name} losing faith in`,
    `What companies did ${name} trade recently`,
    `Did ${name} buy or sell any stocks recently`,
    `What news has ${name} been involved in`,
    `What is ${name} net worth`,
    `${name} recent stock purchases sales disclosures`,
    `${name} recent portfolio changes public filings`,
    `${name} portfolio holdings public companies SEC filings`,
    `${name} investment strategy acquisitions ownership stakes`,
    `${name} recent deals startups public market exposure`,
    `${name} best investment returns company stock`,
    `${name} business interests subsidiaries publicly traded companies`,
    `${name} venture investments IPO companies ticker`,
    `${name} 13F holdings stock purchases last year`,
  ];
}

function learnAgentSources(userId, name, pages) {
  const sources = pages
    .sort((a, b) => (b.score?.relevance || 0) - (a.score?.relevance || 0))
    .slice(0, 28)
    .map((page) => page.url)
    .filter(Boolean);
  for (const page of pages.slice(0, 28)) {
    researchSourceRepo.upsert({
      userId,
      url: page.url,
      title: page.title || `${name} agent source`,
      sourceType: 'learned',
      discoveryMethod: `agent-research:${slugify(name)}`,
      tags: ['agent-research', slugify(name), ...(page.score?.tags || [])].slice(0, 8),
      relevanceScore: Math.min(95, 55 + (page.score?.relevance || 0) * 4),
      credibilityScore: 55,
      notes: `Autonomous agent profile source for ${name}.`,
    });
  }
  return [...new Set(sources)].slice(0, 20);
}

function discoverInvestmentCompanies(pages, entityLeads = []) {
  const observations = pages.map((page) => ({
    url: page.url,
    title: page.title,
    excerpt: page.excerpt,
    links: page.links || [],
  }));
  const known = companyDiscovery.discoverCompanies({
    news: { items: pages.map((page) => ({ title: page.title, description: page.excerpt, url: page.url })) },
    learned: { observations },
    maxCandidates: 24,
  });
  const loose = extractLooseTickers(pages);
  const merged = new Map();
  const entityCandidates = entityLeads
    .filter((lead) => lead.symbol)
    .map((lead) => ({
      symbol: lead.symbol,
      companyName: lead.name || lead.symbol,
      theme: 'agent-crawled-entity',
      themeHits: Math.max(2.5, lead.score || 0),
      evidence: (lead.evidence || []).map((item) => item.reason).slice(0, 6),
      discovery: {
        method: 'agent-crawled-entity-lead',
        tags: ['agent-research', lead.type || 'entity'],
        evidence: (lead.evidence || []).slice(0, 6),
      },
    }));
  for (const item of [...known, ...loose, ...entityCandidates]) {
    const existing = merged.get(item.symbol) || item;
    existing.themeHits = Math.max(existing.themeHits || 0, item.themeHits || 0);
    existing.evidence = [...(existing.evidence || []), ...(item.evidence || [])].slice(0, 6);
    existing.discovery = existing.discovery || item.discovery;
    merged.set(item.symbol, existing);
  }
  return [...merged.values()].sort((a, b) => (b.themeHits || 0) - (a.themeHits || 0)).slice(0, 18);
}

function extractLooseTickers(pages) {
  const blacklist = new Set(['CEO', 'CFO', 'SEC', 'IPO', 'ETF', 'USA', 'USD', 'AI', 'EV']);
  const candidates = new Map();
  for (const page of pages) {
    const text = `${page.title || ''} ${page.excerpt || ''}`;
    const patterns = [/\$([A-Z]{1,5})\b/g, /\b(?:NASDAQ|NYSE|NYSEARCA|AMEX)\s*[: ]\s*([A-Z]{1,5})\b/g, /\(([A-Z]{1,5})\)/g];
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const symbol = match[1];
        if (blacklist.has(symbol)) continue;
        const item = candidates.get(symbol) || {
          symbol,
          companyName: symbol,
          theme: 'agent-crawled-ticker',
          themeHits: 0,
          evidence: [],
          discovery: { method: 'agent-loose-ticker-extraction', tags: ['agent-research'], evidence: [] },
        };
        item.themeHits += 2.5;
        const evidence = { title: page.title, url: page.url, reason: `Agent research page included direct ticker ${symbol}.` };
        item.evidence.push(evidence.reason);
        item.discovery.evidence.push(evidence);
        candidates.set(symbol, item);
      }
    }
  }
  return [...candidates.values()];
}

async function enrichCompaniesWithFinnhub({ userId, name, companies, onEvent }) {
  const { kept, excluded } = await alpacaAssetClient.filterCandidates(companies, {
    userId,
    source: `agent-profile-research:${slugify(name)}`,
  });
  if (excluded.length) {
    appendEvent(onEvent, 'alpaca-agent-eligibility', 68, 'warn', 'Excluded agent-discovered symbols that Alpaca does not report as tradable.', {
      excluded: excluded.slice(0, 10).map((item) => ({
        symbol: item.symbol,
        companyName: item.companyName,
        reason: item.alpacaEligibility?.reason,
      })),
    });
  }
  const credentials = userId ? providerCredentialRepo.getSecret(userId, 'finnhub') : null;
  const apiKey = credentials?.apiKey || config.finnhubApiKey;
  if (!apiKey) {
    appendEvent(onEvent, 'finnhub-agent-research', 70, 'warn', 'Finnhub credentials unavailable; agent company expansion will rely on crawled evidence only.', {
      companies: kept.map((item) => item.symbol).slice(0, 10),
    });
    return kept.slice(0, 10).map((item) => ({ symbol: item.symbol, available: false }));
  }

  const researched = [];
  for (const company of kept.slice(0, 10)) {
    appendEvent(onEvent, 'finnhub-agent-research', 70, 'debug', `Researching ${company.symbol} through Finnhub for ${name}.`, {
      symbol: company.symbol,
      companyName: company.companyName,
    });
    researched.push(await finnhub.researchCompany(company.symbol, { apiKey }));
  }
  return researched;
}

function buildProfileFromResearch({ name, pages, sourceUrls, discovered, finnhubResearch }) {
  const keywords = inferPersonalityKeywords(pages);
  const watchSymbols = [...new Set([
    ...discovered.map((item) => item.symbol),
    ...finnhubResearch.filter((item) => item.profile?.ticker).map((item) => item.profile.ticker),
  ])].slice(0, 18);
  const opportunityMap = discovered.slice(0, 12).map((company) => {
    const fh = finnhubResearch.find((item) => item.symbol === company.symbol) || {};
    return {
      symbol: company.symbol,
      companyName: fh.profile?.name || company.companyName,
      reason: company.discovery?.evidence?.[0]?.reason || company.evidence?.[0] || 'Discovered during agent profile research.',
      sourceUrl: company.discovery?.evidence?.[0]?.url,
      price: fh.quote?.current || null,
      marketCapitalization: fh.profile?.marketCapitalization || null,
      peNormalizedAnnual: fh.metrics?.metric?.peNormalizedAnnual || null,
      recommendation: fh.recommendations?.[0] || null,
      recentNews: (fh.news || []).slice(0, 3).map((item) => ({ headline: item.headline, url: item.url, datetime: item.datetime })),
    };
  });
  return {
    name,
    slug: slugify(name),
    archetype: keywords.includes('real estate') ? 'web-researched-deal-and-asset-agent' : 'web-researched-investment-personality-agent',
    summary: buildSummary(name, pages, watchSymbols, keywords),
    style: keywords.slice(0, 6),
    sourceUrls,
    bias: {
      sectors: inferSectorBias(pages),
      factors: {
        evidenceQuality: 0.24,
        ownershipSignal: 0.18,
        dealHistory: 0.16,
        momentum: 0.10,
        liquidity: 0.08,
        volatilityPenalty: 0.06,
      },
      watchSymbols: watchSymbols.length ? watchSymbols : ['SPY', 'QQQ'],
    },
    model: {
      modelType: 'agent-web-crawled-personality-v1',
      createdAt: new Date().toISOString(),
      promptSeed: `${name} ${keywords.join(' ')}`,
      researchQuestions: buildResearchQuestions(name),
      crawledPageCount: pages.length,
      opportunityMap,
      finnhubEndpointSet: ['search', 'quote', 'profile2', 'stock/metric', 'company-news', 'stock/recommendation'],
    },
  };
}

function inferPersonalityKeywords(pages) {
  const text = pages.map((page) => `${page.title} ${page.excerpt}`).join(' ').toLowerCase();
  const terms = [
    'technology',
    'software',
    'ai',
    'cloud',
    'real estate',
    'media',
    'energy',
    'defense',
    'consumer',
    'healthcare',
    'venture',
    'private equity',
    'acquisition',
    'ownership',
    'long-term',
    'growth',
    'value',
    'policy',
    'infrastructure',
    'space',
  ];
  const matches = terms.filter((term) => text.includes(term)).slice(0, 8);
  return matches.length ? matches : ['evidence-seeking', 'adaptive', 'deal-aware'];
}

function inferSectorBias(pages) {
  const keywords = inferPersonalityKeywords(pages);
  const bias = {};
  for (const keyword of keywords) {
    const normalized = keyword.replace(/\s+/g, '');
    bias[normalized] = normalized === 'ownership' || normalized === 'acquisition' ? 0.10 : 0.14;
  }
  return Object.keys(bias).length ? bias : { software: 0.08, financials: 0.06, consumer: 0.04 };
}

function buildSummary(name, pages, watchSymbols, keywords) {
  const topSources = pages.slice(0, 3).map((page) => page.title).filter(Boolean);
  return `${name} agent profile generated from autonomous Crawlee research across ${pages.length} pages. The model emphasizes ${keywords.slice(0, 5).join(', ')} and watches ${watchSymbols.slice(0, 8).join(', ') || 'broad-market proxies'}. Top research inputs: ${topSources.join('; ') || 'search-derived sources'}.`;
}

function append(run, event) {
  run.terminal.push({
    ts: new Date().toISOString(),
    phase: event.phase || run.phase,
    progress: Number(event.progress ?? run.progress ?? 0),
    level: event.level || 'debug',
    message: event.message || '',
    data: event.data || null,
  });
  if (event.progress !== undefined) run.progress = Math.max(run.progress, Math.min(99, Number(event.progress) || run.progress));
  if (event.phase) run.phase = event.phase;
  run.updated_at = new Date().toISOString();
}

function appendEvent(onEvent, phase, progress, level, message, data) {
  onEvent({ phase, progress, level, message, data });
}

function setRun(run, patch) {
  Object.assign(run, patch, { updated_at: new Date().toISOString() });
}

function publicRun(run) {
  return { ...run, terminal: run.terminal.slice(-300) };
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function slugify(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent';
}

module.exports = {
  startAgentResearchRun,
  getAgentResearchRun,
  buildResearchQuestions,
  buildProfileFromResearch,
};
