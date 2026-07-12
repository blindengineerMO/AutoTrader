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
          <div class="source-memory-list">
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
        </GlassCard>
      </div>

      <div class="bento-span-4 flex flex-col gap-5 xl:mt-20">
        <GlassCard title="Execution mode" :tone="killSwitchEngaged || !form.tradingEnabled ? 'danger' : 'default'">
          <div class="font-headline text-4xl" :class="form.tradingEnabled && !killSwitchEngaged ? 'text-accent' : 'text-danger'">
            {{ form.tradingEnabled && !killSwitchEngaged ? 'LIVE READY' : 'SIMULATION' }}
          </div>
          <p class="text-white/45 text-sm mt-3">
            Scheduled cycles continue in simulation whenever trading is paused, the kill switch is engaged, or Robinhood is unavailable.
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
import api from '../api/client';
import GlassCard from '../components/GlassCard.vue';
import GlassButton from '../components/GlassButton.vue';

const form = ref({
  tradingEnabled: false,
  dailyLossLimitUsd: 10,
  maxTradesPerSymbolPer24h: 3,
  researchCadenceCron: '',
  evaluationCadenceCron: '0 0 * * *',
  sourceLearningEnabled: true,
});
const killSwitchEngaged = ref(false);
const saving = ref(false);
const saved = ref(false);
const providers = ref([]);
const providerDrafts = ref({});
const providerError = ref('');
const savingProvider = ref('');
const sources = ref([]);
const sourceDraft = ref({ url: '', title: '' });
const sourceError = ref('');
const savingSource = ref(false);

async function load() {
  const [{ data }, providerRes, sourceRes] = await Promise.all([
    api.get('/settings'),
    api.get('/settings/providers'),
    api.get('/settings/research-sources'),
  ]);
  form.value = {
    tradingEnabled: Boolean(data.trading_enabled),
    dailyLossLimitUsd: data.daily_loss_limit_usd,
    maxTradesPerSymbolPer24h: data.max_trades_per_symbol_per_24h,
    researchCadenceCron: data.research_cadence_cron,
    evaluationCadenceCron: data.evaluation_cadence_cron || '0 0 * * *',
    sourceLearningEnabled: Boolean(data.source_learning_enabled),
  };
  killSwitchEngaged.value = Boolean(data.kill_switch_engaged);
  providers.value = providerRes.data;
  providerDrafts.value = Object.fromEntries(
    providerRes.data.map((provider) => [
      provider.providerKey,
      Object.fromEntries(provider.fields.map((field) => [field.key, ''])),
    ])
  );
  sources.value = sourceRes.data;
}

async function save() {
  saving.value = true;
  saved.value = false;
  try {
    await api.patch('/settings', form.value);
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
    await load();
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
    await load();
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
  return 'mdi-brain';
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
