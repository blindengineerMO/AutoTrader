<template>
  <div class="page-shell watcher-desk">
    <div class="workspace-hero ops-command-bar mb-6">
      <div class="min-w-0">
        <p class="page-kicker mb-3">Per-symbol watcher agents, 4x/day research cadence, and upstream praise/punish grading</p>
        <h1 class="page-title">Watcher Agents</h1>
        <p class="page-copy mt-4 max-w-3xl">
          Every symbol the Brain discovers gets a dedicated watcher that re-researches it through the trading day, reports into the
          top-level research agent over BrainMesh, and is graded praise or punish against the day's close.
        </p>
      </div>
      <div class="mini-glass workspace-command">
        <div class="text-xs uppercase text-white/40">watcher roster</div>
        <div class="font-headline text-3xl text-accent">{{ agents.length }}</div>
        <div class="text-xs text-white/40">{{ priorityCount }} sub-$20 priority · {{ standardCount }} standard</div>
        <div class="mt-5 flex flex-wrap gap-2">
          <GlassButton :disabled="loading" @click="load">
            <v-icon size="16" class="mr-1">mdi-refresh</v-icon>
            {{ loading ? 'Refreshing...' : 'Refresh roster' }}
          </GlassButton>
          <GlassButton variant="ghost" :disabled="backfillBusy || !agents.length" @click="runTrainingBackfill">
            <v-icon size="16" class="mr-1">mdi-database-clock-outline</v-icon>
            {{ backfillBusy ? 'Training...' : 'Backfill 30d' }}
          </GlassButton>
        </div>
        <div v-if="backfillStatus" class="text-xs text-white/50 mt-3">{{ backfillStatus }}</div>
      </div>
    </div>

    <div v-if="error" class="glass-panel p-4 text-danger text-sm mb-5">{{ error }}</div>

    <div class="bento-grid stagger">
      <GlassCard title="Watcher Roster" class="bento-span-4">
        <div v-if="!agents.length" class="text-white/42 text-sm">
          No watcher agents yet. Watchers are created automatically as the Brain discovers and researches symbols.
        </div>
        <div v-else>
          <div class="watcher-roster-controls mini-glass mb-3">
            <v-text-field
              v-model="watcherQuery"
              label="Search watchers"
              prepend-inner-icon="mdi-magnify"
              variant="outlined"
              density="compact"
              hide-details
            />
            <v-select
              v-model="watcherTierFilter"
              :items="watcherTierItems"
              label="Tier"
              variant="outlined"
              density="compact"
              hide-details
            />
            <v-select
              v-model="watcherSortBy"
              :items="watcherSortItems"
              label="Sort"
              variant="outlined"
              density="compact"
              hide-details
            />
            <button class="hud-chip hud-chip-button" @click="toggleWatcherSort">
              <v-icon size="15">{{ watcherSortDir === 'asc' ? 'mdi-sort-ascending' : 'mdi-sort-descending' }}</v-icon>
              {{ watcherSortDir }}
            </button>
          </div>

          <div class="watcher-roster-summary mb-3">
            <span>{{ watcherPager.total }} watchers</span>
            <span>{{ watcherPager.start }}-{{ watcherPager.end }} visible</span>
            <span>page {{ watcherPager.current }} / {{ watcherPager.totalPages }}</span>
          </div>

          <div class="company-memory-list">
            <div v-if="!paginatedWatchers.length" class="empty-dense">No watcher agents match the current controls.</div>
            <button
              v-for="agent in paginatedWatchers"
              :key="agent.id"
              class="company-memory-row mini-glass"
              :class="selectedSymbol === agent.symbol ? 'active' : ''"
              @click="selectedSymbol = agent.symbol"
            >
              <span class="company-symbol">{{ agent.symbol }}</span>
              <span class="min-w-0">
                <strong>{{ agent.companyName || agent.symbol }}</strong>
                <small>
                  <span class="hud-chip">{{ agent.priceTier }}</span>
                  last run {{ agent.lastResearchedAt ? dateOnly(agent.lastResearchedAt) : 'never' }}
                </small>
              </span>
              <span class="workspace-score" :style="{ '--score': `${ratioPct(agent.scorecard)}%` }">
                {{ ratioLabel(agent.scorecard) }}
              </span>
            </button>
          </div>

          <div class="watcher-roster-pagination mt-3">
            <v-select
              v-model="watcherPageSize"
              :items="[10, 25, 50]"
              label="Rows"
              variant="outlined"
              density="compact"
              hide-details
              class="watcher-page-size"
            />
            <button class="hud-window-toggle" :disabled="watcherPage <= 1" @click="watcherPage -= 1">
              <v-icon size="15">mdi-chevron-left</v-icon>
              prev
            </button>
            <button
              class="hud-window-toggle"
              :disabled="watcherPage >= watcherPager.totalPages"
              @click="watcherPage += 1"
            >
              next
              <v-icon size="15">mdi-chevron-right</v-icon>
            </button>
          </div>
        </div>
      </GlassCard>

      <GlassCard title="Watcher Detail" class="bento-span-8">
        <div v-if="!detail" class="text-white/42 text-sm">Select a watcher agent to inspect its research, grades, and BrainMesh chatter.</div>
        <div v-else>
          <div class="flex flex-wrap items-start justify-between gap-4 mb-5">
            <div>
              <div class="font-headline text-2xl text-accent">{{ detail.symbol }}</div>
              <div class="text-xs text-white/42">{{ detail.companyName || detail.symbol }} · {{ detail.brainId }}</div>
            </div>
            <div class="flex flex-wrap gap-2">
              <span class="hud-chip">{{ detail.priceTier }}</span>
              <span class="hud-chip">{{ detail.status }}</span>
            </div>
          </div>

          <div class="workspace-metric-grid">
            <div class="workspace-metric mini-glass">
              <span>praised</span>
              <strong class="text-accent">{{ detail.scorecard.praiseCount }}</strong>
            </div>
            <div class="workspace-metric mini-glass">
              <span>punished</span>
              <strong class="text-danger">{{ detail.scorecard.punishCount }}</strong>
            </div>
            <div class="workspace-metric mini-glass">
              <span>total graded</span>
              <strong>{{ detail.scorecard.totalGraded }}</strong>
            </div>
            <div class="workspace-metric mini-glass">
              <span>praise ratio</span>
              <strong>{{ ratioLabel(detail.scorecard) }}</strong>
            </div>
          </div>

          <div class="mt-6">
            <div class="text-xs uppercase text-white/36 mb-3">recent research runs</div>
            <div v-if="!detail.researchRuns.length" class="text-white/42 text-sm">No research runs recorded yet.</div>
            <div v-else class="flex flex-col gap-3">
              <div class="watcher-roster-summary">
                <span>{{ researchRunPager.total }} runs</span>
                <span>{{ researchRunPager.start }}-{{ researchRunPager.end }} visible</span>
                <span>page {{ researchRunPager.current }} / {{ researchRunPager.totalPages }}</span>
              </div>
              <div v-for="run in paginatedResearchRuns" :key="run.id" class="run-row mini-glass">
                <span>
                  <strong>{{ run.predicted_action }} · ${{ fmt(run.price_at_research) }}</strong>
                  <small>{{ dateOnly(run.run_at) }} · score {{ run.local_ai_score }} · {{ run.graded ? 'graded' : 'ungraded' }}</small>
                </span>
                <span>{{ run.rationale?.theme || 'watcher' }}</span>
              </div>
              <div class="watcher-roster-pagination">
                <v-select
                  v-model="researchRunPageSize"
                  :items="[5, 10, 20]"
                  label="Rows"
                  variant="outlined"
                  density="compact"
                  hide-details
                  class="watcher-page-size"
                />
                <button class="hud-window-toggle" :disabled="researchRunPage <= 1" @click="researchRunPage -= 1">
                  <v-icon size="15">mdi-chevron-left</v-icon>
                  prev
                </button>
                <button
                  class="hud-window-toggle"
                  :disabled="researchRunPage >= researchRunPager.totalPages"
                  @click="researchRunPage += 1"
                >
                  next
                  <v-icon size="15">mdi-chevron-right</v-icon>
                </button>
              </div>
            </div>
          </div>

          <div class="mt-6">
            <div class="text-xs uppercase text-white/36 mb-3">grade history</div>
            <div v-if="!detail.grades.length" class="text-white/42 text-sm">No grades issued yet — grading runs after market close.</div>
            <div v-else class="flex flex-col gap-3">
              <div v-for="grade in detail.grades" :key="grade.id" class="run-row mini-glass">
                <span>
                  <strong :class="grade.verdict === 'praise' ? 'text-accent' : 'text-danger'">{{ grade.verdict }}</strong>
                  <small>{{ dateOnly(grade.graded_at) }} · {{ pct(grade.return_pct) }} move · predicted {{ grade.predicted_action }}</small>
                </span>
                <span>${{ fmt(grade.start_price) }} &rarr; ${{ fmt(grade.close_price) }}</span>
              </div>
            </div>
          </div>

          <div class="mt-6">
            <div class="text-xs uppercase text-white/36 mb-3">BrainMesh conversation</div>
            <div v-if="!detail.conversation.length" class="text-white/42 text-sm">No BrainMesh messages recorded yet.</div>
            <div v-else class="terminal-body mini-glass" style="max-height: 320px;">
              <div v-for="message in detail.conversation" :key="message.id" class="terminal-line">
                <span>{{ timeOnly(message.created_at) }}</span>
                <strong>{{ message.sender }} &rarr; {{ message.recipient }}</strong>
                <p>{{ message.op }}<code v-if="message.envelope?.body"> {{ compact(message.envelope.body) }}</code></p>
              </div>
            </div>
          </div>
        </div>
      </GlassCard>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import api from '../api/client';
import GlassCard from '../components/GlassCard.vue';
import GlassButton from '../components/GlassButton.vue';

const agents = ref([]);
const detail = ref(null);
const selectedSymbol = ref('');
const loading = ref(false);
const error = ref('');
const backfillBusy = ref(false);
const backfillStatus = ref('');
const watcherQuery = ref('');
const watcherTierFilter = ref('all');
const watcherSortBy = ref('symbol');
const watcherSortDir = ref('asc');
const watcherPage = ref(1);
const watcherPageSize = ref(10);
const researchRunPage = ref(1);
const researchRunPageSize = ref(5);

const watcherTierItems = [
  { title: 'All tiers', value: 'all' },
  { title: 'Priority', value: 'priority' },
  { title: 'Standard', value: 'standard' },
];

const watcherSortItems = [
  { title: 'Symbol', value: 'symbol' },
  { title: 'Company', value: 'company' },
  { title: 'Tier', value: 'tier' },
  { title: 'Praise ratio', value: 'ratio' },
  { title: 'Last run', value: 'lastRun' },
];

const priorityCount = computed(() => agents.value.filter((agent) => agent.priceTier === 'priority').length);
const standardCount = computed(() => agents.value.length - priorityCount.value);
const filteredWatchers = computed(() => {
  const query = watcherQuery.value.trim().toLowerCase();
  return agents.value.filter((agent) => {
    if (watcherTierFilter.value !== 'all' && agent.priceTier !== watcherTierFilter.value) return false;
    if (!query) return true;
    const haystack = [
      agent.symbol,
      agent.companyName,
      agent.priceTier,
      agent.status,
      agent.brainId,
    ].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(query);
  });
});

const sortedWatchers = computed(() => {
  const direction = watcherSortDir.value === 'asc' ? 1 : -1;
  return [...filteredWatchers.value].sort((a, b) => {
    const left = watcherSortValue(a, watcherSortBy.value);
    const right = watcherSortValue(b, watcherSortBy.value);
    if (typeof left === 'number' || typeof right === 'number') {
      return (Number(left || 0) - Number(right || 0)) * direction;
    }
    return String(left || '').localeCompare(String(right || '')) * direction;
  });
});

const watcherPager = computed(() => {
  const total = sortedWatchers.value.length;
  const size = Number(watcherPageSize.value) || 10;
  const totalPages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(watcherPage.value, totalPages);
  const start = total ? (current - 1) * size + 1 : 0;
  const end = Math.min(total, current * size);
  return { total, size, totalPages, current, start, end };
});

const paginatedWatchers = computed(() => {
  const pager = watcherPager.value;
  const start = (pager.current - 1) * pager.size;
  return sortedWatchers.value.slice(start, start + pager.size);
});

const researchRunPager = computed(() => {
  const total = detail.value?.researchRuns?.length || 0;
  const size = Number(researchRunPageSize.value) || 5;
  const totalPages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(researchRunPage.value, totalPages);
  const start = total ? (current - 1) * size + 1 : 0;
  const end = Math.min(total, current * size);
  return { total, size, totalPages, current, start, end };
});

const paginatedResearchRuns = computed(() => {
  const pager = researchRunPager.value;
  const start = (pager.current - 1) * pager.size;
  return (detail.value?.researchRuns || []).slice(start, start + pager.size);
});

async function load() {
  error.value = '';
  loading.value = true;
  try {
    const { data } = await api.get('/watcher-agents');
    agents.value = data;
    if (!selectedSymbol.value && agents.value.length) selectedSymbol.value = agents.value[0].symbol;
  } catch (err) {
    error.value = err.response?.data?.error || 'Unable to load watcher agents';
  } finally {
    loading.value = false;
  }
}

async function loadDetail(symbol) {
  if (!symbol) {
    detail.value = null;
    return;
  }
  try {
    const { data } = await api.get(`/watcher-agents/${symbol}`);
    detail.value = data;
    researchRunPage.value = 1;
  } catch (err) {
    error.value = err.response?.data?.error || 'Unable to load watcher agent detail';
  }
}

async function runTrainingBackfill() {
  error.value = '';
  backfillStatus.value = '';
  backfillBusy.value = true;
  try {
    const { data } = await api.post('/watcher-agents/training-backfill-30d');
    backfillStatus.value = data?.ran
      ? `30d backfill added ${data.generatedRuns || 0} runs and ${data.gradesCreated || 0} grades.`
      : `30d backfill skipped: ${data?.reason || 'no work available'}.`;
    await load();
    if (selectedSymbol.value) await loadDetail(selectedSymbol.value);
  } catch (err) {
    error.value = err.response?.data?.error || 'Unable to run 30-day watcher training backfill';
  } finally {
    backfillBusy.value = false;
  }
}

function ratioPct(scorecard) {
  return scorecard?.ratio === null || scorecard?.ratio === undefined ? 0 : Math.round(scorecard.ratio * 100);
}

function ratioLabel(scorecard) {
  return scorecard?.ratio === null || scorecard?.ratio === undefined ? 'n/a' : `${Math.round(scorecard.ratio * 100)}%`;
}

function fmt(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'n/a';
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function pct(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'n/a';
  const number = Number(value);
  return `${number > 0 ? '+' : ''}${number.toFixed(2)}%`;
}

function dateOnly(value) {
  return value ? new Date(value).toLocaleString() : 'unknown';
}

function timeOnly(value) {
  return value ? new Date(value).toLocaleTimeString() : '';
}

function compact(value) {
  const text = JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 160)}...` : text;
}

function watcherSortValue(agent, key) {
  if (key === 'company') return agent.companyName || agent.symbol || '';
  if (key === 'tier') return agent.priceTier || '';
  if (key === 'ratio') return agent.scorecard?.ratio === null || agent.scorecard?.ratio === undefined ? -1 : Number(agent.scorecard.ratio);
  if (key === 'lastRun') return Date.parse(agent.lastResearchedAt || 0) || 0;
  return agent.symbol || '';
}

function toggleWatcherSort() {
  watcherSortDir.value = watcherSortDir.value === 'asc' ? 'desc' : 'asc';
}

watch(selectedSymbol, (symbol) => loadDetail(symbol));

watch([watcherQuery, watcherTierFilter, watcherSortBy, watcherSortDir, watcherPageSize], () => {
  watcherPage.value = 1;
});

watch(researchRunPageSize, () => {
  researchRunPage.value = 1;
});

watch(watcherPager, (pager) => {
  if (watcherPage.value > pager.totalPages) watcherPage.value = pager.totalPages;
});

watch(researchRunPager, (pager) => {
  if (researchRunPage.value > pager.totalPages) researchRunPage.value = pager.totalPages;
});

onMounted(load);
</script>
