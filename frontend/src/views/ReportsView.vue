<template>
  <div class="page-shell">
    <div class="ops-command-bar reports-command-bar mb-6">
      <div class="min-w-0">
        <p class="page-kicker mb-3">Decision reports, daily self-evaluations, and source-learning adjustments</p>
        <h1 class="page-title">Reports</h1>
      </div>
      <div class="reports-command-actions mini-glass">
        <div class="text-xs uppercase text-white/40">report windows</div>
        <button class="hud-window-toggle" :class="{ active: decisionReportsOpen }" @click="decisionReportsOpen = !decisionReportsOpen">
          <v-icon size="15">mdi-file-chart-outline</v-icon>
          decision reports
        </button>
      </div>
    </div>

    <div v-if="error" class="glass-panel p-4 text-danger text-sm mb-5">{{ error }}</div>

    <div class="bento-grid stagger mb-5">
      <GlassCard title="Accuracy & confidence over time" class="bento-span-6">
        <div v-if="!evaluations.length" class="text-white/42 text-sm">No evaluation history yet.</div>
        <HudAreaChart
          v-else
          :labels="accuracyTrend.labels"
          :series="accuracyTrend.series"
          value-suffix="%"
          aria-label="Accuracy and confidence trend"
        />
      </GlassCard>

      <GlassCard title="Win rate by symbol" class="bento-span-3">
        <div v-if="!winRateBySymbol.labels.length" class="text-white/42 text-sm">No graded actions yet.</div>
        <HudBarChart
          v-else
          :labels="winRateBySymbol.labels"
          :values="winRateBySymbol.values"
          dataset-label="Win rate"
          value-suffix="%"
          aria-label="Win rate by symbol"
        />
      </GlassCard>

      <GlassCard title="Action distribution" class="bento-span-3">
        <div v-if="!actionDistribution.labels.length" class="text-white/42 text-sm">No decisions yet.</div>
        <HudDoughnutChart
          v-else
          :labels="actionDistribution.labels"
          :values="actionDistribution.values"
          :center-value="String(actionDistribution.total)"
          center-label="decisions"
        />
      </GlassCard>
    </div>

    <div class="bento-grid stagger mb-5">
      <GlassCard title="90-Day Outlook" class="bento-span-12">
        <div class="flex items-center gap-3 mb-4">
          <input
            v-model="forecastSymbol"
            class="forecast-symbol-input"
            placeholder="Symbol (e.g. AAPL)"
            @keyup.enter="loadForecast"
          />
          <GlassButton :disabled="loadingForecast || !forecastSymbol" @click="loadForecast">
            {{ loadingForecast ? 'Forecasting...' : 'Run forecast' }}
          </GlassButton>
          <span v-if="forecastError" class="text-danger text-sm">{{ forecastError }}</span>
        </div>
        <div v-if="!forecast" class="text-white/42 text-sm">Enter a symbol to generate a 90-day LSTM forecast.</div>
        <template v-else>
          <div class="hud-stat-grid mb-4">
            <div class="hud-stat">
              <strong>${{ forecast.days[forecast.days.length - 1].p50.toFixed(2) }}</strong>
              <span>median day-90 price</span>
            </div>
            <div class="hud-stat">
              <strong>${{ forecast.days[forecast.days.length - 1].p10.toFixed(2) }} - ${{ forecast.days[forecast.days.length - 1].p90.toFixed(2) }}</strong>
              <span>p10-p90 range</span>
            </div>
          </div>
          <HudForecastChart
            :labels="forecastLabels"
            :p10="forecast.days.map((d) => d.p10)"
            :p50="forecast.days.map((d) => d.p50)"
            :p90="forecast.days.map((d) => d.p90)"
            :aria-label="`${forecast.symbol} 90 day forecast`"
          />
        </template>
      </GlassCard>
    </div>

    <div class="bento-grid stagger mb-5">
      <GlassCard title="Alpaca invoices/statements" class="bento-span-12">
        <div class="alpaca-doc-controls mini-glass mb-4">
          <v-text-field
            v-model="alpacaDocumentQuery.search"
            label="Search documents"
            prepend-inner-icon="mdi-magnify"
            variant="outlined"
            density="compact"
            hide-details
            @keyup.enter="applyAlpacaDocumentQuery"
          />
          <v-select
            v-model="alpacaDocumentQuery.documentType"
            :items="alpacaDocumentTypes"
            label="Type"
            variant="outlined"
            density="compact"
            hide-details
            @update:model-value="applyAlpacaDocumentQuery"
          />
          <v-select
            v-model="alpacaDocumentQuery.sortBy"
            :items="alpacaDocumentSortItems"
            label="Sort"
            variant="outlined"
            density="compact"
            hide-details
            @update:model-value="loadAlpacaDocuments"
          />
          <button class="hud-chip hud-chip-button" @click="toggleAlpacaDocumentSort">
            <v-icon size="15">{{ alpacaDocumentQuery.sortDir === 'asc' ? 'mdi-sort-ascending' : 'mdi-sort-descending' }}</v-icon>
            {{ alpacaDocumentQuery.sortDir }}
          </button>
          <GlassButton :disabled="syncingAlpacaDocuments" @click="syncAlpacaDocuments">
            {{ syncingAlpacaDocuments ? 'Syncing...' : 'Sync now' }}
          </GlassButton>
        </div>
        <div v-if="alpacaDocumentError" class="text-danger text-sm mb-3">{{ alpacaDocumentError }}</div>
        <div class="source-memory-summary mb-3">
          <span>{{ alpacaDocumentPager.total }} documents</span>
          <span>page {{ alpacaDocumentPager.page }} / {{ alpacaDocumentPager.totalPages }}</span>
        </div>
        <div v-if="!alpacaDocuments.length" class="mini-glass p-4 text-white/42 text-sm">
          No Alpaca account documents synced yet. Configure Alpaca Broker API details in Settings, then sync.
        </div>
        <div v-else class="alpaca-doc-list">
          <div v-for="document in alpacaDocuments" :key="document.id" class="alpaca-doc-row mini-glass">
            <div class="min-w-0">
              <div class="font-headline text-white/85 truncate">{{ document.name || document.document_id }}</div>
              <div class="hud-card-meta">
                <span class="hud-chip">{{ document.document_type }}</span>
                <span class="hud-chip">{{ document.document_date || 'undated' }}</span>
                <span class="hud-chip">{{ document.status }}</span>
                <span class="hud-chip">downloaded {{ formatDate(document.downloaded_at) }}</span>
              </div>
            </div>
            <button class="hud-window-toggle" title="Download Alpaca document" @click="downloadAlpacaDocument(document)">
              <v-icon size="15">mdi-download</v-icon>
              download
            </button>
          </div>
        </div>
        <div class="source-pagination mt-4">
          <v-select
            v-model="alpacaDocumentQuery.pageSize"
            :items="[5, 10, 25, 50]"
            label="Rows"
            variant="outlined"
            density="compact"
            hide-details
            class="source-page-size"
            @update:model-value="applyAlpacaDocumentQuery"
          />
          <button class="hud-chip hud-chip-button" :disabled="alpacaDocumentPager.page <= 1" @click="changeAlpacaDocumentPage(-1)">
            <v-icon size="15">mdi-chevron-left</v-icon>
            previous
          </button>
          <button class="hud-chip hud-chip-button" :disabled="alpacaDocumentPager.page >= alpacaDocumentPager.totalPages" @click="changeAlpacaDocumentPage(1)">
            next
            <v-icon size="15">mdi-chevron-right</v-icon>
          </button>
        </div>
      </GlassCard>
    </div>

    <div class="bento-grid stagger">
      <GlassCard title="Evaluation reports" class="bento-span-5">
        <div class="flex items-center gap-3 mb-4">
          <GlassButton :disabled="runningEvaluation" @click="runEvaluation">
            {{ runningEvaluation ? 'Running...' : 'Run evaluation' }}
          </GlassButton>
        </div>
        <div v-if="!evaluations.length" class="text-white/42 text-sm">No evaluation reports yet.</div>
        <div v-else class="report-list">
          <button
            v-for="report in evaluations"
            :key="report.id"
            class="report-list-row mini-glass"
            :class="selectedEvaluation?.id === report.id ? 'active' : ''"
            @click="selectedEvaluation = report"
          >
            <span>
              <strong>{{ report.report_date }}</strong>
              <small>{{ report.summary.evaluatedActions }} actions · {{ report.summary.accuracy }}% accuracy</small>
            </span>
            <span>{{ report.summary.neuralConfidence }}%</span>
          </button>
        </div>
      </GlassCard>

      <GlassCard title="Evaluation detail" class="bento-span-7">
        <div v-if="!selectedEvaluation" class="text-white/42 text-sm">Select an evaluation report.</div>
        <div v-else class="evaluation-detail">
          <div class="hud-stat-grid mb-5">
            <div class="hud-stat">
              <strong>{{ selectedEvaluation.summary.accuracy }}%</strong>
              <span>accuracy</span>
            </div>
            <div class="hud-stat">
              <strong>{{ selectedEvaluation.summary.avgObservedReturnPct }}%</strong>
              <span>avg observed return</span>
            </div>
            <div class="hud-stat">
              <strong>{{ selectedEvaluation.summary.neuralConfidence }}%</strong>
              <span>brain confidence</span>
            </div>
          </div>
          <p class="text-white/68 text-sm leading-6 mb-4">{{ selectedEvaluation.summary.selfAssessment }}</p>
          <p class="text-white/48 text-sm leading-6 mb-4">{{ selectedEvaluation.summary.brokerMindset }}</p>
          <div class="flex flex-col gap-2 mb-5">
            <div v-for="item in selectedEvaluation.summary.recommendedAdjustments" :key="item" class="mini-glass p-3 text-sm text-white/65">
              {{ item }}
            </div>
          </div>
          <div class="decision-table">
            <div
              v-for="decision in selectedEvaluation.summary.decisions.slice(0, 6)"
              :key="decision.decisionReportId"
              class="mini-glass p-4"
            >
              <div class="flex flex-wrap items-center justify-between gap-3 mb-3">
                <span class="font-headline">Decision #{{ decision.decisionReportId }}</span>
                <span class="hud-chip">{{ decision.accuracy }}% accurate</span>
              </div>
              <div v-for="action in decision.actionEvaluations" :key="`${decision.decisionReportId}-${action.symbol}`" class="report-action-row">
                <strong :class="action.outcome === 'correct' ? 'text-accent' : action.outcome === 'incorrect' ? 'text-danger' : 'text-warn'">
                  {{ action.outcome }}
                </strong>
                <span>{{ action.action }} {{ action.symbol }}</span>
                <small>{{ action.startPrice }} -> {{ action.endPrice }} · {{ action.returnPct }}%</small>
              </div>
            </div>
          </div>
        </div>
      </GlassCard>

    </div>

    <aside
      v-if="decisionReportsOpen"
      class="floating-glass-window floating-reports-window floating-decision-reports-window"
      :style="{ transform: `translate(${decisionReportsWindowPosition.x}px, ${decisionReportsWindowPosition.y}px)` }"
    >
      <div class="floating-window-head movable-head" @pointerdown="startDecisionReportsDrag">
        <span>
          decision reports
          <small>{{ decisionReports.length }} records</small>
        </span>
        <button @click.stop="decisionReportsOpen = false"><v-icon size="16">mdi-close</v-icon></button>
      </div>
      <div class="floating-window-body">
        <div v-if="!decisionReports.length" class="text-white/42 text-sm">No decision reports yet.</div>
        <div v-else class="decision-report-grid">
          <div v-for="report in decisionReports" :key="report.id" class="mini-glass p-4">
            <div class="flex flex-wrap items-center justify-between gap-3 mb-3">
              <div>
                <div class="font-headline">Report #{{ report.id }}</div>
                <div class="text-xs text-white/38">{{ report.created_at }}</div>
              </div>
              <span class="hud-chip">{{ report.mode }}</span>
            </div>
            <p class="text-white/55 text-sm mb-3">{{ report.summary?.researchNarrative?.summary || report.summary?.overallRationale }}</p>
            <div class="flex flex-col gap-2">
              <div v-for="action in report.summary.actions.slice(0, 5)" :key="`${report.id}-${action.symbol}`" class="report-action-row">
                <strong :class="action.action === 'buy' ? 'text-accent' : action.action === 'sell' ? 'text-danger' : 'text-white/55'">
                  {{ action.action }}
                </strong>
                <span>{{ action.symbol }}</span>
                <small>{{ action.status }} · score {{ action.evidence?.localAiScore || 'n/a' }}</small>
              </div>
            </div>
          </div>
        </div>
      </div>
    </aside>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import api from '../api/client';
import GlassCard from '../components/GlassCard.vue';
import GlassButton from '../components/GlassButton.vue';
import HudAreaChart from '../components/HudAreaChart.vue';
import HudBarChart from '../components/HudBarChart.vue';
import HudDoughnutChart from '../components/HudDoughnutChart.vue';
import HudForecastChart from '../components/HudForecastChart.vue';

const decisionReports = ref([]);
const evaluations = ref([]);
const selectedEvaluationId = ref(null);
const error = ref('');
const runningEvaluation = ref(false);
const forecastSymbol = ref('');
const forecast = ref(null);
const forecastError = ref('');
const loadingForecast = ref(false);
const decisionReportsOpen = ref(false);
const decisionReportsWindowPosition = ref({ x: 0, y: 0 });
const decisionReportsDrag = ref(null);
const alpacaDocuments = ref([]);
const alpacaDocumentPager = ref({ total: 0, page: 1, pageSize: 5, totalPages: 1 });
const alpacaDocumentQuery = ref({
  page: 1,
  pageSize: 5,
  search: '',
  documentType: '',
  sortBy: 'document_date',
  sortDir: 'desc',
});
const alpacaDocumentError = ref('');
const syncingAlpacaDocuments = ref(false);
const alpacaDocumentTypes = [
  { title: 'All documents', value: '' },
  { title: 'Account statements', value: 'account_statement' },
  { title: 'Crypto statements', value: 'crypto_account_statement' },
  { title: 'Tax statements', value: 'tax_statement' },
  { title: 'Trade confirmations', value: 'trade_confirmation' },
  { title: 'Trade confirmations JSON', value: 'trade_confirmation_json' },
];
const alpacaDocumentSortItems = [
  { title: 'Document date', value: 'document_date' },
  { title: 'Type', value: 'document_type' },
  { title: 'Name', value: 'name' },
  { title: 'Status', value: 'status' },
  { title: 'Downloaded', value: 'downloaded_at' },
  { title: 'Last updated', value: 'updated_at' },
];

const forecastLabels = computed(() => (forecast.value?.days || []).map((d) => `D${d.day}`));

async function loadForecast() {
  if (!forecastSymbol.value) return;
  forecastError.value = '';
  loadingForecast.value = true;
  try {
    const { data } = await api.get(`/research/forecast/${forecastSymbol.value.trim().toUpperCase()}`);
    forecast.value = data;
  } catch (err) {
    forecastError.value = err.response?.data?.error || 'Forecast generation failed';
  } finally {
    loadingForecast.value = false;
  }
}

const selectedEvaluation = computed({
  get() {
    return evaluations.value.find((report) => report.id === selectedEvaluationId.value) || evaluations.value[0] || null;
  },
  set(report) {
    selectedEvaluationId.value = report?.id || null;
  },
});

async function load() {
  const [decisionRes, evaluationRes] = await Promise.all([
    api.get('/research/reports?limit=50'),
    api.get('/research/evaluations?limit=50'),
    loadAlpacaDocuments(),
  ]);
  decisionReports.value = decisionRes.data;
  evaluations.value = evaluationRes.data;
}

async function loadAlpacaDocuments() {
  alpacaDocumentError.value = '';
  try {
    const { data } = await api.get('/research/alpaca-documents', {
      params: {
        ...alpacaDocumentQuery.value,
        search: alpacaDocumentQuery.value.search || undefined,
        documentType: alpacaDocumentQuery.value.documentType || undefined,
      },
    });
    alpacaDocuments.value = data.items || [];
    alpacaDocumentPager.value = {
      total: data.total || 0,
      page: data.page || 1,
      pageSize: data.pageSize || alpacaDocumentQuery.value.pageSize,
      totalPages: data.totalPages || 1,
    };
    alpacaDocumentQuery.value.page = alpacaDocumentPager.value.page;
    alpacaDocumentQuery.value.pageSize = alpacaDocumentPager.value.pageSize;
  } catch (err) {
    alpacaDocumentError.value = err.response?.data?.error || 'Alpaca document load failed';
  }
}

function applyAlpacaDocumentQuery() {
  alpacaDocumentQuery.value.page = 1;
  loadAlpacaDocuments();
}

function toggleAlpacaDocumentSort() {
  alpacaDocumentQuery.value.sortDir = alpacaDocumentQuery.value.sortDir === 'asc' ? 'desc' : 'asc';
  loadAlpacaDocuments();
}

function changeAlpacaDocumentPage(delta) {
  const next = Math.min(alpacaDocumentPager.value.totalPages, Math.max(1, alpacaDocumentQuery.value.page + delta));
  if (next === alpacaDocumentQuery.value.page) return;
  alpacaDocumentQuery.value.page = next;
  loadAlpacaDocuments();
}

async function syncAlpacaDocuments() {
  alpacaDocumentError.value = '';
  syncingAlpacaDocuments.value = true;
  try {
    const { data } = await api.post('/research/alpaca-documents/sync');
    if (data.skipped) alpacaDocumentError.value = data.reason;
    await loadAlpacaDocuments();
  } catch (err) {
    alpacaDocumentError.value = err.response?.data?.error || 'Alpaca document sync failed';
  } finally {
    syncingAlpacaDocuments.value = false;
  }
}

async function downloadAlpacaDocument(document) {
  alpacaDocumentError.value = '';
  try {
    const { data } = await api.get(`/research/alpaca-documents/${document.id}/download`);
    if (!data.url) throw new Error('No download URL returned.');
    window.open(data.url, '_blank', 'noopener,noreferrer');
    await loadAlpacaDocuments();
  } catch (err) {
    alpacaDocumentError.value = err.response?.data?.error || err.message || 'Alpaca document download failed';
  }
}

async function runEvaluation() {
  error.value = '';
  runningEvaluation.value = true;
  try {
    const { data } = await api.post('/research/evaluate');
    await load();
    selectedEvaluationId.value = data.id;
  } catch (err) {
    error.value = err.response?.data?.error || 'Evaluation run failed';
  } finally {
    runningEvaluation.value = false;
  }
}

function startDecisionReportsDrag(event) {
  if (event.target?.closest?.('button')) return;
  decisionReportsDrag.value = {
    startX: event.clientX,
    startY: event.clientY,
    originX: decisionReportsWindowPosition.value.x,
    originY: decisionReportsWindowPosition.value.y,
  };
  window.addEventListener('pointermove', moveDecisionReports);
  window.addEventListener('pointerup', stopDecisionReportsDrag, { once: true });
}

function moveDecisionReports(event) {
  if (!decisionReportsDrag.value) return;
  decisionReportsWindowPosition.value = {
    x: decisionReportsDrag.value.originX + event.clientX - decisionReportsDrag.value.startX,
    y: decisionReportsDrag.value.originY + event.clientY - decisionReportsDrag.value.startY,
  };
}

function stopDecisionReportsDrag() {
  decisionReportsDrag.value = null;
  window.removeEventListener('pointermove', moveDecisionReports);
}

function formatDate(value) {
  if (!value) return 'never';
  return new Date(value).toLocaleDateString();
}

const accuracyTrend = computed(() => {
  const sorted = [...evaluations.value].sort((a, b) => new Date(a.report_date) - new Date(b.report_date));
  return {
    labels: sorted.map((r) => new Date(r.report_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })),
    series: [
      { label: 'Accuracy', values: sorted.map((r) => Number(r.summary?.accuracy || 0)), color: '#1ed6ff' },
      { label: 'Confidence', values: sorted.map((r) => Number(r.summary?.neuralConfidence || 0)), color: '#7c5cff' },
    ],
  };
});

const winRateBySymbol = computed(() => {
  const bySymbol = {};
  for (const evaluation of evaluations.value) {
    for (const decision of evaluation.summary?.decisions || []) {
      for (const action of decision.actionEvaluations || []) {
        if (!action.symbol) continue;
        bySymbol[action.symbol] = bySymbol[action.symbol] || { correct: 0, total: 0 };
        bySymbol[action.symbol].total += 1;
        if (action.outcome === 'correct') bySymbol[action.symbol].correct += 1;
      }
    }
  }
  const symbols = Object.keys(bySymbol).sort((a, b) => bySymbol[b].total - bySymbol[a].total).slice(0, 8);
  return {
    labels: symbols,
    values: symbols.map((s) => Math.round((bySymbol[s].correct / bySymbol[s].total) * 100)),
  };
});

const actionDistribution = computed(() => {
  const counts = { buy: 0, sell: 0, hold: 0 };
  for (const report of decisionReports.value) {
    for (const action of report.summary?.actions || []) {
      const key = (action.action || '').toLowerCase();
      if (counts[key] !== undefined) counts[key] += 1;
    }
  }
  const labels = Object.keys(counts).filter((k) => counts[k] > 0);
  return {
    labels,
    values: labels.map((k) => counts[k]),
    total: labels.reduce((sum, k) => sum + counts[k], 0),
  };
});

onMounted(load);
onUnmounted(() => {
  window.removeEventListener('pointermove', moveDecisionReports);
});
</script>
