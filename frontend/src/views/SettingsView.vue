<template>
  <div class="page-shell">
    <div class="mb-10">
      <p class="page-kicker mb-3">Trading guardrails, service credentials, and execution mode</p>
      <h1 class="page-title">Settings</h1>
    </div>

    <div class="bento-grid stagger">
      <div class="bento-span-8 flex flex-col gap-5">
        <GlassCard title="Safety limits">
          <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
            <v-switch
              v-model="form.tradingEnabled"
              label="Trading enabled"
              color="primary"
              hide-details
              @update:model-value="save"
            />

            <v-select
              v-model="form.applicationTimezone"
              :items="timezoneItems"
              label="Application timezone"
              variant="outlined"
              density="comfortable"
              hide-details
            />

            <v-text-field
              v-model="form.tradingStartTime"
              type="time"
              label="Trading start time"
              variant="outlined"
              density="comfortable"
              hide-details
            />

            <v-text-field
              v-model="form.tradingEndTime"
              type="time"
              label="Trading stop time"
              variant="outlined"
              density="comfortable"
              hide-details
            />

            <v-text-field
              v-model="form.researchCadenceCron"
              label="Research cadence (cron expression)"
              variant="outlined"
              density="comfortable"
              hide-details
            />

            <v-text-field
              v-model="form.evaluationCadenceCron"
              label="Evaluation cadence (cron expression)"
              variant="outlined"
              density="comfortable"
              hide-details
            />

            <v-text-field
              v-model="form.watcherCycleCadenceCron"
              label="Watcher research cadence (cron expression)"
              variant="outlined"
              density="comfortable"
              hide-details
            />

            <v-text-field
              v-model="form.personalityTickCadenceCron"
              label="Personality tick cadence (cron expression)"
              variant="outlined"
              density="comfortable"
              hide-details
            />

            <v-switch
              v-model="form.sourceLearningEnabled"
              label="Self-learning research URLs"
              color="primary"
              hide-details
            />

            <v-text-field
              v-model.number="form.dailyLossLimitUsd"
              type="number"
              label="Daily loss limit (USD)"
              variant="outlined"
              density="comfortable"
              hide-details
            />

            <v-text-field
              v-model.number="form.maxTradesPerSymbolPer24h"
              type="number"
              label="Max trades per symbol / 24h"
              variant="outlined"
              density="comfortable"
              hide-details
            />
          </div>

          <div class="flex items-center gap-3 mt-5">
            <GlassButton :disabled="saving" @click="save">{{ saving ? 'Saving...' : 'Save settings' }}</GlassButton>
            <div v-if="saved" class="text-accent text-xs">Saved.</div>
          </div>
        </GlassCard>

        <GlassCard title="Persistent simulation">
          <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
            <v-switch
              v-model="form.simulationModeEnabled"
              label="Simulation mode"
              color="primary"
              hide-details
            />

            <v-text-field
              v-model.number="form.simulationStartingCashUsd"
              type="number"
              min="1"
              step="1"
              label="Starting cash cap (USD)"
              variant="outlined"
              density="comfortable"
              hide-details
            />

            <v-switch
              v-model="form.agentPersonalityRefreshEnabled"
              label="Evening agent re-research"
              color="primary"
              hide-details
            />

            <v-text-field
              v-model="form.agentPersonalityRefreshTime"
              type="time"
              label="Agent refresh time"
              variant="outlined"
              density="comfortable"
              hide-details
            />

            <v-switch
              v-model="form.agentLocalLearningEnabled"
              label="Hourly local-LLM bias learning"
              color="primary"
              hide-details
            />
          </div>

          <div class="simulation-status-grid mt-5">
            <div class="mini-glass p-4">
              <div class="text-xs text-white/38 uppercase tracking-wide">Started</div>
              <div class="font-medium mt-1">{{ formatStamp(settingsStatus.simulationStartedAt) }}</div>
            </div>
            <div class="mini-glass p-4">
              <div class="text-xs text-white/38 uppercase tracking-wide">Last morning cycle</div>
              <div class="font-medium mt-1">{{ formatStamp(settingsStatus.simulationLastCycleAt) }}</div>
            </div>
            <div class="mini-glass p-4">
              <div class="text-xs text-white/38 uppercase tracking-wide">Last close evaluation</div>
              <div class="font-medium mt-1">{{ formatStamp(settingsStatus.simulationLastEvaluationAt) }}</div>
            </div>
            <div class="mini-glass p-4">
              <div class="text-xs text-white/38 uppercase tracking-wide">Agent refresh</div>
              <div class="font-medium mt-1">{{ formatStamp(settingsStatus.agentPersonalityLastRefreshedAt) }}</div>
            </div>
          </div>
        </GlassCard>

        <GlassCard title="Service providers">
          <div v-if="providerError" class="text-danger text-sm mb-4">{{ providerError }}</div>
          <v-expansion-panels variant="accordion" bg-color="transparent">
            <v-expansion-panel
              v-for="provider in providers"
              :key="provider.providerKey"
              class="!bg-transparent !text-white"
            >
              <v-expansion-panel-title>
                <div class="flex items-center gap-3 w-full min-w-0">
                  <v-icon :icon="providerIcon(provider.providerType)" class="text-accent" />
                  <div class="min-w-0">
                    <div class="font-medium truncate">{{ provider.displayName }}</div>
                    <div class="text-xs text-white/40 truncate">{{ provider.description }}</div>
                  </div>
                  <v-chip class="ml-auto" size="small" :color="provider.configured ? 'success' : 'default'" variant="flat">
                    {{ provider.configured ? provider.status : 'not configured' }}
                  </v-chip>
                </div>
              </v-expansion-panel-title>
              <v-expansion-panel-text>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <v-text-field
                    v-for="field in provider.fields"
                    :key="field.key"
                    v-model="providerDrafts[provider.providerKey][field.key]"
                    :type="field.secret ? 'password' : 'text'"
                    :label="field.label"
                    :placeholder="field.placeholder || provider.maskedFields?.[field.key] || ''"
                    variant="outlined"
                    density="comfortable"
                    hide-details
                  />
                </div>
                <div class="flex flex-wrap items-center gap-3 mt-4">
                  <GlassButton :disabled="savingProvider === provider.providerKey" @click="saveProvider(provider)">
                    {{ savingProvider === provider.providerKey ? 'Saving...' : 'Save provider' }}
                  </GlassButton>
                  <span v-if="provider.envConfigured" class="text-xs text-white/45">Configured from environment variables</span>
                  <span v-else-if="provider.configured" class="text-xs text-white/45">Stored credentials are configured</span>
                </div>
              </v-expansion-panel-text>
            </v-expansion-panel>
          </v-expansion-panels>
        </GlassCard>

        <GlassCard title="Research URL memory">
          <div class="source-admin-grid mb-5">
            <v-text-field
              v-model="sourceDraft.url"
              label="Research URL"
              variant="outlined"
              density="comfortable"
              hide-details
            />
            <v-text-field
              v-model="sourceDraft.title"
              label="Label"
              variant="outlined"
              density="comfortable"
              hide-details
            />
            <GlassButton :disabled="savingSource || !sourceDraft.url" @click="addSource">
              {{ savingSource ? 'Adding...' : 'Add URL' }}
            </GlassButton>
          </div>
          <div v-if="sourceError" class="text-danger text-sm mb-3">{{ sourceError }}</div>
          <div class="source-memory-controls mini-glass mb-4">
            <v-text-field
              v-model="sourceQuery.search"
              label="Search URL memory"
              prepend-inner-icon="mdi-magnify"
              variant="outlined"
              density="compact"
              hide-details
              @keyup.enter="applySourceQuery"
            />
            <v-select
              v-model="sourceQuery.status"
              :items="statusFilterItems"
              label="Status"
              variant="outlined"
              density="compact"
              hide-details
              @update:model-value="applySourceQuery"
            />
            <v-select
              v-model="sourceQuery.sourceType"
              :items="sourceTypeItems"
              label="Type"
              variant="outlined"
              density="compact"
              hide-details
              @update:model-value="applySourceQuery"
            />
            <v-select
              v-model="sourceQuery.sortBy"
              :items="sourceSortItems"
              label="Sort"
              variant="outlined"
              density="compact"
              hide-details
              @update:model-value="loadSources"
            />
            <button class="hud-chip hud-chip-button" @click="toggleSourceSort">
              <v-icon size="15">{{ sourceQuery.sortDir === 'asc' ? 'mdi-sort-ascending' : 'mdi-sort-descending' }}</v-icon>
              {{ sourceQuery.sortDir }}
            </button>
            <GlassButton variant="ghost" @click="applySourceQuery">Search</GlassButton>
          </div>
          <div class="source-memory-summary mb-3">
            <span>{{ sourcePager.total }} URLs</span>
            <span>page {{ sourcePager.page }} / {{ sourcePager.totalPages }}</span>
          </div>
          <div class="source-memory-list">
            <div v-if="!sources.length" class="mini-glass p-4 text-white/42 text-sm">No research URLs match the current filters.</div>
            <div v-for="source in sources" :key="source.id" class="source-memory-row mini-glass">
              <div class="min-w-0">
                <div class="font-medium truncate">{{ source.title || source.url }}</div>
                <div class="text-xs text-white/38 truncate">{{ source.url }}</div>
                <div class="hud-card-meta">
                  <span class="hud-chip">{{ source.source_type }}</span>
                  <span class="hud-chip">{{ source.discovery_method }}</span>
                  <span class="hud-chip">rel {{ Number(source.relevance_score).toFixed(0) }}</span>
                  <span class="hud-chip">cred {{ Number(source.credibility_score).toFixed(0) }}</span>
                  <span class="hud-chip" :class="source.failure_count >= 10 ? 'text-danger' : ''">fail {{ source.failure_count || 0 }}</span>
                </div>
              </div>
              <v-select
                :model-value="source.status"
                :items="['active', 'paused', 'blocked', 'failed']"
                variant="outlined"
                density="compact"
                hide-details
                class="source-status-select"
                @update:model-value="(status) => updateSource(source, { status })"
              />
            </div>
          </div>
          <div class="source-pagination mt-4">
            <v-select
              v-model="sourceQuery.pageSize"
              :items="[10, 25, 50, 100]"
              label="Rows"
              variant="outlined"
              density="compact"
              hide-details
              class="source-page-size"
              @update:model-value="applySourceQuery"
            />
            <button class="hud-chip hud-chip-button" :disabled="sourcePager.page <= 1" @click="changeSourcePage(-1)">
              <v-icon size="15">mdi-chevron-left</v-icon>
              previous
            </button>
            <button class="hud-chip hud-chip-button" :disabled="sourcePager.page >= sourcePager.totalPages" @click="changeSourcePage(1)">
              next
              <v-icon size="15">mdi-chevron-right</v-icon>
            </button>
          </div>
        </GlassCard>
      </div>

      <div class="bento-span-4 flex flex-col gap-5 xl:mt-20">
        <GlassCard v-if="auth.isAdmin" title="User management">
          <p class="text-white/50 text-sm mb-4">
            Create operators, set access roles, disable accounts, and reset passwords.
          </p>
          <GlassButton class="!w-full justify-center" @click="router.push({ name: 'users' })">
            Open Users workspace
          </GlassButton>
        </GlassCard>

        <GlassCard title="Execution mode" :tone="killSwitchEngaged || !form.tradingEnabled ? 'danger' : 'default'">
          <div class="font-headline text-4xl" :class="form.tradingEnabled && !killSwitchEngaged ? 'text-accent' : 'text-danger'">
            {{ form.tradingEnabled && !killSwitchEngaged ? 'LIVE READY' : 'SIMULATION' }}
          </div>
          <p class="text-white/45 text-sm mt-3">
            Scheduled cycles continue in simulation whenever trading is paused, the kill switch is engaged, or Alpaca is unavailable.
          </p>
        </GlassCard>

        <GlassCard title="Kill switch">
          <p class="text-white/50 text-sm mb-4">
            Engaging the kill switch immediately blocks every new live order while simulation reports continue.
          </p>
          <GlassButton :danger="!killSwitchEngaged" @click="toggleKillSwitch">
            {{ killSwitchEngaged ? 'Resume trading' : 'Engage kill switch' }}
          </GlassButton>
        </GlassCard>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import api from '../api/client';
import GlassCard from '../components/GlassCard.vue';
import GlassButton from '../components/GlassButton.vue';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const router = useRouter();
const form = ref({
  tradingEnabled: false,
  dailyLossLimitUsd: 10,
  maxTradesPerSymbolPer24h: 3,
  researchCadenceCron: '',
  evaluationCadenceCron: '0 0 * * *',
  watcherCycleCadenceCron: '0 * * * *',
  personalityTickCadenceCron: '0 * * * *',
  sourceLearningEnabled: true,
  applicationTimezone: 'America/New_York',
  tradingStartTime: '09:30',
  tradingEndTime: '16:00',
  simulationModeEnabled: false,
  simulationStartingCashUsd: 100,
  agentPersonalityRefreshEnabled: true,
  agentPersonalityRefreshTime: '20:00',
  agentLocalLearningEnabled: false,
});
const settingsStatus = ref({
  simulationStartedAt: null,
  simulationLastCycleAt: null,
  simulationLastEvaluationAt: null,
  agentPersonalityLastRefreshedAt: null,
});
const killSwitchEngaged = ref(false);
const saving = ref(false);
const saved = ref(false);
const providers = ref([]);
const providerDrafts = ref({});
const providerError = ref('');
const savingProvider = ref('');
const sources = ref([]);
const sourcePager = ref({ total: 0, page: 1, pageSize: 25, totalPages: 1 });
const sourceQuery = ref({
  page: 1,
  pageSize: 25,
  search: '',
  status: '',
  sourceType: '',
  sortBy: 'updated_at',
  sortDir: 'desc',
});
const sourceDraft = ref({ url: '', title: '' });
const sourceError = ref('');
const savingSource = ref(false);
const statusFilterItems = [
  { title: 'All statuses', value: '' },
  { title: 'Active', value: 'active' },
  { title: 'Paused', value: 'paused' },
  { title: 'Blocked', value: 'blocked' },
  { title: 'Failed', value: 'failed' },
];
const sourceTypeItems = [
  { title: 'All types', value: '' },
  { title: 'Seed', value: 'seed' },
  { title: 'Manual', value: 'manual' },
  { title: 'Learned', value: 'learned' },
  { title: 'Search', value: 'search' },
];
const sourceSortItems = [
  { title: 'Last updated', value: 'updated_at' },
  { title: 'Relevance', value: 'relevance_score' },
  { title: 'Credibility', value: 'credibility_score' },
  { title: 'Failures', value: 'failure_count' },
  { title: 'Successes', value: 'success_count' },
  { title: 'Title', value: 'title' },
  { title: 'URL', value: 'url' },
  { title: 'Status', value: 'status' },
  { title: 'Type', value: 'source_type' },
];
const timezoneItems = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'UTC',
];

async function load() {
  const [{ data }, providerRes] = await Promise.all([
    api.get('/settings'),
    api.get('/settings/providers'),
  ]);
  form.value = {
    tradingEnabled: Boolean(data.trading_enabled),
    dailyLossLimitUsd: data.daily_loss_limit_usd,
    maxTradesPerSymbolPer24h: data.max_trades_per_symbol_per_24h,
    researchCadenceCron: data.research_cadence_cron,
    evaluationCadenceCron: data.evaluation_cadence_cron || '0 0 * * *',
    watcherCycleCadenceCron: data.watcher_cycle_cadence_cron || '0 * * * *',
    personalityTickCadenceCron: data.personality_tick_cadence_cron || '0 * * * *',
    sourceLearningEnabled: Boolean(data.source_learning_enabled),
    applicationTimezone: data.application_timezone || 'America/New_York',
    tradingStartTime: data.trading_start_time || '09:30',
    tradingEndTime: data.trading_end_time || '16:00',
    simulationModeEnabled: Boolean(data.simulation_mode_enabled),
    simulationStartingCashUsd: data.simulation_starting_cash_usd || 100,
    agentPersonalityRefreshEnabled: Boolean(data.agent_personality_refresh_enabled),
    agentPersonalityRefreshTime: data.agent_personality_refresh_time || '20:00',
    agentLocalLearningEnabled: Boolean(data.agent_local_learning_enabled),
  };
  syncSettingsStatus(data);
  killSwitchEngaged.value = Boolean(data.kill_switch_engaged);
  providers.value = providerRes.data;
  providerDrafts.value = Object.fromEntries(
    providerRes.data.map((provider) => [
      provider.providerKey,
      Object.fromEntries(provider.fields.map((field) => [field.key, ''])),
    ])
  );
  await loadSources();
}

async function loadSources() {
  const { data } = await api.get('/settings/research-sources', {
    params: {
      ...sourceQuery.value,
      search: sourceQuery.value.search || undefined,
      status: sourceQuery.value.status || undefined,
      sourceType: sourceQuery.value.sourceType || undefined,
    },
  });
  sources.value = data.items || [];
  sourcePager.value = {
    total: data.total || 0,
    page: data.page || 1,
    pageSize: data.pageSize || sourceQuery.value.pageSize,
    totalPages: data.totalPages || 1,
  };
  sourceQuery.value.page = sourcePager.value.page;
  sourceQuery.value.pageSize = sourcePager.value.pageSize;
}

function applySourceQuery() {
  sourceQuery.value.page = 1;
  loadSources();
}

function toggleSourceSort() {
  sourceQuery.value.sortDir = sourceQuery.value.sortDir === 'asc' ? 'desc' : 'asc';
  loadSources();
}

function changeSourcePage(delta) {
  const next = Math.min(sourcePager.value.totalPages, Math.max(1, sourceQuery.value.page + delta));
  if (next === sourceQuery.value.page) return;
  sourceQuery.value.page = next;
  loadSources();
}

async function save() {
  saving.value = true;
  saved.value = false;
  try {
    const { data } = await api.patch('/settings', form.value);
    syncSettingsStatus(data);
    saved.value = true;
  } finally {
    saving.value = false;
  }
}

async function addSource() {
  sourceError.value = '';
  savingSource.value = true;
  try {
    await api.post('/settings/research-sources', {
      url: sourceDraft.value.url,
      title: sourceDraft.value.title,
      sourceType: 'manual',
      tags: ['manual'],
    });
    sourceDraft.value = { url: '', title: '' };
    sourceQuery.value.page = 1;
    await loadSources();
  } catch (err) {
    sourceError.value = err.response?.data?.error || 'Research source save failed';
  } finally {
    savingSource.value = false;
  }
}

async function updateSource(source, patch) {
  sourceError.value = '';
  try {
    await api.patch(`/settings/research-sources/${source.id}`, patch);
    await loadSources();
  } catch (err) {
    sourceError.value = err.response?.data?.error || 'Research source update failed';
  }
}

async function toggleKillSwitch() {
  const path = killSwitchEngaged.value ? '/settings/kill-switch/release' : '/settings/kill-switch/engage';
  await api.post(path, { reason: 'toggled from settings' });
  await load();
}

function providerIcon(type) {
  if (type === 'broker') return 'mdi-bank';
  if (type === 'market-data') return 'mdi-chart-timeline-variant';
  if (type === 'data-source') return 'mdi-database-search';
  return 'mdi-brain';
}

function syncSettingsStatus(data) {
  settingsStatus.value = {
    simulationStartedAt: data.simulation_started_at,
    simulationLastCycleAt: data.simulation_last_cycle_at,
    simulationLastEvaluationAt: data.simulation_last_evaluation_at,
    agentPersonalityLastRefreshedAt: data.agent_personality_last_refreshed_at,
  };
}

function formatStamp(value) {
  if (!value) return 'not run';
  return new Date(value).toLocaleString();
}

async function saveProvider(provider) {
  providerError.value = '';
  savingProvider.value = provider.providerKey;
  try {
    const fields = Object.fromEntries(
      Object.entries(providerDrafts.value[provider.providerKey] || {}).filter(([, value]) => String(value || '').trim())
    );
    await api.put(`/settings/providers/${provider.providerKey}`, { fields });
    await load();
  } catch (err) {
    providerError.value = err.response?.data?.error || 'Provider save failed';
  } finally {
    savingProvider.value = '';
  }
}

onMounted(load);
</script>

<style scoped>
.simulation-status-grid {
  display: grid;
  gap: 1rem;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

@media (max-width: 720px) {
  .simulation-status-grid {
    grid-template-columns: 1fr;
  }
}
</style>
