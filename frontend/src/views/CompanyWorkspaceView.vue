<template>
  <div class="page-shell company-workspace">
    <div class="workspace-hero ops-command-bar mb-6">
      <div class="min-w-0">
        <p class="page-kicker mb-3">Learned company intelligence, factor memory, and exported Brain.js models</p>
        <h1 class="page-title">Company Workspace</h1>
        <p class="page-copy mt-4 max-w-3xl">
          Every symbol the Brain researches is retained here with the macro scenarios, historical trend context, and broker-style
          assumptions that shaped the buy, sell, or hold decision.
        </p>
      </div>
      <div class="mini-glass workspace-command">
        <div class="text-xs uppercase text-white/40">memory index</div>
        <div class="font-headline text-3xl text-accent">{{ companies.length }}</div>
        <div class="text-xs text-white/40">company summaries · {{ models.length }} exported models</div>
        <div class="mt-5">
          <GlassButton :disabled="loading" @click="load">
            <v-icon size="16" class="mr-1">mdi-refresh</v-icon>
            {{ loading ? 'Refreshing...' : 'Refresh workspace' }}
          </GlassButton>
        </div>
      </div>
    </div>

    <div v-if="error" class="glass-panel p-4 text-danger text-sm mb-5">{{ error }}</div>

    <div class="bento-grid stagger">
      <GlassCard title="Company Memory" class="bento-span-4">
        <div v-if="!companies.length" class="text-white/42 text-sm">
          No company intelligence yet. Run collect/process research from the Research Desk to populate the workspace.
        </div>
        <div v-else>
          <div class="company-memory-controls mini-glass mb-3">
            <v-text-field
              v-model="companyMemoryQuery"
              label="Search memory"
              prepend-inner-icon="mdi-magnify"
              variant="outlined"
              density="compact"
              hide-details
            />
            <v-select
              v-model="companyMemoryScoreFilter"
              :items="companyMemoryScoreFilters"
              label="Score"
              variant="outlined"
              density="compact"
              hide-details
            />
            <v-select
              v-model="companyMemorySortBy"
              :items="companyMemorySortItems"
              label="Sort"
              variant="outlined"
              density="compact"
              hide-details
            />
            <button class="hud-chip hud-chip-button" @click="toggleCompanyMemorySort">
              <v-icon size="15">{{ companyMemorySortDir === 'asc' ? 'mdi-sort-ascending' : 'mdi-sort-descending' }}</v-icon>
              {{ companyMemorySortDir }}
            </button>
          </div>

          <div class="company-memory-summary mb-3">
            <span>{{ companyMemoryPager.total }} companies</span>
            <span>{{ companyMemoryPager.start }}-{{ companyMemoryPager.end }} visible</span>
            <span>page {{ companyMemoryPage }} / {{ companyMemoryPager.totalPages }}</span>
          </div>

          <div class="company-memory-list">
            <div v-if="!paginatedCompanies.length" class="empty-dense">
              No company memory matches the current controls.
            </div>
            <button
              v-for="company in paginatedCompanies"
              :key="company.symbol"
              class="company-memory-row mini-glass"
              :class="selectedCompany?.symbol === company.symbol ? 'active' : ''"
              @click="selectedSymbol = company.symbol"
            >
              <span class="company-symbol">{{ company.symbol }}</span>
              <span class="min-w-0">
                <strong>{{ company.company_name || company.symbol }}</strong>
                <small>{{ company.summary?.summary }}</small>
              </span>
              <span class="workspace-score" :style="{ '--score': `${company.summary?.compositeScore || 0}%` }">
                {{ company.summary?.compositeScore || 0 }}
              </span>
            </button>
          </div>

          <div class="company-memory-pagination mt-3">
            <v-select
              v-model="companyMemoryPageSize"
              :items="[10, 25, 50]"
              label="Rows"
              variant="outlined"
              density="compact"
              hide-details
              class="company-memory-page-size"
            />
            <button class="hud-window-toggle" :disabled="companyMemoryPage <= 1" @click="companyMemoryPage -= 1">
              <v-icon size="15">mdi-chevron-left</v-icon>
              prev
            </button>
            <button
              class="hud-window-toggle"
              :disabled="companyMemoryPage >= companyMemoryPager.totalPages"
              @click="companyMemoryPage += 1"
            >
              next
              <v-icon size="15">mdi-chevron-right</v-icon>
            </button>
          </div>
        </div>
      </GlassCard>

      <GlassCard title="Research Summary" class="bento-span-8">
        <template #actions>
          <div class="workspace-summary-actions">
            <button class="hud-window-toggle" :class="{ active: brainModelsOpen }" @click="brainModelsOpen = !brainModelsOpen">
              <v-icon size="15">mdi-brain</v-icon>
              models
            </button>
            <button class="hud-window-toggle" :class="{ active: knownContextOpen }" @click="knownContextOpen = !knownContextOpen">
              <v-icon size="15">mdi-vector-link</v-icon>
              context
            </button>
          </div>
        </template>
        <div v-if="!selectedCompany" class="text-white/42 text-sm">Select a company summary.</div>
        <div v-else>
          <div class="workspace-summary-head">
            <div>
              <div class="flex flex-wrap gap-2 mb-3">
                <span class="hud-chip">{{ selectedCompany.symbol }}</span>
                <span class="hud-chip">score {{ selectedSummary.compositeScore || 0 }}</span>
                <span class="hud-chip">{{ selectedSummary.researchedAt ? dateOnly(selectedSummary.researchedAt) : 'not dated' }}</span>
              </div>
              <p class="text-white/70 text-sm leading-6 max-w-3xl">{{ selectedSummary.summary }}</p>
            </div>
            <div class="workspace-orbit" :style="{ '--score': `${selectedSummary.compositeScore || 0}%` }">
              <strong>{{ selectedSummary.compositeScore || 0 }}</strong>
              <span>intel</span>
            </div>
          </div>

          <div class="workspace-metric-grid mt-5">
            <div class="workspace-metric mini-glass">
              <span>price</span>
              <strong>${{ fmt(selectedSummary.quote?.current) }}</strong>
              <small :class="selectedSummary.quote?.changePct >= 0 ? 'text-accent' : 'text-danger'">
                {{ pct(selectedSummary.quote?.changePct) }}
              </small>
            </div>
            <div class="workspace-metric mini-glass">
              <span>5y trend</span>
              <strong>{{ pct(selectedSummary.history?.fiveYearReturnPct) }}</strong>
              <small>max drawdown {{ pct(selectedSummary.history?.maxDrawdownPct) }}</small>
            </div>
            <div class="workspace-metric mini-glass">
              <span>oil</span>
              <strong>${{ fmt(selectedSummary.oil?.price) }}</strong>
              <small>{{ pct(selectedSummary.oil?.changePct) }} · {{ selectedSummary.oil?.symbol || 'CL=F' }}</small>
            </div>
            <div class="workspace-metric mini-glass">
              <span>population</span>
              <strong>{{ pct(selectedSummary.population?.usPopulationGrowthPct) }}</strong>
              <small>US · {{ selectedSummary.population?.period || 'latest' }}</small>
            </div>
          </div>

          <div class="factor-grid mt-5">
            <div
              v-for="factor in factorEntries"
              :key="factor.key"
              class="factor-card mini-glass"
              :class="factorTone(factor.value.score)"
            >
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <span class="factor-label">{{ factor.label }}</span>
                  <strong>{{ factor.value.stance }}</strong>
                </div>
                <span class="factor-score">{{ factor.value.score }}</span>
              </div>
              <div class="factor-meter mt-3" :style="{ '--score': `${factor.value.score || 0}%` }"></div>
              <p class="mt-3">{{ factor.value.rationale }}</p>
              <small v-if="factor.value.fiveYearReturnPct !== undefined">
                5y return {{ pct(factor.value.fiveYearReturnPct) }}
                <template v-if="factor.value.annualizedReturnPct !== undefined"> · annual {{ pct(factor.value.annualizedReturnPct) }}</template>
                <template v-if="factor.value.maxDrawdownPct !== undefined"> · drawdown {{ pct(factor.value.maxDrawdownPct) }}</template>
              </small>
              <small v-else-if="factor.value.valueChangePct !== undefined">
                value {{ pct(factor.value.valueChangePct) }} · from ${{ fmt(factor.value.firstClose) }} to ${{ fmt(factor.value.lastClose) }}
              </small>
              <small v-else-if="factor.value.stockSplitsPast5Years !== undefined">
                splits {{ factor.value.stockSplitsPast5Years }} in 5y
              </small>
              <small v-else-if="factor.value.oilChangePct !== undefined">Oil move {{ pct(factor.value.oilChangePct) }}</small>
              <small v-else-if="factor.value.populationGrowthPct !== undefined">
                Population growth {{ pct(factor.value.populationGrowthPct) }}
              </small>
            </div>
          </div>
        </div>
      </GlassCard>
    </div>

    <aside
      v-if="brainModelsOpen"
      class="floating-glass-window floating-company-workspace-window floating-brain-models-window"
      :style="{ transform: `translate(${workspaceWindowPositions.models.x}px, ${workspaceWindowPositions.models.y}px)` }"
    >
      <div class="floating-window-head movable-head" @pointerdown="startWorkspaceWindowDrag($event, 'models')">
        <span>
          brain model exports
          <small>{{ models.length }} records</small>
        </span>
        <button @click.stop="brainModelsOpen = false"><v-icon size="16">mdi-close</v-icon></button>
      </div>
      <div class="floating-window-body">
        <div v-if="!models.length" class="text-white/42 text-sm">
          No exported model JSON yet. The first autonomous scoring run will train or reuse a persisted Brain.js network.
        </div>
        <div v-else class="model-export-list">
          <div v-for="model in models" :key="model.id" class="model-export-row mini-glass">
            <div class="min-w-0">
              <strong>{{ model.model_key }}</strong>
              <small>{{ model.metadata?.purpose || 'Persisted neural scoring model' }}</small>
            </div>
            <div class="model-export-meta">
              <span>{{ model.metadata?.trainingExamples || 0 }} examples</span>
              <span>{{ compactLayers(model.metadata?.hiddenLayers) }}</span>
              <span>{{ dateOnly(model.updated_at) }}</span>
            </div>
          </div>
        </div>
      </div>
    </aside>

    <aside
      v-if="knownContextOpen"
      class="floating-glass-window floating-company-workspace-window floating-known-context-window"
      :style="{ transform: `translate(${workspaceWindowPositions.context.x}px, ${workspaceWindowPositions.context.y}px)` }"
    >
      <div class="floating-window-head movable-head" @pointerdown="startWorkspaceWindowDrag($event, 'context')">
        <span>
          known context
          <small>{{ selectedCompany?.symbol || 'standby' }}</small>
        </span>
        <button @click.stop="knownContextOpen = false"><v-icon size="16">mdi-close</v-icon></button>
      </div>
      <div class="floating-window-body">
        <div v-if="!selectedCompany" class="text-white/42 text-sm">Context appears after selecting a company.</div>
        <div v-else class="context-grid">
          <div class="context-cell mini-glass">
            <span>macro bias</span>
            <strong>{{ selectedSummary.macro?.riskBias || 'unknown' }}</strong>
          </div>
          <div class="context-cell mini-glass">
            <span>consumer bias</span>
            <strong>{{ selectedSummary.macro?.consumerBias || 'unknown' }}</strong>
          </div>
          <div class="context-cell mini-glass">
            <span>history depth</span>
            <strong>{{ selectedSummary.history?.points || 0 }} points</strong>
          </div>
          <div class="context-cell mini-glass">
            <span>data source</span>
            <strong>{{ sourceLabel }}</strong>
          </div>
        </div>
      </div>
    </aside>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import api from '../api/client';
import GlassButton from '../components/GlassButton.vue';
import GlassCard from '../components/GlassCard.vue';

const companies = ref([]);
const models = ref([]);
const selectedSymbol = ref('');
const loading = ref(false);
const error = ref('');
const companyMemoryQuery = ref('');
const companyMemoryScoreFilter = ref('all');
const companyMemorySortBy = ref('score');
const companyMemorySortDir = ref('desc');
const companyMemoryPage = ref(1);
const companyMemoryPageSize = ref(10);
const brainModelsOpen = ref(false);
const knownContextOpen = ref(false);
const workspaceWindowPositions = ref({
  models: { x: 0, y: 0 },
  context: { x: 0, y: 0 },
});
let workspaceWindowDrag = null;

const companyMemoryScoreFilters = [
  { title: 'All scores', value: 'all' },
  { title: 'High 70+', value: 'high' },
  { title: 'Mid 40-69', value: 'mid' },
  { title: 'Low < 40', value: 'low' },
];

const companyMemorySortItems = [
  { title: 'Score', value: 'score' },
  { title: 'Symbol', value: 'symbol' },
  { title: 'Company', value: 'company' },
  { title: 'Researched', value: 'researchedAt' },
];

const factorLabels = {
  warDefense: 'War / defense spending',
  oilShipping: 'Oil / shipping exposure',
  requiredEnergyValuation: 'Required energy valuation',
  lowCostHighYield: 'Low-cost high-yield profile',
  populationDemand: 'Population demand',
  deepHistoryTrend: 'Deep company history',
  companyGrowthTrend: 'Company growth / decline',
  companyValueTrend: 'Company value over time',
  fiveYearSplitActivity: '5-year stock splits',
  localEventExposure: 'Local event exposure',
};

const selectedCompany = computed(() => {
  return companies.value.find((company) => company.symbol === selectedSymbol.value) || companies.value[0] || null;
});

const selectedSummary = computed(() => selectedCompany.value?.summary || {});

const filteredCompanies = computed(() => {
  const query = companyMemoryQuery.value.trim().toLowerCase();
  return companies.value.filter((company) => {
    const score = Number(company.summary?.compositeScore || 0);
    if (companyMemoryScoreFilter.value === 'high' && score < 70) return false;
    if (companyMemoryScoreFilter.value === 'mid' && (score < 40 || score >= 70)) return false;
    if (companyMemoryScoreFilter.value === 'low' && score >= 40) return false;
    if (!query) return true;
    const haystack = [
      company.symbol,
      company.company_name,
      company.summary?.summary,
      company.summary?.macro?.riskBias,
      company.summary?.macro?.consumerBias,
    ].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(query);
  });
});

const sortedCompanies = computed(() => {
  const direction = companyMemorySortDir.value === 'asc' ? 1 : -1;
  return [...filteredCompanies.value].sort((a, b) => {
    const left = companyMemorySortValue(a, companyMemorySortBy.value);
    const right = companyMemorySortValue(b, companyMemorySortBy.value);
    if (typeof left === 'number' || typeof right === 'number') {
      return (Number(left || 0) - Number(right || 0)) * direction;
    }
    return String(left || '').localeCompare(String(right || '')) * direction;
  });
});

const companyMemoryPager = computed(() => {
  const total = sortedCompanies.value.length;
  const size = Number(companyMemoryPageSize.value) || 10;
  const totalPages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(companyMemoryPage.value, totalPages);
  const start = total ? (current - 1) * size + 1 : 0;
  const end = Math.min(total, current * size);
  return { total, size, totalPages, current, start, end };
});

const paginatedCompanies = computed(() => {
  const pager = companyMemoryPager.value;
  const start = (pager.current - 1) * pager.size;
  return sortedCompanies.value.slice(start, start + pager.size);
});

const factorEntries = computed(() => {
  const factors = selectedSummary.value.factors || {};
  return Object.entries(factors).map(([key, value]) => ({
    key,
    value,
    label: factorLabels[key] || key,
  }));
});

const sourceLabel = computed(() => {
  const population = selectedSummary.value.population?.source ? 'World Bank' : '';
  const history = selectedSummary.value.history ? 'Yahoo chart' : '';
  return [history, population].filter(Boolean).join(' + ') || 'learned research stack';
});

async function load() {
  error.value = '';
  loading.value = true;
  try {
    const [companyRes, modelRes] = await Promise.all([
      api.get('/companies?limit=100'),
      api.get('/companies/brain/models'),
    ]);
    companies.value = companyRes.data;
    models.value = modelRes.data;
    if (!selectedSymbol.value && companies.value.length) selectedSymbol.value = companies.value[0].symbol;
  } catch (err) {
    error.value = err.response?.data?.error || 'Unable to load company workspace';
  } finally {
    loading.value = false;
  }
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
  if (!value) return 'unknown';
  return new Date(value).toLocaleString();
}

function compactLayers(layers) {
  return Array.isArray(layers) ? `layers ${layers.join('/')}` : 'layers n/a';
}

function factorTone(score) {
  if (score >= 68) return 'strong';
  if (score <= 38) return 'risk';
  return 'neutral';
}

function companyMemorySortValue(company, key) {
  if (key === 'score') return Number(company.summary?.compositeScore || 0);
  if (key === 'company') return company.company_name || company.symbol || '';
  if (key === 'researchedAt') return Date.parse(company.summary?.researchedAt || company.updated_at || 0) || 0;
  return company.symbol || '';
}

function toggleCompanyMemorySort() {
  companyMemorySortDir.value = companyMemorySortDir.value === 'asc' ? 'desc' : 'asc';
}

function startWorkspaceWindowDrag(event, windowKey) {
  if (event.target?.closest?.('button')) return;
  workspaceWindowDrag = {
    windowKey,
    startX: event.clientX,
    startY: event.clientY,
    originX: workspaceWindowPositions.value[windowKey].x,
    originY: workspaceWindowPositions.value[windowKey].y,
  };
  window.addEventListener('pointermove', onWorkspaceWindowDrag);
  window.addEventListener('pointerup', stopWorkspaceWindowDrag, { once: true });
}

function onWorkspaceWindowDrag(event) {
  if (!workspaceWindowDrag) return;
  const { windowKey, startX, startY, originX, originY } = workspaceWindowDrag;
  workspaceWindowPositions.value = {
    ...workspaceWindowPositions.value,
    [windowKey]: {
      x: originX + event.clientX - startX,
      y: originY + event.clientY - startY,
    },
  };
}

function stopWorkspaceWindowDrag() {
  workspaceWindowDrag = null;
  window.removeEventListener('pointermove', onWorkspaceWindowDrag);
}

watch(
  [companyMemoryQuery, companyMemoryScoreFilter, companyMemorySortBy, companyMemorySortDir, companyMemoryPageSize],
  () => {
    companyMemoryPage.value = 1;
  }
);

watch(companyMemoryPager, (pager) => {
  if (companyMemoryPage.value > pager.totalPages) companyMemoryPage.value = pager.totalPages;
});

onMounted(load);
onUnmounted(() => {
  window.removeEventListener('pointermove', onWorkspaceWindowDrag);
});
</script>
