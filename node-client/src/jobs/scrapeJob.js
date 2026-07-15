const cheerio = require('cheerio');
const { normalizeLimitedStrings, isPublicHttpUrl, clampNumber } = require('./urlGuard');

async function fetchPage(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    const html = await response.text();
    const $ = cheerio.load(html);
    const title = $('title').first().text().trim() || url;
    const excerpt = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 500);
    return { ok: true, url, title, excerpt, statusCode: response.status };
  } finally {
    clearTimeout(timeout);
  }
}

async function runScrapeJob(request = {}) {
  const urls = normalizeLimitedStrings(request.urls || request.url, 6).filter(isPublicHttpUrl);
  const maxRuntimeMs = clampNumber(request.maxRuntimeMs, 10_000, 120_000, 45_000);
  const perPageTimeoutMs = Math.max(3_000, Math.min(20_000, Math.floor(maxRuntimeMs / Math.max(1, urls.length))));

  if (!urls.length) {
    return { ok: false, mode: 'crawl', queries: [], pageCount: 0, failureCount: 0, pages: [], failures: [] };
  }

  const pages = [];
  const failures = [];

  for (const url of urls) {
    try {
      const page = await fetchPage(url, perPageTimeoutMs);
      pages.push({ url: page.url, title: page.title, excerpt: page.excerpt });
    } catch (err) {
      failures.push({ url, error: err.message });
    }
  }

  return {
    ok: true,
    mode: 'crawl',
    queries: urls,
    pageCount: pages.length,
    failureCount: failures.length,
    discoveredCount: 0,
    entityLeadCount: 0,
    pages,
    failures,
    providerFallbacks: [],
  };
}

module.exports = { runScrapeJob };
