<template>
  <div class="home-page" :style="{ '--home-hero-image': `url(${heroImage})` }">
    <div class="home-aurora" aria-hidden="true"></div>
    <div class="home-particles" aria-hidden="true">
      <span v-for="particle in particles" :key="particle" :style="{ '--i': particle }"></span>
    </div>

    <header class="home-nav liquid-glass">
      <router-link to="/" class="home-brand">
        <span class="home-brand-mark"><v-icon icon="mdi-hexagon-multiple-outline" size="22" /></span>
        <span>AUTOTRADER</span>
      </router-link>
      <nav class="home-nav-links" aria-label="Homepage navigation">
        <a href="#platform">Product</a>
        <a href="#intelligence">Research AI</a>
        <a href="#pricing">Pricing</a>
        <a href="#faq">FAQ</a>
      </nav>
      <div class="home-nav-actions">
        <router-link to="/login" class="home-login">Log in</router-link>
        <router-link to="/login" class="home-signup">Sign up</router-link>
      </div>
    </header>

    <main>
      <section class="home-hero">
        <div class="home-hero-center">
          <p class="home-kicker">Autonomous investment command layer</p>
          <h1>Research, agents, and AI trading decisions in one liquid workspace.</h1>
          <router-link to="/login" class="home-cta">
            <span>Get AutoTrader</span>
            <strong><v-icon icon="mdi-arrow-right" size="28" /></strong>
          </router-link>
        </div>

        <div class="hero-stage" aria-label="AutoTrader product preview">
          <article class="float-panel float-research liquid-glass">
            <v-icon icon="mdi-hexagon-multiple-outline" size="24" />
            <p>
              The research desk found <strong>{{ topBuy?.symbol || 'a live candidate' }}</strong> after cross-checking
              <span>{{ topBuy?.sourceCount || 'many' }} sources</span>. Want the council to debate the plan?
            </p>
            <div class="time-row">
              <button>run council</button>
              <button>simulate first</button>
            </div>
            <div class="prompt-row">
              <span>show the decision trail</span>
              <v-icon icon="mdi-arrow-up-circle" size="22" />
            </div>
          </article>

          <aside class="float-rail liquid-glass" aria-hidden="true">
            <v-icon icon="mdi-radar" />
            <v-icon icon="mdi-account-group" />
            <v-icon icon="mdi-chart-timeline-variant" />
            <v-icon icon="mdi-file-document-check" />
            <v-icon icon="mdi-calendar-clock" />
          </aside>

          <div class="float-pill float-proofread liquid-glass">
            <v-icon icon="mdi-brain" size="22" />
            <span>Cross-source agreement required before buy/sell</span>
          </div>

          <article class="float-panel float-report liquid-glass">
            <div class="panel-top">
              <span><v-icon icon="mdi-home-analytics" size="18" /> Decision workspace</span>
              <span>Share <v-icon icon="mdi-cog-outline" size="17" /></span>
            </div>
            <h2>{{ topBuy?.symbol || 'SCAN' }} investment thesis</h2>
            <p>
              {{ signalMessage }}
              <mark>Score {{ topBuy?.score ?? '--' }}</mark>
              with mode <mark>{{ topBuy?.reportMode || 'watch' }}</mark>. The report keeps source URLs,
              agent arguments, simulation status, and order guardrails attached.
            </p>
            <div class="editor-bar">
              <v-icon icon="mdi-format-bold" />
              <v-icon icon="mdi-format-italic" />
              <v-icon icon="mdi-format-underline" />
              <v-icon icon="mdi-format-list-bulleted" />
              <v-icon icon="mdi-chevron-down" />
            </div>
          </article>

          <article class="float-panel float-inbox liquid-glass">
            <div class="inbox-tabs">
              <v-icon icon="mdi-menu" size="24" />
              <span>Important 12</span>
              <span>Reports 13</span>
              <span>Agents 8</span>
              <span>Other 19</span>
            </div>
            <div v-for="row in inboxRows" :key="row.name" class="inbox-row">
              <strong>{{ row.name }}</strong>
              <span>{{ row.subject }}</span>
              <small>{{ row.detail }}</small>
            </div>
          </article>

          <div class="float-toast liquid-glass">
            <v-icon icon="mdi-auto-fix" size="24" />
            <span>Schedule a simulation board meeting for market open</span>
          </div>

          <aside class="float-top-buy liquid-glass" aria-label="Current AI buy choice">
            <div>
              <span>{{ pickLabel }}</span>
              <strong>{{ signalStatus }}</strong>
            </div>
            <h2>{{ topBuy?.symbol || 'SCAN' }}</h2>
            <p>{{ signalMessage }}</p>
          </aside>
        </div>
      </section>

      <section id="platform" class="home-section liquid-section">
        <p class="home-kicker">Built like an operator cockpit</p>
        <h2>Every surface feels light, but the trading workflow stays traceable.</h2>
        <div class="feature-grid">
          <article v-for="card in featureCards" :key="card.title" class="feature-card liquid-glass">
            <v-icon :icon="card.icon" size="23" />
            <h3>{{ card.title }}</h3>
            <p>{{ card.copy }}</p>
          </article>
        </div>
      </section>

      <section id="intelligence" class="signal-strip liquid-glass">
        <div>
          <p class="home-kicker">Signal pipeline</p>
          <h2>From public data to ranked action.</h2>
        </div>
        <div class="home-steps">
          <button
            v-for="step in steps"
            :key="step.id"
            type="button"
            class="pipeline-step"
            :class="{ active: activeStepId === step.id }"
            :aria-pressed="activeStepId === step.id"
            @click="activeStepId = step.id"
          >
            <v-icon :icon="step.icon" size="18" />
            <span>{{ step.label }}</span>
          </button>
        </div>
      </section>

      <Teleport to="body">
        <div
          v-if="activeStep"
          class="step-window-layer"
          role="presentation"
          @click.self="activeStepId = null"
        >
          <article
            class="step-detail-window liquid-glass"
            role="dialog"
            aria-modal="false"
            :aria-labelledby="`step-detail-title-${activeStep.id}`"
          >
            <header>
              <span>
                <v-icon :icon="activeStep.icon" size="22" />
                {{ activeStep.eyebrow }}
              </span>
              <button type="button" aria-label="Close pipeline detail" @click="activeStepId = null">
                <v-icon icon="mdi-close" size="18" />
              </button>
            </header>
            <h3 :id="`step-detail-title-${activeStep.id}`">{{ activeStep.title }}</h3>
            <p>{{ activeStep.detail }}</p>
          </article>
        </div>
      </Teleport>

      <section id="pricing" class="pricing-band">
        <div>
          <p class="home-kicker">Launch pricing</p>
          <h2>One operator subscription. Research, simulation, reports, and AI council included.</h2>
        </div>
        <div class="price-bubble liquid-glass">
          <span>Operator seat</span>
          <strong>$49.99</strong>
          <small>/month</small>
          <router-link to="/login" class="home-cta mini">
            <span>Start from sign in</span>
            <strong><v-icon icon="mdi-arrow-right" size="20" /></strong>
          </router-link>
        </div>
      </section>

      <section id="faq" class="faq-section">
        <p class="home-kicker">FAQ</p>
        <h2>Confidence without mystery.</h2>
        <div class="faq-grid">
          <button
            v-for="(item, index) in faqs"
            :key="item.question"
            type="button"
            class="faq-card liquid-glass"
            :class="{ open: activeFaq === index }"
            @click="activeFaq = activeFaq === index ? null : index"
          >
            <span>
              <strong>{{ item.question }}</strong>
              <v-icon :icon="activeFaq === index ? 'mdi-minus' : 'mdi-plus'" size="17" />
            </span>
            <p>{{ item.answer }}</p>
          </button>
        </div>
      </section>
    </main>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import heroImage from '../assets/home-ai-trading-hero.png';

const particles = Array.from({ length: 24 }, (_, index) => index + 1);
const activeFaq = ref(0);
const activeStepId = ref(null);
const signal = ref({ status: 'loading', topBuy: null, message: 'Loading latest AI buy candidate.' });

const inboxRows = [
  { name: 'Council', subject: 'Top buy thesis updated', detail: 'Cross-source report is ready' },
  { name: 'Research', subject: 'Macro risk detected', detail: 'Energy and logistics weighted' },
  { name: 'Ledger', subject: 'Simulation P&L changed', detail: 'Portfolio mark reviewed' },
  { name: 'Agents', subject: 'Board consensus posted', detail: 'Five agent arguments saved' },
];

const featureCards = [
  {
    title: 'Autonomous research desk',
    icon: 'mdi-radar',
    copy: 'Crawls news, SEC filings, macro data, demand proxies, recalls, energy, weather, and learned sources.',
  },
  {
    title: 'Agent council',
    icon: 'mdi-account-group',
    copy: 'Personality-based agents debate over BMCL and preserve the reasoning trail behind each recommendation.',
  },
  {
    title: 'Simulation first',
    icon: 'mdi-chart-timeline-variant',
    copy: 'Paper positions, cash, ledgers, funding events, P&L, and daily evaluations behave like live operations.',
  },
  {
    title: 'Execution guardrails',
    icon: 'mdi-shield-check',
    copy: 'Trading hours, kill switches, Alpaca rules, fractionable assets, and cross-source agreement protect actions.',
  },
];

const steps = [
  {
    id: 'discover',
    label: 'Discover',
    eyebrow: 'Signal discovery',
    title: 'The system turns public noise into candidates.',
    icon: 'mdi-radar',
    detail: 'AutoTrader starts with broad business, macro, regulatory, product, consumer-demand, and market searches. It blends learned sources with live discovery so new companies, new products, filings, funding rounds, recalls, and unusual momentum can become research candidates instead of relying on a fixed watchlist.',
  },
  {
    id: 'crawl',
    label: 'Crawl',
    eyebrow: 'Autonomous crawling',
    title: 'Crawlers follow evidence until value fades.',
    icon: 'mdi-web',
    detail: 'The research engine uses resilient web crawling, source memory, search-provider fallback, and relevance scoring to read articles, official data, filings, and linked references. Useful URLs are retained, weak or failed sources are tracked, and relevant company or location clues trigger deeper crawls.',
  },
  {
    id: 'score',
    label: 'Score',
    eyebrow: 'Candidate scoring',
    title: 'Signals become weighted buy and sell scores.',
    icon: 'mdi-chart-timeline-variant',
    detail: 'Each candidate is scored from cross-source agreement, market data, macro pressure, sector trends, company history, location exposure, liquidity, valuation, owned-position impact, and risk controls. The score is not a shortcut to trading; it decides what deserves deeper board evaluation.',
  },
  {
    id: 'debate',
    label: 'Debate',
    eyebrow: 'Agent council',
    title: 'Agents argue the thesis before action.',
    icon: 'mdi-account-group',
    detail: 'Personality agents use BMCL to challenge each other, request more evidence, compare owned positions, and surface disagreement before a recommendation is accepted. The board process preserves who supported or challenged the idea and why the final consensus did or did not move forward.',
  },
  {
    id: 'simulate',
    label: 'Simulate',
    eyebrow: 'Paper execution',
    title: 'Plans can run safely before live trading.',
    icon: 'mdi-play-circle-outline',
    detail: 'Simulation mode treats paper capital like real capital: cash, positions, GL entries, daily funding rules, P&L, and end-of-day evaluation are tracked as if the system were live. That lets operators see how the AI behaves over time without moving real money.',
  },
  {
    id: 'report',
    label: 'Report',
    eyebrow: 'Decision reports',
    title: 'Every decision keeps its trail.',
    icon: 'mdi-file-document-check-outline',
    detail: 'Decision reports summarize the sources, evidence, rankings, agent debate, risk checks, portfolio context, and final action status. The goal is traceability: operators can see why AutoTrader bought, held, sold, rejected, or only simulated a recommendation.',
  },
];
const faqs = [
  {
    question: 'Does AutoTrader place trades automatically?',
    answer: 'It can operate in simulation or live mode depending on broker readiness, trading hours, kill switches, and account settings.',
  },
  {
    question: 'Can I see why the AI made a choice?',
    answer: 'Yes. Decision reports retain source evidence, agent arguments, ranking inputs, owned-position review, and final action status.',
  },
  {
    question: 'What happens without live broker credentials?',
    answer: 'The system keeps researching, debating, simulating, and recording paper P&L without moving live money.',
  },
  {
    question: 'Is the public buy pick financial advice?',
    answer: 'No. The homepage pick is a sanitized product preview. Operators must review reports and controls inside the app.',
  },
];

const topBuy = computed(() => signal.value.topBuy);
const signalStatus = computed(() => signal.value.status === 'current' ? 'live' : signal.value.status === 'last' ? 'last' : 'scan');
const pickLabel = computed(() => signal.value.status === 'current' ? 'current top buy' : signal.value.status === 'last' ? 'last top buy' : 'AI watch');
const signalMessage = computed(() => signal.value.message || 'AI council is scanning for the next high-conviction buy candidate.');
const activeStep = computed(() => steps.find((step) => step.id === activeStepId.value));

onMounted(async () => {
  try {
    const response = await fetch('/api/public/home-signal');
    if (!response.ok) throw new Error('Signal unavailable');
    signal.value = await response.json();
  } catch {
    signal.value = {
      status: 'scanning',
      topBuy: null,
      message: 'AI council is scanning for the next high-conviction buy candidate.',
    };
  }
});
</script>

<style scoped>
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght,SOFT,WONK@9..144,300..800,40..100,0..1&family=Inter:wght@400;500;600;700;800;900&display=swap');

.home-page {
  --display-font: 'Fraunces', 'Cormorant Garamond', Georgia, serif;
  --body-font: 'Inter', 'DM Sans', system-ui, sans-serif;
  --ink: #f7f8ff;
  --muted: rgba(247, 248, 255, 0.76);
  --soft: rgba(247, 248, 255, 0.58);
  --glass: rgba(115, 131, 190, 0.34);
  --glass-strong: rgba(127, 139, 200, 0.48);
  --line: rgba(255, 255, 255, 0.25);
  --violet: #dac8ff;
  --blue: #87b8ff;
  --plum: #a34eff;
  position: relative;
  min-height: 100vh;
  overflow-x: hidden;
  color: var(--ink);
  font-family: var(--body-font);
  background:
    linear-gradient(180deg, rgba(77, 109, 167, 0.50), rgba(8, 12, 28, 0.88) 66%, #050914),
    linear-gradient(90deg, rgba(46, 68, 122, 0.76), rgba(120, 151, 215, 0.35) 48%, rgba(45, 38, 89, 0.70)),
    var(--home-hero-image) top center / cover no-repeat fixed;
}

.home-page::before,
.home-page::after {
  content: '';
  position: fixed;
  inset: 0;
  pointer-events: none;
}

.home-page::before {
  z-index: 0;
  background:
    radial-gradient(circle at 21% 21%, rgba(255, 220, 189, 0.22), transparent 15%),
    radial-gradient(circle at 54% 8%, rgba(211, 200, 255, 0.20), transparent 19%),
    radial-gradient(circle at 88% 26%, rgba(139, 189, 255, 0.24), transparent 21%),
    linear-gradient(180deg, rgba(255, 255, 255, 0.10), transparent 18%);
  filter: blur(2px);
}

.home-page::after {
  z-index: 1;
  opacity: 0.35;
  background:
    radial-gradient(circle, rgba(255, 255, 255, 0.42) 0 1px, transparent 1.5px),
    linear-gradient(rgba(255, 255, 255, 0.035) 1px, transparent 1px);
  background-size: 38px 38px, 100% 6px;
  mix-blend-mode: screen;
}

.home-page > * {
  position: relative;
  z-index: 2;
}

@keyframes homeReveal {
  from {
    opacity: 0;
    transform: translate3d(0, 18px, 0) scale(0.985);
    filter: blur(8px);
  }
  to {
    opacity: 1;
    transform: translate3d(0, 0, 0) scale(1);
    filter: blur(0);
  }
}

.home-aurora {
  position: fixed;
  inset: -18% -10% auto;
  height: 52vh;
  z-index: 1;
  pointer-events: none;
  opacity: 0.72;
  background:
    radial-gradient(ellipse at 18% 60%, rgba(255, 204, 180, 0.24), transparent 34%),
    radial-gradient(ellipse at 54% 20%, rgba(222, 207, 255, 0.30), transparent 36%),
    radial-gradient(ellipse at 86% 72%, rgba(123, 181, 255, 0.28), transparent 35%);
  filter: blur(34px);
}

.home-particles {
  position: fixed;
  inset: 0;
  z-index: 2;
  pointer-events: none;
  overflow: hidden;
}

.home-particles span {
  position: absolute;
  left: calc((var(--i) * 67px) % 100vw);
  top: calc(11vh + ((var(--i) * 29px) % 46vh));
  width: calc(4px + (var(--i) % 3) * 2px);
  height: calc(4px + (var(--i) % 3) * 2px);
  border-radius: 999px;
  background: rgba(255, 230, 205, 0.78);
  box-shadow: 0 0 18px rgba(255, 231, 205, 0.62);
  animation: particleFloat calc(9s + (var(--i) * 0.35s)) ease-in-out infinite;
}

@keyframes particleFloat {
  0%, 100% { transform: translate3d(0, 0, 0); opacity: 0.12; }
  45% { transform: translate3d(24px, -72px, 0); opacity: 0.90; }
}

.liquid-glass {
  position: relative;
  border: 1px solid var(--line);
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.24), rgba(255, 255, 255, 0.07) 46%, rgba(120, 126, 195, 0.20)),
    var(--glass);
  backdrop-filter: blur(28px) saturate(145%);
  -webkit-backdrop-filter: blur(28px) saturate(145%);
  border-radius: 28px;
  box-shadow:
    inset 0 1px 1px rgba(255, 255, 255, 0.36),
    inset 0 -22px 52px rgba(28, 33, 75, 0.16),
    0 26px 90px rgba(13, 19, 48, 0.32);
  overflow: hidden;
}

.liquid-glass::before {
  content: '';
  position: absolute;
  inset: 1px;
  border-radius: inherit;
  pointer-events: none;
  background:
    linear-gradient(145deg, rgba(255, 255, 255, 0.24), transparent 28%),
    radial-gradient(circle at 82% 14%, rgba(255, 255, 255, 0.22), transparent 22%);
  opacity: 0.68;
}

.liquid-glass::after {
  content: '';
  position: absolute;
  inset: -60% auto -60% -45%;
  width: 36%;
  transform: skewX(-16deg);
  pointer-events: none;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.35), transparent);
  opacity: 0;
  transition: transform 680ms ease, opacity 220ms ease;
}

.liquid-glass:hover::after,
.home-cta:hover::before {
  opacity: 1;
  transform: skewX(-16deg) translateX(420%);
}

.home-nav {
  position: fixed;
  top: 18px;
  left: 48px;
  right: 48px;
  z-index: 30;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 2rem;
  min-height: 58px;
  padding: 0 16px;
  border-radius: 22px;
  background:
    linear-gradient(135deg, rgba(108, 139, 202, 0.42), rgba(110, 136, 196, 0.18)),
    rgba(74, 98, 154, 0.28);
  animation: homeReveal 640ms ease both;
}

.home-brand,
.home-login,
.home-signup,
.home-nav-links a,
.home-cta {
  color: inherit;
  text-decoration: none;
}

.home-brand {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  font-size: 1rem;
  font-weight: 900;
  letter-spacing: 0.06em;
}

.home-brand-mark {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  color: #5a70a8;
  background: rgba(255, 255, 255, 0.92);
  border-radius: 10px;
}

.home-nav-links {
  display: flex;
  align-items: center;
  gap: clamp(1.2rem, 3vw, 2.4rem);
  color: rgba(255, 255, 255, 0.88);
  font-size: 0.96rem;
  font-weight: 500;
}

.home-nav-links a:hover,
.home-login:hover {
  color: #ffffff;
  text-shadow: 0 0 18px rgba(255, 255, 255, 0.46);
}

.home-nav-actions {
  display: flex;
  align-items: center;
  gap: 14px;
  font-size: 0.96rem;
  font-weight: 600;
}

.home-signup {
  display: inline-flex;
  align-items: center;
  min-height: 42px;
  padding: 0 18px;
  color: #17142c;
  background: linear-gradient(135deg, #efe2ff, #c9bbff);
  border: 1px solid rgba(255, 255, 255, 0.58);
  border-radius: 10px;
  box-shadow: 0 12px 36px rgba(77, 56, 151, 0.22);
}

.home-hero {
  position: relative;
  min-height: 100vh;
  padding: 94px 48px 54px;
}

.home-hero-center {
  width: min(1120px, 100%);
  margin: 0 auto;
  text-align: center;
  animation: homeReveal 720ms 90ms ease both;
}

.home-kicker {
  margin: 0 0 12px;
  color: rgba(234, 244, 255, 0.78);
  font-size: 0.78rem;
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.home-hero h1 {
  max-width: 1110px;
  margin: 0 auto;
  color: #ffffff;
  font-family: var(--display-font);
  font-size: clamp(2rem, 2.35vw, 2.9rem);
  font-weight: 560;
  font-variation-settings: 'SOFT' 82, 'WONK' 0.35;
  line-height: 1.08;
  letter-spacing: 0.006em;
  text-wrap: balance;
  text-shadow: 0 12px 42px rgba(30, 42, 91, 0.42);
}

.home-cta {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 16px;
  min-height: 70px;
  margin-top: 28px;
  padding: 0 10px 0 24px;
  color: #ffffff;
  font-size: 1.04rem;
  font-weight: 900;
  background: #171433;
  border: 3px solid rgba(43, 35, 95, 0.78);
  border-radius: 16px;
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.08),
    0 18px 48px rgba(28, 24, 76, 0.38);
  overflow: hidden;
}

.home-cta::before {
  content: '';
  position: absolute;
  inset: -70% auto -70% -50%;
  width: 35%;
  transform: skewX(-16deg);
  pointer-events: none;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.32), transparent);
  opacity: 0;
  transition: transform 680ms ease, opacity 220ms ease;
}

.home-cta strong {
  display: grid;
  place-items: center;
  width: 54px;
  height: 54px;
  border-radius: 13px;
  background:
    radial-gradient(circle at 26% 80%, rgba(255, 115, 177, 0.84), transparent 34%),
    linear-gradient(135deg, #9e70ff, #5a71f0);
  box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.34), 0 8px 22px rgba(94, 93, 245, 0.42);
}

.home-cta.mini {
  min-height: 52px;
  margin-top: 18px;
  padding-left: 18px;
  font-size: 0.86rem;
}

.home-cta.mini strong {
  width: 38px;
  height: 38px;
}

.hero-stage {
  position: relative;
  display: grid;
  grid-template-columns: minmax(340px, 488px) 66px minmax(390px, 640px) minmax(420px, 560px);
  grid-template-areas:
    "research rail buy pill"
    "research rail inbox report"
    "toast toast inbox report";
  gap: 20px;
  align-items: stretch;
  justify-content: center;
  width: min(1760px, 100%);
  margin: 32px auto 0;
  pointer-events: auto;
}

.hero-stage > * {
  pointer-events: auto;
}

.float-panel,
.float-pill,
.float-toast,
.float-top-buy,
.float-rail {
  z-index: 4;
  animation: homeReveal 720ms ease both;
}

.float-research { animation-delay: 190ms; }
.float-rail { animation-delay: 260ms; }
.float-top-buy { animation-delay: 320ms; }
.float-pill { animation-delay: 390ms; }
.float-report { animation-delay: 460ms; }
.float-inbox { animation-delay: 530ms; }
.float-toast { animation-delay: 600ms; }

.float-research {
  grid-area: research;
  width: auto;
  min-height: 320px;
  padding: 24px 22px 20px;
}

.float-research > .v-icon {
  color: #ffffff;
  margin-bottom: 26px;
}

.float-research p {
  margin: 0;
  color: rgba(255, 255, 255, 0.92);
  font-size: 1rem;
  line-height: 1.45;
}

.float-research p strong,
.float-research p span {
  font-weight: 900;
}

.time-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 18px;
}

.time-row button {
  min-height: 35px;
  padding: 0 12px;
  color: #ffffff;
  border: 1px solid rgba(255, 255, 255, 0.30);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.10);
  font-weight: 700;
}

.prompt-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 62px;
  margin-top: 22px;
  padding: 0 14px 0 18px;
  color: #ffffff;
  border: 1px solid rgba(255, 255, 255, 0.26);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.09);
}

.float-rail {
  grid-area: rail;
  display: grid;
  gap: 20px;
  place-items: center;
  width: 66px;
  padding: 18px 0;
  color: #ffffff;
  border-radius: 32px;
  align-self: center;
}

.float-pill {
  grid-area: pill;
  display: inline-flex;
  align-items: center;
  gap: 12px;
  min-height: 58px;
  padding: 0 22px;
  color: #ffffff;
  font-size: 0.98rem;
  font-weight: 700;
  border-radius: 999px;
  align-self: end;
  justify-self: stretch;
}

.float-report {
  grid-area: report;
  width: auto;
  min-height: 100%;
  padding: 24px 30px;
}

.panel-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  color: rgba(255, 255, 255, 0.95);
  font-size: 0.82rem;
  font-weight: 900;
}

.panel-top span {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.float-report h2 {
  margin: 28px 0 14px;
  color: #ffffff;
  font-size: 1.06rem;
  font-weight: 600;
}

.float-report p {
  margin: 0;
  color: rgba(255, 255, 255, 0.92);
  font-size: 1rem;
  line-height: 1.52;
}

.float-report mark {
  color: #ffffff;
  background: rgba(255, 255, 255, 0.22);
}

.editor-bar {
  display: flex;
  align-items: center;
  gap: 20px;
  width: max-content;
  max-width: 100%;
  min-height: 46px;
  margin: 24px auto 0;
  padding: 0 18px;
  color: #ffffff;
  background: rgba(255, 255, 255, 0.11);
  border-radius: 999px;
}

.float-inbox {
  grid-area: inbox;
  width: auto;
  min-height: 100%;
  padding: 18px 28px;
}

.inbox-tabs {
  display: grid;
  grid-template-columns: 28px repeat(4, max-content);
  gap: 22px;
  align-items: center;
  margin-bottom: 22px;
  color: rgba(255, 255, 255, 0.88);
  font-size: 0.98rem;
}

.inbox-row {
  display: grid;
  grid-template-columns: 118px 260px minmax(0, 1fr);
  gap: 12px;
  align-items: center;
  min-height: 50px;
  color: rgba(255, 255, 255, 0.88);
}

.inbox-row strong,
.inbox-row span,
.inbox-row small {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.inbox-row small {
  color: rgba(255, 255, 255, 0.54);
}

.float-toast {
  grid-area: toast;
  display: inline-flex;
  align-items: center;
  gap: 14px;
  width: min(340px, 100%);
  min-height: 104px;
  padding: 20px 24px;
  color: #ffffff;
  font-weight: 700;
  background:
    linear-gradient(135deg, rgba(113, 33, 88, 0.58), rgba(64, 49, 125, 0.36)),
    rgba(86, 58, 132, 0.42);
}

.float-top-buy {
  grid-area: buy;
  width: min(390px, 100%);
  min-height: 178px;
  padding: 18px 20px 20px;
  color: #ffffff;
  border-radius: 30px;
  align-self: end;
  justify-self: center;
  background:
    radial-gradient(circle at 86% 14%, rgba(218, 200, 255, 0.30), transparent 28%),
    linear-gradient(135deg, rgba(255, 255, 255, 0.30), rgba(111, 128, 192, 0.18) 52%, rgba(55, 66, 127, 0.34)),
    rgba(84, 100, 168, 0.42);
  box-shadow:
    inset 0 1px 1px rgba(255, 255, 255, 0.42),
    inset 0 -28px 52px rgba(28, 33, 75, 0.18),
    0 28px 80px rgba(15, 22, 56, 0.34),
    0 0 32px rgba(135, 184, 255, 0.14);
}

.float-top-buy div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
  color: rgba(245, 249, 255, 0.86);
  font-size: 0.70rem;
  font-weight: 900;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.float-top-buy div strong {
  display: inline-grid;
  place-items: center;
  min-height: 24px;
  padding: 0 10px;
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 999px;
  background:
    radial-gradient(circle at 20% 70%, rgba(255, 117, 191, 0.36), transparent 42%),
    rgba(255, 255, 255, 0.11);
  box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.24);
}

.float-top-buy h2 {
  margin: 0;
  font-family: var(--body-font);
  font-size: clamp(2.5rem, 4vw, 3.25rem);
  font-weight: 900;
  line-height: 0.9;
  letter-spacing: 0.02em;
  text-shadow: 0 12px 36px rgba(20, 29, 76, 0.32);
}

.float-top-buy p {
  max-width: 300px;
  margin: 12px 0 0;
  color: rgba(255, 255, 255, 0.78);
  font-size: 0.86rem;
  line-height: 1.38;
}

.home-section,
.signal-strip,
.pricing-band,
.faq-section {
  position: relative;
  z-index: 3;
  width: min(1180px, calc(100% - 40px));
  margin: 0 auto;
}

.liquid-section {
  padding: clamp(70px, 10vw, 120px) 0 34px;
}

.home-section h2,
.signal-strip h2,
.pricing-band h2,
.faq-section h2 {
  max-width: 820px;
  margin: 0;
  color: #ffffff;
  font-family: var(--display-font);
  font-size: clamp(1.85rem, 3vw, 3.2rem);
  font-weight: 560;
  font-variation-settings: 'SOFT' 82, 'WONK' 0.25;
  line-height: 1.08;
  letter-spacing: 0.004em;
  text-wrap: balance;
}

.feature-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 18px;
  margin-top: 34px;
}

.feature-card {
  min-height: 230px;
  padding: 24px;
  color: #ffffff;
}

.feature-card .v-icon {
  color: #ffffff;
  margin-bottom: 28px;
}

.feature-card h3 {
  margin: 0 0 12px;
  font-size: 1.02rem;
}

.feature-card p,
.pricing-band p,
.faq-card p {
  color: var(--muted);
  line-height: 1.55;
}

.signal-strip {
  display: grid;
  grid-template-columns: minmax(0, 0.92fr) minmax(0, 1fr);
  gap: 30px;
  align-items: center;
  margin-top: 36px;
  padding: 34px;
}

.home-steps {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.pipeline-step {
  appearance: none;
  display: grid;
  grid-template-columns: auto auto;
  place-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 48px;
  min-width: 0;
  color: #ffffff;
  cursor: pointer;
  border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.11);
  font-size: 0.76rem;
  font-family: var(--body-font);
  font-weight: 900;
  text-transform: uppercase;
  box-shadow:
    inset 0 1px 1px rgba(255, 255, 255, 0.24),
    0 12px 32px rgba(18, 25, 63, 0.18);
  transition: transform 180ms ease, border-color 180ms ease, background 180ms ease, box-shadow 180ms ease;
}

.pipeline-step:hover,
.pipeline-step:focus-visible,
.pipeline-step.active {
  border-color: rgba(218, 200, 255, 0.70);
  background:
    radial-gradient(circle at 88% 26%, rgba(198, 116, 255, 0.30), transparent 34%),
    linear-gradient(135deg, rgba(255, 255, 255, 0.22), rgba(128, 149, 220, 0.24));
  box-shadow:
    inset 0 1px 1px rgba(255, 255, 255, 0.32),
    0 18px 42px rgba(94, 93, 245, 0.24);
  transform: translateY(-1px);
}

.pipeline-step:active,
.pipeline-step.active {
  transform: translateY(1px);
  box-shadow:
    inset 0 2px 12px rgba(20, 24, 58, 0.28),
    0 8px 22px rgba(94, 93, 245, 0.16);
}

.pipeline-step span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.step-window-layer {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: grid;
  align-items: center;
  justify-items: end;
  padding: clamp(18px, 4vw, 64px);
  pointer-events: none;
  background:
    radial-gradient(circle at 72% 40%, rgba(120, 137, 218, 0.20), transparent 28%),
    transparent;
}

.step-detail-window {
  width: min(520px, calc(100vw - 32px));
  max-height: calc(100vh - 96px);
  padding: 24px;
  color: #ffffff;
  background:
    linear-gradient(135deg, rgba(139, 157, 220, 0.62), rgba(56, 66, 118, 0.42)),
    rgba(50, 62, 125, 0.64);
  box-shadow:
    inset 0 1px 1px rgba(255, 255, 255, 0.38),
    inset 0 -26px 58px rgba(38, 39, 92, 0.20),
    0 36px 120px rgba(4, 8, 26, 0.54),
    0 0 44px rgba(135, 184, 255, 0.18);
  animation: stepWindowIn 220ms ease both;
  overflow: auto;
  pointer-events: auto;
}

@keyframes stepWindowIn {
  from {
    opacity: 0;
    transform: translate3d(20px, 12px, 0) scale(0.97);
    filter: blur(6px);
  }
  to {
    opacity: 1;
    transform: translate3d(0, 0, 0) scale(1);
    filter: blur(0);
  }
}

.step-detail-window header {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
}

.step-detail-window header span {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  color: rgba(236, 245, 255, 0.82);
  font-size: 0.74rem;
  font-weight: 900;
  letter-spacing: 0.11em;
  text-transform: uppercase;
}

.step-detail-window header button {
  appearance: none;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  color: #ffffff;
  border: 1px solid rgba(255, 255, 255, 0.24);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.10);
  cursor: pointer;
  transition: background 160ms ease, transform 160ms ease;
}

.step-detail-window header button:hover,
.step-detail-window header button:focus-visible {
  background: rgba(255, 255, 255, 0.18);
  transform: translateY(-1px);
}

.step-detail-window h3,
.step-detail-window p {
  position: relative;
  z-index: 1;
}

.step-detail-window h3 {
  margin: 0;
  font-family: var(--display-font);
  font-size: clamp(1.7rem, 3vw, 2.25rem);
  font-weight: 590;
  font-variation-settings: 'SOFT' 82, 'WONK' 0.25;
  line-height: 1.05;
}

.step-detail-window p {
  margin: 16px 0 0;
  color: rgba(255, 255, 255, 0.84);
  font-size: 0.98rem;
  line-height: 1.62;
}

.pricing-band {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 360px);
  gap: 36px;
  align-items: center;
  padding: clamp(80px, 10vw, 125px) 0 50px;
}

.price-bubble {
  display: grid;
  justify-items: center;
  gap: 8px;
  min-height: 310px;
  padding: 34px;
  text-align: center;
}

.price-bubble span {
  color: rgba(255, 255, 255, 0.72);
  font-weight: 900;
  text-transform: uppercase;
}

.price-bubble strong {
  color: #ffffff;
  font-family: var(--display-font);
  font-size: clamp(2.8rem, 4.6vw, 4.15rem);
  font-weight: 620;
  font-variation-settings: 'SOFT' 74, 'WONK' 0.12;
  line-height: 0.96;
}

.price-bubble small {
  color: #c9f4ff;
  font-weight: 900;
}

.faq-section {
  padding: 50px 0 100px;
}

.faq-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  margin-top: 26px;
}

.faq-card {
  width: 100%;
  min-height: 92px;
  padding: 22px;
  color: #ffffff;
  text-align: left;
}

.faq-card span {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.faq-card strong {
  font-size: 0.98rem;
}

.faq-card p {
  display: none;
  margin: 14px 0 0;
}

.faq-card.open p {
  display: block;
}

@media (max-width: 1180px) {
  .home-nav {
    left: 20px;
    right: 20px;
  }

  .home-hero {
    min-height: auto;
    padding: 96px 20px 48px;
  }

  .hero-stage {
    position: relative;
    inset: auto;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    grid-template-areas: none;
    gap: 16px;
    width: min(900px, 100%);
    margin: 46px auto 0;
    pointer-events: auto;
  }

  .float-research,
  .float-report,
  .float-inbox,
  .float-toast,
  .float-top-buy,
  .float-pill,
  .float-rail {
    position: relative;
    inset: auto;
    left: auto;
    right: auto;
    top: auto;
    bottom: auto;
    width: auto;
  }

  .float-research,
  .float-report,
  .float-inbox,
  .float-toast,
  .float-top-buy,
  .float-pill,
  .float-rail {
    grid-area: auto;
    justify-self: stretch;
  }

  .float-rail {
    grid-auto-flow: column;
    grid-column: 1 / -1;
    width: 100%;
    padding: 14px;
  }

  .float-research { order: 1; }
  .float-rail { order: 2; }
  .float-top-buy { order: 3; }
  .float-pill { order: 4; }
  .float-report { order: 5; }
  .float-inbox { order: 6; }
  .float-toast { order: 7; }

  .float-pill,
  .float-toast,
  .float-top-buy {
    min-height: 84px;
  }

  .float-inbox,
  .float-report,
  .float-research {
    min-height: 260px;
  }

  .inbox-row {
    grid-template-columns: 92px minmax(0, 1fr);
  }

  .inbox-row small {
    display: none;
  }
}

@media (max-width: 820px) {
  .home-page {
    background-attachment: scroll;
  }

  .home-nav {
    grid-template-columns: auto auto;
    gap: 12px;
  }

  .home-nav-links {
    display: none;
  }

  .home-brand {
    font-size: 0.86rem;
  }

  .hero-stage,
  .feature-grid,
  .signal-strip,
  .pricing-band,
  .faq-grid {
    grid-template-columns: 1fr;
  }

  .home-hero h1 {
    font-size: clamp(2rem, 8vw, 3rem);
  }

  .home-cta {
    width: min(100%, 340px);
    justify-content: space-between;
  }

  .float-report,
  .float-research,
  .float-inbox {
    padding: 20px;
  }

  .inbox-tabs {
    grid-template-columns: 28px 1fr 1fr;
    gap: 12px;
  }

  .inbox-tabs span:nth-child(n + 4) {
    display: none;
  }

  .signal-strip,
  .price-bubble,
  .faq-card {
    padding: 24px;
  }

  .step-window-layer {
    align-items: center;
    justify-items: center;
    padding: 14px;
    background: rgba(5, 9, 20, 0.30);
  }

  .step-detail-window {
    width: min(380px, calc(100vw - 24px));
    max-height: calc(100vh - 104px);
    padding: 22px;
    background:
      linear-gradient(135deg, rgba(143, 160, 224, 0.82), rgba(52, 61, 116, 0.68)),
      rgba(39, 49, 109, 0.90);
  }

  .step-detail-window h3 {
    font-size: clamp(1.45rem, 7vw, 1.85rem);
  }

  .step-detail-window p {
    font-size: 0.92rem;
    line-height: 1.55;
  }
}

@media (max-width: 560px) {
  .home-nav {
    left: 10px;
    right: 10px;
    min-height: 54px;
    padding: 0 10px;
  }

  .home-login {
    display: none;
  }

  .home-signup {
    min-height: 38px;
    padding: 0 13px;
  }

  .home-hero {
    padding: 86px 12px 38px;
  }

  .home-hero-center {
    text-align: left;
  }

  .home-hero h1 {
    margin-left: 0;
  }

  .home-cta {
    margin-top: 24px;
  }

  .hero-stage {
    margin-top: 28px;
  }

  .home-section,
  .signal-strip,
  .pricing-band,
  .faq-section {
    width: calc(100% - 24px);
  }

  .home-section h2,
  .signal-strip h2,
  .pricing-band h2,
  .faq-section h2 {
    font-size: clamp(1.85rem, 9vw, 2.75rem);
  }
}
</style>
