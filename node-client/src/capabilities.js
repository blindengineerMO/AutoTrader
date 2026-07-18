const os = require('os');
const { detectOllamaModels } = require('./health');

async function detectResources() {
  const ollamaModels = await detectOllamaModels();
  return {
    cpuCores: os.cpus().length,
    ollamaModels,
  };
}

function detectCapabilities(resources) {
  // Advertises the full discovery-crawl engine (crawler.crawl + crawler.search);
  // ollamaModels/cpuCores are still reported as resources for future job types
  // (LLM inference) per the plan's roadmap.
  const maxConcurrency = Math.max(1, Math.min(4, resources.cpuCores));
  return [
    { op: 'crawler.crawl', maxConcurrency },
    { op: 'crawler.search', maxConcurrency },
  ];
}

module.exports = { detectResources, detectCapabilities };
