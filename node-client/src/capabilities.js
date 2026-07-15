const os = require('os');

async function detectOllama() {
  try {
    const response = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return [];
    const data = await response.json();
    return (data.models || []).map((model) => model.name);
  } catch {
    return [];
  }
}

async function detectResources() {
  const ollamaModels = await detectOllama();
  return {
    cpuCores: os.cpus().length,
    ollamaModels,
  };
}

function detectCapabilities(resources) {
  // v1 only advertises scraping; ollamaModels/cpuCores are reported as
  // resources for future job types (LLM inference) per the plan's roadmap.
  return [{ op: 'crawler.crawl', maxConcurrency: Math.max(1, Math.min(4, resources.cpuCores)) }];
}

module.exports = { detectResources, detectCapabilities };
