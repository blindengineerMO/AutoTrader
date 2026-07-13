const fs = require('fs');
const path = require('path');

const RESEARCH_DOC_PATH = path.join(__dirname, '..', '..', 'RESEARCH.md');

const QUERY_LINE_PATTERN = /"|site:|filetype:|inurl:|intitle:|before:|after:|\{company\}|\{ticker\}|\{industry\}|\{competitor\}|\{product\}|\{country\}|\{year\}|\{quarter\}|\{company_domain\}|when:\d/i;
const HEADING_PATTERN = /^[A-Z][A-Za-z0-9][A-Za-z0-9\s,'&-]*[A-Za-z0-9]$/;

function isQueryLine(line) {
  return QUERY_LINE_PATTERN.test(line);
}

function slugifyDimension(line) {
  return line
    .replace(/:$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function extractJsonBlocks(content) {
  const blocks = [];
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] !== '{') continue;
    let depth = 0;
    let end = -1;
    for (let j = i; j < content.length; j += 1) {
      if (content[j] === '{') depth += 1;
      else if (content[j] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end === -1) continue;
    const candidate = content.slice(i, end + 1);
    try {
      blocks.push(JSON.parse(candidate));
      i = end;
    } catch {
      // not valid JSON at this position; keep scanning from i + 1
    }
  }
  return blocks;
}

function parseQueryDimensions(content) {
  const dimensions = new Map();
  let currentSlug = 'general';
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (isQueryLine(line)) {
      if (!dimensions.has(currentSlug)) dimensions.set(currentSlug, []);
      dimensions.get(currentSlug).push(line);
      continue;
    }
    if (line.length <= 90 && HEADING_PATTERN.test(line.replace(/:$/, ''))) {
      currentSlug = slugifyDimension(line);
    }
  }
  for (const [slug, queries] of dimensions) {
    dimensions.set(slug, [...new Set(queries)]);
  }
  return dimensions;
}

function loadResearchCatalog() {
  let content = '';
  try {
    content = fs.readFileSync(RESEARCH_DOC_PATH, 'utf8');
  } catch {
    content = '';
  }
  return {
    dimensions: parseQueryDimensions(content),
    jsonSchemas: extractJsonBlocks(content),
  };
}

const CATALOG = loadResearchCatalog();

function getAllDimensions() {
  return [...CATALOG.dimensions.keys()].filter((slug) => slug !== 'general');
}

function getQueryTemplatesForDimension(dimension) {
  return CATALOG.dimensions.get(dimension) || [];
}

function findDimensionsByKeyword(keyword) {
  const needle = String(keyword || '').toLowerCase();
  if (!needle) return [];
  return getAllDimensions().filter((slug) => slug.includes(needle));
}

module.exports = {
  loadResearchCatalog,
  getAllDimensions,
  getQueryTemplatesForDimension,
  findDimensionsByKeyword,
};
