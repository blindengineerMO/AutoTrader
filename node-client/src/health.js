const os = require('os');

async function detectOllamaModels() {
  try {
    const response = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return [];
    const data = await response.json();
    return (data.models || []).map((model) => model.name);
  } catch {
    return [];
  }
}

function cpuPercent() {
  const cores = os.cpus().length || 1;
  return Math.min(100, Math.round((os.loadavg()[0] / cores) * 100));
}

function ramStats() {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = totalBytes - freeBytes;
  return {
    totalMb: Math.round(totalBytes / 1024 / 1024),
    usedMb: Math.round(usedBytes / 1024 / 1024),
    percent: Math.round((usedBytes / totalBytes) * 100),
  };
}

async function collectHealth() {
  const ollamaModels = await detectOllamaModels();
  return {
    cpuCores: os.cpus().length,
    cpuPercent: cpuPercent(),
    ram: ramStats(),
    uptimeSec: Math.round(process.uptime()),
    features: ollamaModels.length ? ['ollama'] : [],
    ollamaModels,
    collectedAt: new Date().toISOString(),
  };
}

module.exports = { collectHealth, detectOllamaModels };
