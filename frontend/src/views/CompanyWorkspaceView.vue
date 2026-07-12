<template>
  <div class="page-shell company-workspace">
    <div class="workspace-hero mb-7">
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
        <div v-else class="company-memory-list">
          <button
            v-for="company in companies"
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
      </GlassCard>

      <GlassCard title="Research Summary" class="bento-span-8">
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
                5y return {{ pct(factor.value.fiveYearReturnPct) }} · drawdown {{ pct(factor.value.maxDrawdownPct) }}
              </small>
              <small v-else-if="factor.value.oilChangePct !== undefined">Oil move {{ pct(factor.value.oilChangePct) }}</small>
              <small v-else-if="factor.value.populationGrowthPct !== undefined">
                Population growth {{ pct(factor.value.populationGrowthPct) }}
              </small>
            </div>
          </div>
        </div>
      </GlassCard>

      <GlassCard title="Brain Model Exports" class="bento-span-5">
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
      </GlassCard>

      <GlassCard title="Known Context" class="bento-span-7">
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
      </GlassCard>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import api from '../api/client';
import GlassButton from '../components/GlassButton.vue';
import GlassCard from '../components/GlassCard.vue';

const companies = ref([]);
const models = ref([]);
const selectedSymbol = ref('');
const loading = ref(false);
const error = ref('');

const factorLabels = {
  warDefense: 'War / defense spending',
  oilShipping: 'Oil / shipping exposure',
  requiredEnergyValuation: 'Required energy valuation',
  lowCostHighYield: 'Low-cost high-yield profile',
  populationDemand: 'Population demand',
  deepHistoryTrend: 'Deep company history',
};

const selectedCompany = computed(() => {
  return companies.value.find((company) => company.symbol === selectedSymbol.value) || companies.value[0] || null;
});

const selectedSummary = computed(() => selectedCompany.value?.summary || {});

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

onMounted(load);
</script>
