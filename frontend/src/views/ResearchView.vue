<template>
  <div class="page-shell research-desk">
    <div class="research-hero mb-7">
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
        <div v-if="!latestSignals.length" class="text-white/42 text-sm">No scored candidates yet.</div>
        <div v-else class="candidate-grid">
          <div v-for="s in latestSignals.slice(0, 6)" :key="s.symbol" class="candidate-card mini-glass">
            <div class="flex items-start justify-between gap-3">
              <div>
                <div class="font-headline text-lg">{{ s.symbol }}</div>
                <div class="text-xs text-white/40">{{ s.theme || 'watchlist' }}</div>
              </div>
              <div class="score-ring" :style="{ '--score': `${s.localAiScore || 0}%` }">
                <span>{{ s.localAiScore || 'n/a' }}</span>
              </div>
            </div>
            <div class="flex items-end justify-between mt-5">
              <div>
                <div class="font-headline text-2xl" :class="s.changePct >= 0 ? 'text-accent' : 'text-danger'">
                  {{ s.changePct >= 0 ? '+' : '' }}{{ s.changePct }}%
                </div>
                <div class="text-xs text-white/40">${{ fmt(s.price) }} · {{ s.volatilityPct }}% range</div>
              </div>
              <span class="hud-chip">{{ s.actionBias || s.momentum }}</span>
            </div>
          </div>
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
    </div>

    <div class="bento-grid stagger">
      <GlassCard title="Research runs" class="bento-span-5">
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
      </GlassCard>

      <GlassCard title="Plan history" class="bento-span-7">
        <div v-if="!plans.length" class="text-white/42 text-sm">No trading plans yet.</div>
        <div v-else class="flex flex-col gap-3">
          <div v-for="plan in plans.slice(0, 6)" :key="plan.id" class="mini-glass p-4">
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
const activeRun = ref(null);
const selectedRun = ref(null);
const terminalOpen = ref(false);
const sourcesOpen = ref(false);
const decisionOpen = ref(false);
const running = ref(false);
const error = ref('');
let pollTimer = null;

const latestSignals = computed(() => snapshots.value[0]?.signals || []);
const latestReport = computed(() => reports.value[0] || null);
const latestEvaluation = computed(() => evaluations.value[0] || null);
const sourceStack = computed(() => latestReport.value?.summary?.sourceStack || snapshots.value[0]?.summary?.sourceStack || []);
const isBusy = computed(() => ['queued', 'running'].includes(activeRun.value?.status) || Boolean(running.value));
const terminalRun = computed(() => selectedRun.value || activeRun.value);

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
  if (!activeRun.value) {
    const current = runs.value.find((run) => ['queued', 'running'].includes(run.status));
    if (current) startPolling(current.id);
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
      error.value = err.response?.data?.error || 'Research status polling failed';
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
onUnmounted(clearPolling);

function evidenceLine(action) {
  const evidence = action.evidence;
  if (!evidence) return 'No matching research signal was attached.';
  const change = evidence.changePct >= 0 ? `+${evidence.changePct}` : evidence.changePct;
  const score = evidence.localAiScore ? ` · score ${evidence.localAiScore}` : '';
  return `$${fmt(evidence.price)} · ${change}% · ${evidence.volatilityPct}% range · ${evidence.momentum}${score}`;
}

function fmt(value) {
  return Number(value ?? 0).toFixed(2);
}

function timeOnly(value) {
  return value ? new Date(value).toLocaleTimeString() : '';
}

function compact(value) {
  const text = JSON.stringify(value);
  return text.length > 180 ? `${text.slice(0, 180)}...` : text;
}
</script>
