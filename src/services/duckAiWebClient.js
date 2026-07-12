const os = require('os');
const path = require('path');
const { config } = require('../config');

const DEFAULT_ALLOWED_HOSTS = new Set(['duck.ai', 'duckduckgo.com']);
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 AutoTraderDuckAI/1.0';

async function askDuckAiWeb({ payload, systemPrompt, options = {} }) {
  const session = new DuckAiWebSession(options);
  try {
    return await session.ask({ payload, systemPrompt });
  } finally {
    await session.close();
  }
}

class DuckAiWebSession {
  constructor(options = {}) {
    this.options = {
      publicUrl: options.publicUrl || config.duckAiResearch.publicUrl,
      headless: options.headless ?? config.duckAiResearch.browserHeadless,
      timeoutMs: options.timeoutMs || config.duckAiResearch.browserTimeoutMs,
      sessionDir: options.sessionDir || config.duckAiResearch.sessionDir || path.join(os.tmpdir(), 'autotrader-duck-ai-session'),
      userAgent: options.userAgent || DEFAULT_USER_AGENT,
      allowedHosts: new Set(options.allowedHosts || DEFAULT_ALLOWED_HOSTS),
      playwright: options.playwright || null,
    };
    this.context = null;
    this.page = null;
  }

  async ask({ payload, systemPrompt }) {
    const page = await this.openPage();
    await this.prepareWebApp(page);
    const prompt = buildDuckAiPrompt({ payload, systemPrompt });
    await submitPrompt(page, prompt, this.options.timeoutMs);
    const text = await waitForAssistantJson(page, this.options.timeoutMs);
    return JSON.parse(extractJsonObject(text));
  }

  async openPage() {
    if (this.page && !this.page.isClosed()) return this.page;
    const chromium = await getChromium(this.options.playwright);
    this.context = await chromium.launchPersistentContext(this.options.sessionDir, {
      headless: this.options.headless,
      viewport: { width: 1280, height: 900 },
      userAgent: this.options.userAgent,
    });
    await installNavigationGuard(this.context, this.options.allowedHosts);
    this.page = this.context.pages()[0] || await this.context.newPage();
    this.page.setDefaultTimeout(this.options.timeoutMs);
    this.page.setDefaultNavigationTimeout(this.options.timeoutMs);
    this.page.on('popup', async (popup) => popup.close().catch(() => {}));
    await this.page.goto(this.options.publicUrl, { waitUntil: 'domcontentloaded' });
    return this.page;
  }

  async prepareWebApp(page) {
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await acceptDuckAiIntro(page);
    await hideSidebarChrome(page);
    await resetConversation(page);
    await waitForChatInput(page, this.options.timeoutMs);
  }

  async close() {
    if (this.context) await this.context.close().catch(() => {});
    this.context = null;
    this.page = null;
  }
}

async function getChromium(injectedPlaywright) {
  if (injectedPlaywright?.chromium) return injectedPlaywright.chromium;
  try {
    return require('playwright').chromium;
  } catch {
    return require('@playwright/test').chromium;
  }
}

async function installNavigationGuard(context, allowedHosts) {
  await context.route('**/*', async (route) => {
    const request = route.request();
    if (!request.isNavigationRequest() || request.frame() !== request.frame().page().mainFrame()) {
      await route.continue().catch(() => {});
      return;
    }
    try {
      const url = new URL(request.url());
      if (url.protocol === 'about:' || allowedHosts.has(url.hostname)) {
        await route.continue();
        return;
      }
    } catch {
      // Fall through to abort invalid navigation.
    }
    await route.abort().catch(() => {});
  });
}

function buildDuckAiPrompt({ payload, systemPrompt }) {
  const body = JSON.stringify(payload).slice(0, 14000);
  return [
    systemPrompt,
    'Return only the JSON object. Do not include markdown fences, commentary, citations outside JSON, or prose before/after the JSON.',
    `Research payload:\n${body}`,
  ].filter(Boolean).join('\n\n');
}

async function acceptDuckAiIntro(page) {
  const buttons = [
    /agree/i,
    /accept/i,
    /continue/i,
    /get started/i,
    /start chatting/i,
    /start chat/i,
    /i understand/i,
    /got it/i,
  ];
  for (const pattern of buttons) {
    const button = page.getByRole('button', { name: pattern }).first();
    if (await button.count().catch(() => 0)) {
      await button.click().catch(() => {});
      await page.waitForTimeout(350).catch(() => {});
    }
  }
}

async function hideSidebarChrome(page) {
  await page.addStyleTag({
    content: `
      #sidemenu,
      #aichat-side-menu-button {
        display: none !important;
      }
    `,
  }).catch(() => {});
}

async function resetConversation(page) {
  const stopButton = page.getByRole('button', { name: /stop generating/i }).first();
  if (await stopButton.count().catch(() => 0)) {
    await stopButton.click().catch(() => {});
    await page.waitForTimeout(500).catch(() => {});
  }
  const newChatButton = page.getByRole('button', { name: /new chat/i }).first();
  if (await newChatButton.count().catch(() => 0)) {
    await newChatButton.click().catch(() => {});
    await page.waitForTimeout(500).catch(() => {});
  }
}

async function waitForChatInput(page, timeoutMs) {
  const input = await findChatInput(page, timeoutMs);
  await input.waitFor({ state: 'visible', timeout: timeoutMs });
  return input;
}

async function findChatInput(page, timeoutMs) {
  const candidates = [
    'textarea',
    '[contenteditable="true"]',
    '[role="textbox"]',
    'div[aria-multiline="true"]',
    'form textarea',
  ];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of candidates) {
      const locator = page.locator(selector).last();
      if (await locator.count().catch(() => 0)) {
        if (await locator.isVisible().catch(() => false)) return locator;
      }
    }
    await page.waitForTimeout(250).catch(() => {});
  }
  throw new Error('Duck.ai web session could not find a visible chat input');
}

async function submitPrompt(page, prompt, timeoutMs) {
  const input = await findChatInput(page, timeoutMs);
  await input.fill(prompt).catch(async () => {
    await input.click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
    await page.keyboard.insertText(prompt);
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await sendCurrentPrompt(page);
    await page.waitForTimeout(800).catch(() => {});
    const currentInputText = await readLocatorText(input);
    if (!currentInputText.includes(prompt.slice(0, 120))) return;
  }
  throw new Error('Duck.ai web session did not submit the prompt');
}

async function sendCurrentPrompt(page) {
  const sendSelectors = [
    'button[type="submit"]',
    'button[aria-label*="Send" i]',
    'button[title*="Send" i]',
    '[data-testid*="send" i]',
  ];
  for (const selector of sendSelectors) {
    const button = page.locator(selector).last();
    if (await button.count().catch(() => 0) && await button.isVisible().catch(() => false)) {
      await button.click().catch(() => {});
      break;
    }
  }
  await page.keyboard.press('Enter').catch(() => {});
  await page.keyboard.press('Control+Enter').catch(() => {});
}

async function waitForAssistantJson(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  let stableCount = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(900).catch(() => {});
    const text = await extractLikelyResponseText(page);
    const json = extractJsonObject(text);
    if (isResearchResultJson(json)) return json;
    if (text && text === last) stableCount += 1;
    else stableCount = 0;
    last = text || last;
    if (stableCount >= 4) {
      const stableJson = extractJsonObject(last);
      if (isResearchResultJson(stableJson)) return stableJson;
    }
  }
  const extracted = extractJsonObject(last);
  if (!isResearchResultJson(extracted)) throw new Error('Duck.ai web session did not return parseable JSON research output');
  return extracted;
}

async function extractLikelyResponseText(page) {
  const selectors = [
    '[data-testid*="message" i]',
    '[class*="message" i]',
    '[class*="assistant" i]',
    '[role="article"]',
    'main',
    'body',
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    if (!count) continue;
    const texts = [];
    const start = Math.max(0, count - 4);
    for (let i = start; i < count; i += 1) {
      const text = await locator.nth(i).innerText().catch(() => '');
      if (text && !text.includes('Research payload:')) texts.push(text);
    }
    const combined = texts.join('\n');
    if (combined.includes('{') && combined.includes('}')) return combined;
  }
  return page.evaluate(() => {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll('textarea,input,[contenteditable="true"],[role="textbox"],form').forEach((node) => node.remove());
    return clone.innerText || '';
  }).catch(() => '');
}

async function readLocatorText(locator) {
  const value = await locator.inputValue().catch(() => '');
  if (value) return value;
  return locator.innerText().catch(() => '');
}

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  if (raw.startsWith('{') && raw.endsWith('}')) return raw;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return '{}';
  return raw.slice(start, end + 1);
}

function isResearchResultJson(text) {
  const raw = String(text || '');
  if (raw === '{}') return false;
  if (!raw.includes('{') || !raw.includes('}')) return false;
  try {
    const parsed = JSON.parse(raw);
    return Boolean(
      Object.prototype.hasOwnProperty.call(parsed, 'summary')
      || Object.prototype.hasOwnProperty.call(parsed, 'candidateHints')
      || Object.prototype.hasOwnProperty.call(parsed, 'sourceHints')
      || Object.prototype.hasOwnProperty.call(parsed, 'riskNotes')
    );
  } catch {
    return false;
  }
}

module.exports = {
  DuckAiWebSession,
  askDuckAiWeb,
  buildDuckAiPrompt,
  extractJsonObject,
  isResearchResultJson,
  DEFAULT_ALLOWED_HOSTS,
};
