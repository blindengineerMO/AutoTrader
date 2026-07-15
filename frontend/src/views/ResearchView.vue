<template>
  <div class="page-shell research-desk">
    <div class="research-hero ops-command-bar mb-6">
      <div class="min-w-0">
        <p class="page-kicker mb-3">Autonomous source collection, financial evaluation, and traceable decision reports</p>
        <h1 class="page-title">Research Desk</h1>
        <p class="page-copy mt-4 max-w-3xl">
          The engine scans US and world news, macro signals, consumer sales reports, and market data, then narrows the field into
          quote-backed buy/sell/hold decisions with evidence attached.
        </p>
      </div>
      <div class="research-command mini-glass">
        <div class="text-xs uppercase text-white/40">operation</div>
        <div class="font-headline text-lg text-accent">{{ activeRun?.status || 'standby' }}</div>
        <div class="research-progress mt-3" :style="{ '--progress': `${activeRun?.progress || 0}%` }"></div>
        <div class="text-xs text-white/40 mt-2">{{ activeRun?.phase || 'ready' }} · {{ activeRun?.progress || 0 }}%</div>
        <div class="flex flex-wrap gap-3 mt-5">
          <GlassButton :disabled="isBusy" @click="collectProcess">
            <v-icon size="16" class="mr-1">mdi-radar</v-icon>
            {{ isBusy ? 'Processing...' : 'Collect/process research' }}
          </GlassButton>
          <GlassButton variant="ghost" :disabled="isBusy" @click="runResearchOnly">
            {{ running === 'research' ? 'Running...' : 'Run research only' }}
          </GlassButton>
          <GlassButton variant="ghost" :disabled="isBusy" @click="runEvaluation">
            {{ running === 'evaluation' ? 'Evaluating...' : 'Run evaluation' }}
          </GlassButton>
          <GlassButton variant="ghost" :disabled="isBusy" @click="runSafeMvp">
            <v-icon size="16" class="mr-1">mdi-shield-check</v-icon>
            {{ running === 'safe-mvp' ? 'Validating...' : 'Run SPEC safe MVP' }}
          </GlassButton>
        </div>
        <div class="flex flex-wrap gap-2 mt-4">
          <button class="hud-window-toggle" :class="{ active: sourcesOpen }" @click="sourcesOpen = !sourcesOpen">
            <v-icon size="16">mdi-database-search</v-icon>
            sources
          </button>
          <button class="hud-window-toggle" :class="{ active: decisionOpen }" @click="decisionOpen = !decisionOpen">
            <v-icon size="16">mdi-file-chart-outline</v-icon>
            decision report
          </button>
          <button class="hud-window-toggle" :class="{ active: researchRunsOpen }" @click="researchRunsOpen = !researchRunsOpen">
            <v-icon size="16">mdi-history</v-icon>
            runs
          </button>
          <button class="hud-window-toggle" :class="{ active: planHistoryOpen }" @click="planHistoryOpen = !planHistoryOpen">
            <v-icon size="16">mdi-clipboard-text-clock-outline</v-icon>
            plans
          </button>
        </div>
      </div>
    </div>

    <div v-if="error" class="glass-panel p-4 text-danger text-sm mb-5">{{ error }}</div>

    <div class="bento-grid stagger mb-6">
      <GlassCard title="Current thesis" class="bento-span-5">
        <div v-if="!latestReport" class="text-white/42 text-sm">No decision report yet. Start collect/process to build one.</div>
        <div v-else>
          <div class="flex flex-wrap gap-2 mb-4">
            <span class="hud-chip">{{ latestReport.mode }}</span>
            <span class="hud-chip">{{ latestReport.summary?.modelUsed }}</span>
            <span class="hud-chip">{{ latestReport.summary?.researchSource }}</span>
          </div>
          <p class="text-white/70 text-sm leading-6">{{ latestReport.summary?.researchNarrative?.summary || latestReport.summary?.overallRationale }}</p>
          <div class="hud-stat-grid mt-5">
            <div class="hud-stat">
              <strong>{{ latestReport.summary?.sourceStack?.length || 0 }}</strong>
              <span>sources</span>
            </div>
            <div class="hud-stat">
              <strong>{{ latestReport.summary?.actions?.length || 0 }}</strong>
              <span>decisions</span>
            </div>
            <div class="hud-stat">
              <strong>{{ latestReport.liveReady ? 'LIVE' : 'SIM' }}</strong>
              <span>mode</span>
            </div>
          </div>
        </div>
      </GlassCard>

      <GlassCard title="Highest value candidates" class="bento-span-7">
        <div class="candidate-split-grid">
          <section class="candidate-panel mini-glass">
            <div class="candidate-panel-head">
              <span>Top 5 purchase candidates</span>
              <v-icon size="17" class="text-accent">mdi-trending-up</v-icon>
            </div>
            <div v-if="!purchaseCandidates.length" class="text-white/42 text-xs">No current buy candidates.</div>
            <div v-else class="candidate-stack">
              <div v-for="s in purchaseCandidates" :key="`buy-${s.symbol}`" class="candidate-row">
                <div class="min-w-0">
                  <strong class="font-headline">{{ s.symbol }}</strong>
                  <small>{{ s.theme || 'watchlist' }}</small>
                </div>
                <div class="text-right">
                  <span class="text-accent font-headline">{{ s.localAiScore || 'n/a' }}</span>
                  <small>{{ s.changePct >= 0 ? '+' : '' }}{{ s.changePct }}%</small>
                </div>
              </div>
            </div>
          </section>
          <section class="candidate-panel mini-glass danger-panel">
            <div class="candidate-panel-head">
              <span>Top 5 sell value candidates</span>
              <v-icon size="17" class="text-danger">mdi-trending-down</v-icon>
            </div>
            <div v-if="!sellCandidates.length" class="text-white/42 text-xs">No current sell candidates.</div>
            <div v-else class="candidate-stack">
              <div v-for="s in sellCandidates" :key="`sell-${s.symbol}`" class="candidate-row">
                <div class="min-w-0">
                  <strong class="font-headline">{{ s.symbol }}</strong>
                  <small>{{ s.actionBias || s.momentum || 'risk review' }}</small>
                </div>
                <div class="text-right">
                  <span class="text-danger font-headline">{{ sellScore(s) }}</span>
                  <small>{{ s.changePct >= 0 ? '+' : '' }}{{ s.changePct }}%</small>
                </div>
              </div>
            </div>
          </section>
        </div>
      </GlassCard>

      <GlassCard title="Latest self-evaluation" class="bento-span-4">
        <div v-if="!latestEvaluation" class="text-white/42 text-sm">No evaluation report yet.</div>
        <div v-else>
          <div class="font-headline text-3xl text-accent">{{ latestEvaluation.summary?.accuracy || 0 }}%</div>
          <div class="text-xs text-white/40 mb-4">decision accuracy · confidence {{ latestEvaluation.summary?.neuralConfidence || 0 }}</div>
          <p class="text-white/62 text-sm leading-6">{{ latestEvaluation.summary?.selfAssessment }}</p>
          <div class="hud-card-meta mt-4">
            <span class="hud-chip">{{ latestEvaluation.summary?.evaluatedDecisionReports || 0 }} reports</span>
            <span class="hud-chip">{{ latestEvaluation.summary?.evaluatedActions || 0 }} actions</span>
            <span class="hud-chip">{{ latestEvaluation.summary?.avgObservedReturnPct || 0 }}% avg</span>
          </div>
        </div>
      </GlassCard>

      <GlassCard title="SPEC safety monitor" class="bento-span-8">
        <div v-if="!safeMvpResult" class="text-white/42 text-sm">Run the SPEC safe MVP to validate point-in-time data, approved model status, target portfolio, and deterministic risk checks.</div>
        <div v-else>
          <div class="flex flex-wrap gap-2 mb-4">
            <span class="hud-chip">{{ safeMvpResult.market_regime }}</span>
            <span class="hud-chip">{{ safeMvpResult.model_version }}</span>
            <span class="hud-chip">{{ safeMvpResult.dataset_version }}</span>
          </div>
          <div class="candidate-split-grid">
            <section class="candidate-panel mini-glass">
              <div class="candidate-panel-head">
                <span>Target portfolio</span>
                <v-icon size="17" class="text-accent">mdi-vector-polyline</v-icon>
              </div>
              <div v-if="!safeMvpResult.portfolio?.length" class="text-white/42 text-xs">No targets generated.</div>
              <div v-else class="candidate-stack">
                <div v-for="item in safeMvpResult.portfolio.slice(0, 6)" :key="`safe-${item.symbol}`" class="candidate-row">
                  <div class="min-w-0">
                    <strong class="font-headline">{{ item.symbol }}</strong>
                    <small>{{ item.reason_codes?.slice(0, 2).join(', ') }}</small>
                  </div>
                  <div class="text-right">
                    <span class="text-accent font-headline">{{ pct(item.target_weight) }}</span>
                    <small>conf {{ pct(item.confidence) }}</small>
                  </div>
                </div>
              </div>
            </section>
            <section class="candidate-panel mini-glass danger-panel">
              <div class="candidate-panel-head">
                <span>Risk failures</span>
                <v-icon size="17" class="text-danger">mdi-alert-octagon-outline</v-icon>
              </div>
              <div v-if="!riskFailures.length" class="text-white/42 text-xs">No critical failures in the last safe run.</div>
              <div v-else class="candidate-stack">
                <div v-for="check in riskFailures.slice(0, 6)" :key="`${check.checkName}-${check.symbol}`" class="candidate-row">
                  <div class="min-w-0">
                    <strong class="font-headline">{{ check.symbol || check.checkName }}</strong>
                    <small>{{ check.reason }}</small>
                  </div>
                  <span class="hud-chip text-danger">{{ check.severity }}</span>
                </div>
              </div>
            </section>
          </div>
          <div class="hud-card-meta mt-4">
            <span class="hud-chip">{{ safeMvpResult.risk_checks?.length || 0 }} checks</span>
            <span class="hud-chip">{{ safeMvpResult.rejected_trades?.length || 0 }} rejected</span>
            <span class="hud-chip">{{ safeMvpResult.paper_order_intents?.length || 0 }} paper intents</span>
            <button class="hud-chip hud-chip-button" @click="loadSafeRunDetail('risk')">risk</button>
            <button class="hud-chip hud-chip-button" @click="loadSafeRunDetail('paper')">paper</button>
            <button class="hud-chip hud-chip-button" @click="loadSafeRunDetail('audit')">audit</button>
          </div>
        </div>
      </GlassCard>
    </div>

    <div class="bento-grid stagger">
      <GlassCard title="SPEC backtests & monitoring" class="bento-span-12">
        <div class="candidate-split-grid">
          <section class="candidate-panel mini-glass">
            <div class="candidate-panel-head">
              <span>Monitoring</span>
              <v-icon size="17" class="text-accent">mdi-monitor-dashboard</v-icon>
            </div>
            <div v-if="!specMonitoring.length" class="text-white/42 text-xs">No SPEC monitoring records yet.</div>
            <div v-else class="candidate-stack">
              <div v-for="item in specMonitoring" :key="item.status_key" class="candidate-row">
                <div class="min-w-0">
                  <strong class="font-headline">{{ item.status_key }}</strong>
                  <small>{{ item.observed_at }}</small>
                </div>
                <span class="hud-chip" :class="item.status === 'fail' ? 'text-danger' : item.status === 'warn' ? 'text-warning' : 'text-accent'">{{ item.status }}</span>
              </div>
            </div>
          </section>
          <section class="candidate-panel mini-glass">
            <div class="candidate-panel-head">
              <span>Backtests</span>
              <v-icon size="17" class="text-accent">mdi-chart-timeline-variant</v-icon>
            </div>
            <div v-if="!specBacktests.length" class="text-white/42 text-xs">No safe-MVP backtest records yet.</div>
            <div v-else class="candidate-stack">
              <div v-for="run in specBacktests.slice(0, 5)" :key="run.run_id" class="candidate-row">
                <div class="min-w-0">
                  <strong class="font-headline">{{ run.run_id }}</strong>
                  <small>turnover {{ pct(run.metrics?.turnover || 0) }} · costs ${{ fmt(run.metrics?.transactionCostsUsd || 0) }}</small>
                </div>
                <button class="hud-chip hud-chip-button" @click="loadBacktestEvents(run.run_id)">{{ run.status }}</button>
              </div>
            </div>
          </section>
        </div>
        <div class="spec-drill-grid mt-4">
          <section class="candidate-panel mini-glass">
            <div class="candidate-panel-head">
              <span>Model lifecycle</span>
              <v-icon size="17" class="text-accent">mdi-brain</v-icon>
            </div>
            <div v-if="!specModels.length" class="text-white/42 text-xs">No model registry records loaded.</div>
            <div v-else class="candidate-stack">
              <div v-for="model in specModels.slice(0, 4)" :key="model.model_version" class="candidate-row">
                <div class="min-w-0">
                  <strong class="font-headline">{{ model.model_version }}</strong>
                  <small>{{ model.model_type }} · {{ snapshotCount(model.model_version) }} snapshots</small>
                </div>
                <button
                  class="hud-chip hud-chip-button"
                  :disabled="model.status === 'champion'"
                  @click="rollbackModel(model.model_version)"
                >
                  {{ model.status === 'champion' ? 'champion' : 'rollback' }}
                </button>
              </div>
            </div>
          </section>
          <section class="candidate-panel mini-glass">
            <div class="candidate-panel-head">
              <span>Data quality</span>
              <v-icon size="17" class="text-accent">mdi-database-check-outline</v-icon>
            </div>
            <div v-if="!specDataQuality.length" class="text-white/42 text-xs">No data-quality reports yet.</div>
            <div v-else class="candidate-stack">
              <button v-for="report in specDataQuality.slice(0, 4)" :key="report.id" class="candidate-row clickable-row" @click="showDataQuality(report)">
                <div class="min-w-0">
                  <strong class="font-headline">{{ report.dataset_version }}</strong>
                  <small>{{ report.scope }} · {{ report.created_at }}</small>
                </div>
                <span class="hud-chip" :class="report.status === 'fail' ? 'text-danger' : report.status === 'warn' ? 'text-warning' : 'text-accent'">{{ report.status }}</span>
              </button>
            </div>
          </section>
          <section class="candidate-panel mini-glass">
            <div class="candidate-panel-head">
              <span>Reconciliation</span>
              <v-icon size="17" class="text-accent">mdi-scale-balance</v-icon>
            </div>
            <div v-if="!specReconciliations.length" class="text-white/42 text-xs">No paper reconciliation runs yet.</div>
            <div v-else class="candidate-stack">
              <button v-for="run in specReconciliations.slice(0, 4)" :key="run.run_id" class="candidate-row clickable-row" @click="loadReconciliation(run.run_id)">
                <div class="min-w-0">
                  <strong class="font-headline">{{ run.run_id }}</strong>
                  <small>{{ run.summary?.differences || 0 }} differences</small>
                </div>
                <span class="hud-chip" :class="run.status === 'fail' ? 'text-danger' : run.status === 'warn' ? 'text-warning' : 'text-accent'">{{ run.status }}</span>
              </button>
            </div>
          </section>
          <section class="candidate-panel mini-glass spec-detail-panel">
            <div class="candidate-panel-head">
              <span>Drill-down</span>
              <v-icon size="17" class="text-accent">mdi-console-line</v-icon>
            </div>
            <div v-if="!specDetailLines.length" class="text-white/42 text-xs">Select a backtest, data-quality, audit, paper, or reconciliation row to inspect details.</div>
            <div v-else class="spec-detail-lines">
              <div v-for="line in specDetailLines" :key="line.key" class="spec-detail-line">
                <strong>{{ line.label }}</strong>
                <code>{{ line.value }}</code>
              </div>
            </div>
          </section>
        </div>
      </GlassCard>
    </div>

    <button v-if="selectedRun || activeRun" class="terminal-toggle" @click="terminalOpen = !terminalOpen">
      <v-icon size="18">mdi-console</v-icon>
      terminal
    </button>

    <aside v-if="sourcesOpen" class="floating-glass-window floating-sources-window">
      <div class="floating-window-head">
        <span>data sources</span>
        <button @click="sourcesOpen = false"><v-icon size="16">mdi-close</v-icon></button>
      </div>
      <div class="floating-window-body source-list">
        <div v-if="!sourceStack.length" class="text-white/42 text-sm">Sources will appear after the next autonomous run.</div>
        <template v-else>
          <a v-for="source in sourceStack" :key="`${source.name}-${source.url}`" :href="source.url" target="_blank" rel="noreferrer" class="source-row mini-glass">
            <span class="source-dot"></span>
            <span class="min-w-0">
              <strong>{{ source.name }}</strong>
              <small>{{ source.type }}{{ source.region ? ` · ${source.region}` : '' }}</small>
            </span>
          </a>
        </template>
      </div>
    </aside>

    <aside
      v-if="researchRunsOpen"
      class="floating-glass-window floating-research-desk-window floating-research-runs-window"
      :style="{ transform: `translate(${researchWindowPositions.runs.x}px, ${researchWindowPositions.runs.y}px)` }"
    >
      <div class="floating-window-head movable-head" @pointerdown="startResearchWindowDrag($event, 'runs')">
        <span>
          research runs
          <small>{{ runs.length }} records</small>
        </span>
        <button @click.stop="researchRunsOpen = false"><v-icon size="16">mdi-close</v-icon></button>
      </div>
      <div class="floating-window-body">
        <div v-if="!runs.length" class="text-white/42 text-sm">No research operations yet.</div>
        <div v-else class="flex flex-col gap-3">
          <button v-for="run in runs" :key="run.id" class="run-row mini-glass" @click="selectRun(run)">
            <span>
              <strong>#{{ run.id }} · {{ run.status }}</strong>
              <small>{{ run.started_at }} · {{ run.phase }}</small>
            </span>
            <span>{{ run.progress }}%</span>
          </button>
        </div>
      </div>
    </aside>

    <aside
      v-if="planHistoryOpen"
      class="floating-glass-window floating-research-desk-window floating-plan-history-window"
      :style="{ transform: `translate(${researchWindowPositions.plans.x}px, ${researchWindowPositions.plans.y}px)` }"
    >
      <div class="floating-window-head movable-head" @pointerdown="startResearchWindowDrag($event, 'plans')">
        <span>
          plan history
          <small>{{ plans.length }} records</small>
        </span>
        <button @click.stop="planHistoryOpen = false"><v-icon size="16">mdi-close</v-icon></button>
      </div>
      <div class="floating-window-body">
        <div v-if="!plans.length" class="text-white/42 text-sm">No trading plans yet.</div>
        <div v-else class="flex flex-col gap-3">
          <div v-for="plan in plans" :key="plan.id" class="mini-glass p-4">
            <div class="flex flex-wrap items-center justify-between gap-3 mb-3">
              <div class="text-xs text-white/40">{{ plan.created_at }} · {{ plan.model_used }}</div>
              <div class="flex gap-2">
                <span class="hud-chip">{{ plan.execution_mode }}</span>
                <span class="hud-chip">{{ plan.status }}</span>
              </div>
            </div>
            <div class="plan-action-grid">
              <div v-for="a in plan.actions" :key="a.id" class="text-xs">
                <strong :class="a.action === 'buy' ? 'text-accent' : a.action === 'sell' ? 'text-danger' : 'text-white/55'">{{ a.action }}</strong>
                <span>{{ a.symbol }}</span>
                <small>{{ a.status }}</small>
              </div>
            </div>
          </div>
        </div>
      </div>
    </aside>

    <aside v-if="decisionOpen" class="floating-glass-window floating-decision-window">
      <div class="floating-window-head">
        <span>decision report</span>
        <button @click="decisionOpen = false"><v-icon size="16">mdi-close</v-icon></button>
      </div>
      <div class="floating-window-body">
        <div v-if="!latestReport" class="text-white/42 text-sm">No report generated yet.</div>
        <div v-else class="decision-table">
          <div class="decision-row decision-head">
            <span>Action</span>
            <span>Symbol</span>
            <span>Evidence</span>
            <span>Status</span>
          </div>
          <div v-for="action in latestReport.summary.actions" :key="`${latestReport.id}-${action.symbol}-${action.status}`" class="decision-row mini-glass">
            <span class="uppercase font-bold" :class="action.action === 'buy' ? 'text-accent' : action.action === 'sell' ? 'text-danger' : 'text-white/55'">
              {{ action.action }}
            </span>
            <span class="font-headline">{{ action.symbol }}</span>
            <span class="min-w-0">
              <span class="block text-white/70">{{ evidenceLine(action) }}</span>
              <small v-if="historicalWatchLine(action)" class="block text-accent/70">{{ historicalWatchLine(action) }}</small>
              <small class="block text-white/38">{{ action.rationale }}</small>
              <small v-if="action.evidence?.discovery" class="block text-accent/70">{{ action.evidence.discovery.evidence?.[0]?.reason }}</small>
            </span>
            <span class="text-white/42">{{ action.status }}</span>
          </div>
        </div>
      </div>
    </aside>

    <aside v-if="terminalOpen && (selectedRun || activeRun)" class="floating-terminal">
      <div class="terminal-head">
        <span>debug stream · run #{{ terminalRun.id }}</span>
        <button @click="terminalOpen = false"><v-icon size="16">mdi-close</v-icon></button>
      </div>
      <div class="terminal-body">
        <div v-for="(line, index) in terminalRun.terminal" :key="`${line.ts}-${index}`" class="terminal-line" :class="line.level">
          <span>{{ timeOnly(line.ts) }}</span>
          <strong>{{ line.phase }}</strong>
          <p>{{ line.message }}</p>
          <code v-if="line.data">{{ compact(line.data) }}</code>
        </div>
      </div>
    </aside>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import api from '../api/client';
import GlassCard from '../components/GlassCard.vue';
import GlassButton from '../components/GlassButton.vue';

const snapshots = ref([]);
const plans = ref([]);
const reports = ref([]);
const evaluations = ref([]);
const runs = ref([]);
const safeMvpResult = ref(null);
const specMonitoring = ref([]);
const specBacktests = ref([]);
const specDataQuality = ref([]);
const specModels = ref([]);
const specPromotionReviews = ref([]);
const specTrainingSnapshots = ref([]);
const specRollbacks = ref([]);
const specReconciliations = ref([]);
const specDetail = ref(null);
const activeRun = ref(null);
const selectedRun = ref(null);
const terminalOpen = ref(false);
const sourcesOpen = ref(false);
const decisionOpen = ref(false);
const researchRunsOpen = ref(false);
const planHistoryOpen = ref(false);
const researchWindowPositions = ref({
  runs: { x: 0, y: 0 },
  plans: { x: 0, y: 0 },
});
const running = ref(false);
const error = ref('');
let pollTimer = null;
let researchWindowDrag = null;

const latestSignals = computed(() => snapshots.value[0]?.signals || []);
const latestReport = computed(() => reports.value[0] || null);
const latestEvaluation = computed(() => evaluations.value[0] || null);
const sourceStack = computed(() => latestReport.value?.summary?.sourceStack || snapshots.value[0]?.summary?.sourceStack || []);
const isBusy = computed(() => ['queued', 'running'].includes(activeRun.value?.status) || Boolean(running.value));
const terminalRun = computed(() => selectedRun.value || activeRun.value);
const purchaseCandidates = computed(() =>
  [...latestSignals.value]
    .filter((signal) => signal.actionBias === 'buy-candidate' || Number(signal.localAiScore || 0) >= 58)
    .sort((a, b) => Number(b.localAiScore || 0) - Number(a.localAiScore || 0))
    .slice(0, 5)
);
const sellCandidates = computed(() =>
  [...latestSignals.value]
    .filter((signal) => sellScore(signal) >= 45)
    .sort((a, b) => sellScore(b) - sellScore(a))
    .slice(0, 5)
);
const riskFailures = computed(() => (safeMvpResult.value?.risk_checks || []).filter((check) => check.status === 'fail'));
const specDetailLines = computed(() => {
  if (!specDetail.value) return [];
  return Object.entries(specDetail.value).map(([key, value]) => ({
    key,
    label: key.replace(/_/g, ' '),
    value: typeof value === 'string' ? value : compact(value),
  }));
});

async function load() {
  const [snapRes, planRes, reportRes, evalRes, runRes] = await Promise.all([
    api.get('/research/snapshots'),
    api.get('/research/plans'),
    api.get('/research/reports'),
    api.get('/research/evaluations'),
    api.get('/research/runs'),
  ]);
  snapshots.value = snapRes.data;
  plans.value = planRes.data;
  reports.value = reportRes.data;
  evaluations.value = evalRes.data;
  runs.value = runRes.data;
  void refreshSpecPanels();
  if (!activeRun.value) {
    const current = runs.value.find((run) => ['queued', 'running'].includes(run.status));
    if (current) startPolling(current.id);
  }
}

async function refreshSpecPanels() {
  const emptyModelState = {
    models: [],
    promotionReviews: [],
    trainingSnapshots: [],
    rollbacks: [],
  };
  const [monitorData, backtestData, qualityData, modelData, reconciliationData] = await Promise.all([
    optionalResearchGet('/research/spec-monitoring', []),
    optionalResearchGet('/research/safe-mvp/backtests', []),
    optionalResearchGet('/research/spec-data-quality', []),
    optionalResearchGet('/research/spec-models', emptyModelState),
    optionalResearchGet('/research/spec-reconciliations', []),
  ]);

  specMonitoring.value = monitorData;
  specBacktests.value = backtestData;
  specDataQuality.value = qualityData;
  specModels.value = modelData.models || [];
  specPromotionReviews.value = modelData.promotionReviews || [];
  specTrainingSnapshots.value = modelData.trainingSnapshots || [];
  specRollbacks.value = modelData.rollbacks || [];
  specReconciliations.value = reconciliationData;
}

async function optionalResearchGet(path, fallback) {
  try {
    const { data } = await api.get(path);
    return data ?? fallback;
  } catch {
    return fallback;
  }
}

function showDataQuality(report) {
  specDetail.value = {
    type: 'data quality',
    dataset_version: report.dataset_version,
    status: report.status,
    critical: Boolean(report.critical),
    metrics: report.metrics,
    warnings: report.warnings,
  };
}

async function loadSafeRunDetail(type) {
  const runId = safeMvpResult.value?.run_id;
  if (!runId) return;
  const endpoints = {
    risk: `/research/spec-risk-checks/${runId}`,
    paper: `/research/spec-paper-intents/${runId}`,
    audit: `/research/spec-audit/${runId}`,
  };
  error.value = '';
  try {
    const { data } = await api.get(endpoints[type]);
    specDetail.value = {
      type,
      run_id: runId,
      count: data.length,
      sample: data.slice(0, 8),
    };
  } catch (err) {
    error.value = err.response?.data?.error || 'Safe run drill-down failed';
  }
}

async function rollbackModel(modelVersion) {
  error.value = '';
  try {
    const { data } = await api.post(`/research/spec-models/${modelVersion}/rollback`, {
      reason: 'Operator rollback from Research Desk.',
    });
    specDetail.value = {
      type: 'model rollback',
      model_version: data.model_version,
      status: data.status,
      approved_by: data.approved_by,
      promotion_report: data.promotionReport,
    };
    await load();
  } catch (err) {
    error.value = err.response?.data?.error || 'Model rollback failed';
  }
}

async function loadBacktestEvents(runId) {
  error.value = '';
  try {
    const { data } = await api.get(`/research/safe-mvp/backtests/${runId}/events`);
    specDetail.value = {
      type: 'backtest events',
      run_id: runId,
      event_count: data.length,
      latest_event: data.at(-1)?.event_type || 'none',
      sample: data.slice(0, 6).map((event) => `${event.event_type}:${event.symbol || 'portfolio'}`),
    };
  } catch (err) {
    error.value = err.response?.data?.error || 'Backtest event drill-down failed';
  }
}

async function loadReconciliation(runId) {
  error.value = '';
  try {
    const { data } = await api.get(`/research/spec-reconciliations/${runId}`);
    specDetail.value = {
      type: 'reconciliation',
      run_id: runId,
      status: data.status,
      summary: data.summary,
      differences: data.differences?.slice(0, 6) || [],
    };
  } catch (err) {
    error.value = err.response?.data?.error || 'Reconciliation drill-down failed';
  }
}

async function runSafeMvp() {
  error.value = '';
  running.value = 'safe-mvp';
  try {
    const { data } = await api.post('/research/safe-mvp');
    safeMvpResult.value = data;
    await load();
  } catch (err) {
    error.value = err.response?.data?.error || 'SPEC safe MVP failed';
  } finally {
    running.value = false;
  }
}

async function runEvaluation() {
  error.value = '';
  running.value = 'evaluation';
  try {
    await api.post('/research/evaluate');
    await load();
  } catch (err) {
    error.value = err.response?.data?.error || 'Evaluation run failed';
  } finally {
    running.value = false;
  }
}

async function collectProcess() {
  error.value = '';
  selectedRun.value = null;
  terminalOpen.value = true;
  try {
    const { data } = await api.post('/research/collect-process');
    activeRun.value = data;
    selectedRun.value = data;
    startPolling(data.id);
  } catch (err) {
    error.value = err.response?.data?.error || err.message || 'Autonomous research run failed to start';
  }
}

async function runResearchOnly() {
  error.value = '';
  running.value = 'research';
  try {
    await api.post('/research/run-research-only');
    await load();
  } catch (err) {
    error.value = err.response?.data?.error || 'Research run failed';
  } finally {
    running.value = false;
  }
}

function startPolling(runId) {
  clearPolling();
  pollTimer = window.setInterval(async () => {
    try {
      const { data } = await api.get(`/research/runs/${runId}`);
      activeRun.value = data;
      if (!selectedRun.value || selectedRun.value.id === data.id) selectedRun.value = data;
      if (!['queued', 'running'].includes(data.status)) {
        clearPolling();
        await load();
      }
    } catch (err) {
      clearPolling();
      error.value = formatApiError(err, 'Research status polling failed');
    }
  }, 1400);
}

function clearPolling() {
  if (pollTimer) window.clearInterval(pollTimer);
  pollTimer = null;
}

function selectRun(run) {
  selectedRun.value = run;
  terminalOpen.value = true;
}

onMounted(load);
onUnmounted(() => {
  clearPolling();
  window.removeEventListener('pointermove', onResearchWindowDrag);
});

function startResearchWindowDrag(event, windowKey) {
  if (event.target?.closest?.('button')) return;
  researchWindowDrag = {
    windowKey,
    startX: event.clientX,
    startY: event.clientY,
    originX: researchWindowPositions.value[windowKey].x,
    originY: researchWindowPositions.value[windowKey].y,
  };
  window.addEventListener('pointermove', onResearchWindowDrag);
  window.addEventListener('pointerup', stopResearchWindowDrag, { once: true });
}

function onResearchWindowDrag(event) {
  if (!researchWindowDrag) return;
  const { windowKey, startX, startY, originX, originY } = researchWindowDrag;
  researchWindowPositions.value = {
    ...researchWindowPositions.value,
    [windowKey]: {
      x: originX + event.clientX - startX,
      y: originY + event.clientY - startY,
    },
  };
}

function stopResearchWindowDrag() {
  researchWindowDrag = null;
  window.removeEventListener('pointermove', onResearchWindowDrag);
}

function evidenceLine(action) {
  const evidence = action.evidence;
  if (!evidence) return 'No matching research signal was attached.';
  const change = evidence.changePct >= 0 ? `+${evidence.changePct}` : evidence.changePct;
  const score = evidence.localAiScore ? ` · score ${evidence.localAiScore}` : '';
  return `$${fmt(evidence.price)} · ${change}% · ${evidence.volatilityPct}% range · ${evidence.momentum}${score}`;
}

function historicalWatchLine(action) {
  const factors = action.evidence?.historicalWatchFactors || [];
  if (!factors.length) return '';
  return factors
    .slice(0, 3)
    .map((factor) => {
      if (factor.key === 'fiveYearSplitActivity') return `${factor.label}: ${factor.stockSplitsPast5Years || 0}`;
      return `${factor.label}: ${factor.score}`;
    })
    .join(' · ');
}

function fmt(value) {
  return Number(value ?? 0).toFixed(2);
}

function pct(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

function timeOnly(value) {
  return value ? new Date(value).toLocaleTimeString() : '';
}

function compact(value) {
  const text = JSON.stringify(value);
  return text.length > 180 ? `${text.slice(0, 180)}...` : text;
}

function formatApiError(err, fallback) {
  const message = err.response?.data?.error || err.message || fallback;
  return message === 'Not found' ? fallback : message;
}

function snapshotCount(modelVersion) {
  return specTrainingSnapshots.value.filter((snapshot) => snapshot.model_version === modelVersion).length;
}

function sellScore(signal) {
  const local = Number(signal?.localAiScore ?? 50);
  const change = Number(signal?.changePct || 0);
  const volatility = Number(signal?.volatilityPct || 0);
  const explicit = ['sell-or-avoid', 'sell-candidate', 'avoid'].includes(signal?.actionBias) ? 24 : 0;
  const downside = change < 0 ? Math.abs(change) * 5 : 0;
  return Math.round(Math.max(0, 100 - local + downside + volatility * 2 + explicit));
}
</script>
