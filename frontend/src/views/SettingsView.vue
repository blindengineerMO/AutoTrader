<template>
  <div class="page-shell">
    <div class="ops-command-bar mb-6">
      <div>
        <p class="page-kicker mb-3">Trading guardrails, service credentials, and execution mode</p>
        <h1 class="page-title">Settings</h1>
      </div>
      <div class="ops-command-actions">
        <button class="hud-window-toggle" @click="providerWindowOpen = true">
          <v-icon size="16">mdi-key-chain</v-icon>
          {{ auth.isAdmin ? 'service providers' : 'alpaca access' }}
        </button>
        <button v-if="auth.isAdmin" class="hud-window-toggle" @click="sourceWindowOpen = true">
          <v-icon size="16">mdi-link-variant</v-icon>
          research URLs
        </button>
        <button class="hud-window-toggle" @click="nodeWindowOpen = true">
          <v-icon size="16">mdi-lan-connect</v-icon>
          compute nodes
        </button>
      </div>
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

            <v-switch
              v-model="form.dayTradingEnabled"
              label="Day trading enabled (replaces the 24h trade cap with the FINRA pattern-day-trader rule)"
              color="primary"
              hide-details
              @update:model-value="save"
            />

            <v-switch
              v-model="form.fractionalTradingEnabled"
              label="Fractional Alpaca orders"
              color="primary"
              hide-details
            />

            <v-text-field
              v-model.number="form.fractionalMinNotionalUsd"
              type="number"
              min="1"
              step="0.01"
              label="Fractional minimum notional (USD)"
              variant="outlined"
              density="comfortable"
              hide-details
            />

            <v-text-field
              v-model.number="form.maxBuyOrderNotionalUsd"
              type="number"
              min="1"
              step="1"
              label="Max buy per order (USD)"
              variant="outlined"
              density="comfortable"
              hide-details
            />

            <v-text-field
              v-model.number="form.alpacaStatementDownloadDay"
              type="number"
              min="1"
              max="28"
              step="1"
              label="Alpaca statement day"
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

        <GlassCard title="Excluded symbols">
          <div class="excluded-symbol-admin mb-4">
            <v-text-field
              v-model="excludedSymbolDraft.symbol"
              label="Symbol"
              variant="outlined"
              density="compact"
              hide-details
              @keyup.enter="addExcludedSymbol"
            />
            <v-text-field
              v-model="excludedSymbolDraft.reason"
              label="Reason"
              variant="outlined"
              density="compact"
              hide-details
              @keyup.enter="addExcludedSymbol"
            />
            <GlassButton :disabled="savingExcludedSymbol || !excludedSymbolDraft.symbol" @click="addExcludedSymbol">
              {{ savingExcludedSymbol ? 'Adding...' : 'Exclude' }}
            </GlassButton>
          </div>
          <div v-if="excludedSymbolError" class="text-danger text-sm mb-3">{{ excludedSymbolError }}</div>
          <div class="excluded-symbol-list">
            <div v-if="!form.excludedSymbols.length" class="mini-glass p-4 text-white/42 text-sm">
              No excluded symbols yet. Alpaca non-tradable discoveries will appear here automatically.
            </div>
            <div v-for="entry in form.excludedSymbols" :key="entry.symbol" class="excluded-symbol-row mini-glass">
              <div class="min-w-0">
                <div class="font-headline text-accent text-lg">{{ entry.symbol }}</div>
                <div class="text-xs text-white/45 truncate">{{ entry.companyName || entry.reason || 'Excluded from watcher and research creation.' }}</div>
                <div class="hud-card-meta">
                  <span class="hud-chip">{{ entry.source || 'settings' }}</span>
                  <span v-if="entry.exchange" class="hud-chip">{{ entry.exchange }}</span>
                  <span v-if="entry.assetStatus" class="hud-chip">{{ entry.assetStatus }}</span>
                </div>
              </div>
              <button class="hud-window-toggle" title="Remove exclusion" @click="removeExcludedSymbol(entry.symbol)">
                <v-icon size="15">mdi-delete-outline</v-icon>
              </button>
            </div>
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

    <aside
      v-if="providerWindowOpen"
      class="floating-glass-window floating-settings-window floating-settings-providers-window"
      :style="{ left: `${providerWindowPosition.x}px`, top: `${providerWindowPosition.y}px` }"
    >
      <div class="floating-window-head movable-head" @pointerdown="startSettingsWindowDrag($event, 'providers')">
        <span>{{ auth.isAdmin ? 'service providers' : 'alpaca access' }}</span>
        <button @click.stop="providerWindowOpen = false"><v-icon size="18">mdi-close</v-icon></button>
      </div>
      <div class="floating-window-body">
        <div v-if="providerError" class="text-danger text-sm mb-4">{{ providerError }}</div>
        <div class="provider-groups">
          <section v-for="group in providerGroups" :key="group.type" class="provider-group mini-glass">
            <div class="provider-group-header">
              <div class="provider-group-heading">
                <div class="provider-group-title">
                  <v-icon :icon="providerIcon(group.type)" class="text-accent" />
                  <span>{{ providerTypeLabel(group.type) }}</span>
                </div>
                <div class="provider-group-copy">{{ providerTypeDescription(group.type) }}</div>
              </div>
              <v-chip size="small" variant="tonal" color="primary">{{ group.items.length }}</v-chip>
            </div>

            <v-expansion-panels variant="accordion" bg-color="transparent">
              <v-expansion-panel
                v-for="provider in group.items"
                :key="provider.providerKey"
                :data-provider-key="provider.providerKey"
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
                      type="text"
                      :label="field.label"
                      :placeholder="field.placeholder || provider.maskedFields?.[field.key] || ''"
                      variant="outlined"
                      density="comfortable"
                      hide-details
                    />
                  </div>
                  <div v-if="providerHint(provider)" class="provider-hint mt-3">{{ providerHint(provider) }}</div>
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
          </section>
        </div>
      </div>
    </aside>

    <aside
      v-if="sourceWindowOpen"
      class="floating-glass-window floating-settings-window floating-settings-sources-window"
      :style="{ left: `${sourceWindowPosition.x}px`, top: `${sourceWindowPosition.y}px` }"
    >
      <div class="floating-window-head movable-head" @pointerdown="startSettingsWindowDrag($event, 'sources')">
        <span>research URL memory</span>
        <button @click.stop="sourceWindowOpen = false"><v-icon size="18">mdi-close</v-icon></button>
      </div>
      <div class="floating-window-body">
        <div class="source-admin-grid mb-5">
          <v-text-field v-model="sourceDraft.url" label="Research URL" variant="outlined" density="comfortable" hide-details />
          <v-text-field v-model="sourceDraft.title" label="Label" variant="outlined" density="comfortable" hide-details />
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
      </div>
    </aside>

    <aside
      v-if="nodeWindowOpen"
      class="floating-glass-window floating-settings-window floating-settings-nodes-window"
      :style="{ left: `${nodeWindowPosition.x}px`, top: `${nodeWindowPosition.y}px` }"
    >
      <div class="floating-window-head movable-head" @pointerdown="startSettingsWindowDrag($event, 'nodes')">
        <span>brainmesh compute nodes</span>
        <button @click.stop="nodeWindowOpen = false"><v-icon size="18">mdi-close</v-icon></button>
      </div>
      <div class="floating-window-body">
        <div class="text-xs text-white/45 mb-4">
          Pair standalone compute nodes to offload research/scraping jobs. Generate a one-time join token, run the
          node-client with it, and the node appears below once paired.
        </div>
        <div v-if="nodeError" class="text-danger text-sm mb-3">{{ nodeError }}</div>

        <div class="flex items-center gap-3 mb-5">
          <v-text-field v-model="newTokenLabel" label="Label (optional)" variant="outlined" density="comfortable" hide-details />
          <GlassButton :disabled="creatingToken" @click="createJoinToken">
            {{ creatingToken ? 'Generating...' : 'Generate join token' }}
          </GlassButton>
        </div>

        <div v-if="newTokenPlaintext" class="mini-glass mb-5 p-3">
          <div class="text-xs text-white/45 mb-1">
            Copy this now — it's shown once and cannot be retrieved again.
          </div>
          <div class="flex items-center gap-2">
            <code class="text-xs break-all">{{ newTokenPlaintext }}</code>
            <button class="hud-chip hud-chip-button" @click="copyJoinToken">
              <v-icon size="14">mdi-content-copy</v-icon>
              copy
            </button>
          </div>
        </div>

        <div class="text-xs text-white/45 mb-2">Join tokens</div>
        <div class="source-memory-list mb-5">
          <div v-if="!joinTokens.length" class="mini-glass p-4 text-white/42 text-sm">No join tokens yet.</div>
          <div v-for="token in joinTokens" :key="token.id" class="source-memory-row mini-glass">
            <div class="min-w-0">
              <div class="font-medium truncate">{{ token.label || token.id }}</div>
              <div class="hud-card-meta">
                <span class="hud-chip">{{ token.status }}</span>
                <span class="hud-chip">expires {{ formatNodeTime(token.expires_at) }}</span>
              </div>
            </div>
            <button
              v-if="token.status === 'pending'"
              class="hud-chip hud-chip-button"
              @click="revokeJoinToken(token)"
            >
              revoke
            </button>
          </div>
        </div>

        <div class="text-xs text-white/45 mb-2">Paired nodes</div>
        <div class="source-memory-list">
          <div v-if="!nodes.length" class="mini-glass p-4 text-white/42 text-sm">No nodes paired yet.</div>
          <div v-for="node in nodes" :key="node.id" class="source-memory-row mini-glass">
            <div class="min-w-0">
              <div class="font-medium truncate">{{ node.label || node.id }}</div>
              <div class="hud-card-meta">
                <span class="hud-chip" :class="node.status === 'online' ? 'text-accent' : ''">{{ node.status }}</span>
                <span class="hud-chip">{{ node.client_version || 'unknown version' }}</span>
                <span class="hud-chip">last seen {{ formatNodeTime(node.last_seen_at) }}</span>
              </div>
            </div>
            <button class="hud-chip hud-chip-button" @click="revokeNode(node)">
              revoke
            </button>
          </div>
        </div>
      </div>
    </aside>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, computed } from 'vue';
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
  dayTradingEnabled: false,
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
  fractionalTradingEnabled: true,
  fractionalMinNotionalUsd: 1,
  maxBuyOrderNotionalUsd: 100,
  alpacaStatementDownloadDay: 5,
  agentPersonalityRefreshEnabled: true,
  agentPersonalityRefreshTime: '20:00',
  agentLocalLearningEnabled: false,
  excludedSymbols: [],
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
const providerWindowOpen = ref(false);
const sourceWindowOpen = ref(false);
const nodeWindowOpen = ref(false);
const providerWindowPosition = ref({ x: 300, y: 112 });
const sourceWindowPosition = ref({ x: 360, y: 142 });
const nodeWindowPosition = ref({ x: 420, y: 172 });
const settingsWindowDrag = ref(null);
const joinTokens = ref([]);
const nodes = ref([]);
const newTokenLabel = ref('');
const newTokenPlaintext = ref('');
const creatingToken = ref(false);
const nodeError = ref('');
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
const excludedSymbolDraft = ref({ symbol: '', reason: '' });
const excludedSymbolError = ref('');
const savingExcludedSymbol = ref(false);
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

const providerTypeOrder = ['broker', 'billing', 'market-data', 'ai', 'chat-research', 'data-source'];
const providerPriority = {
  alpaca: 1,
  stripe: 1,
  eia: 1,
  'sec-edgar': 2,
};

const providerGroups = computed(() => {
  const grouped = new Map();
  providers.value.forEach((provider) => {
    const type = provider.providerType || 'other';
    if (!grouped.has(type)) grouped.set(type, []);
    grouped.get(type).push(provider);
  });

  return Array.from(grouped.entries())
    .sort(([left], [right]) => providerTypeRank(left) - providerTypeRank(right))
    .map(([type, items]) => ({
      type,
      items: items.slice().sort(sortProviders),
    }));
});

async function load() {
  const [{ data }, providerRes] = await Promise.all([
    api.get('/settings'),
    api.get('/settings/providers'),
  ]);
  form.value = {
    tradingEnabled: Boolean(data.trading_enabled),
    dailyLossLimitUsd: data.daily_loss_limit_usd,
    maxTradesPerSymbolPer24h: data.max_trades_per_symbol_per_24h,
    dayTradingEnabled: Boolean(data.day_trading_enabled),
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
    fractionalTradingEnabled: data.fractional_trading_enabled !== 0,
    fractionalMinNotionalUsd: data.fractional_min_notional_usd || 1,
    maxBuyOrderNotionalUsd: data.max_buy_order_notional_usd || 100,
    alpacaStatementDownloadDay: data.alpaca_statement_download_day || 5,
    agentPersonalityRefreshEnabled: Boolean(data.agent_personality_refresh_enabled),
    agentPersonalityRefreshTime: data.agent_personality_refresh_time || '20:00',
    agentLocalLearningEnabled: Boolean(data.agent_local_learning_enabled),
    excludedSymbols: data.excluded_symbols || parseExcludedSymbols(data.excluded_symbols_json),
  };
  syncSettingsStatus(data);
  killSwitchEngaged.value = Boolean(data.kill_switch_engaged);
  providers.value = providerRes.data;
  providerDrafts.value = Object.fromEntries(
    providerRes.data.map((provider) => [
      provider.providerKey,
      Object.fromEntries(provider.fields.map((field) => [field.key, provider.visibleFields?.[field.key] || field.defaultValue || ''])),
    ])
  );
  if (auth.isAdmin) await loadSources();
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

function windowPositionFor(windowName) {
  if (windowName === 'providers') return providerWindowPosition;
  if (windowName === 'nodes') return nodeWindowPosition;
  return sourceWindowPosition;
}

function startSettingsWindowDrag(event, windowName) {
  if (event.button !== undefined && event.button !== 0) return;
  const position = windowPositionFor(windowName).value;
  settingsWindowDrag.value = {
    windowName,
    startX: event.clientX,
    startY: event.clientY,
    originX: position.x,
    originY: position.y,
  };
  window.addEventListener('pointermove', moveSettingsWindow);
  window.addEventListener('pointerup', stopSettingsWindowDrag, { once: true });
}

function moveSettingsWindow(event) {
  if (!settingsWindowDrag.value) return;
  const drag = settingsWindowDrag.value;
  const maxX = Math.max(10, window.innerWidth - 360);
  const maxY = Math.max(84, window.innerHeight - 180);
  const next = {
    x: Math.min(maxX, Math.max(10, drag.originX + event.clientX - drag.startX)),
    y: Math.min(maxY, Math.max(84, drag.originY + event.clientY - drag.startY)),
  };
  windowPositionFor(drag.windowName).value = next;
}

function stopSettingsWindowDrag() {
  window.removeEventListener('pointermove', moveSettingsWindow);
  settingsWindowDrag.value = null;
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

function formatNodeTime(value) {
  if (!value) return 'never';
  return new Date(`${value.replace(' ', 'T')}Z`).toLocaleString();
}

async function loadNodes() {
  try {
    const [tokensRes, nodesRes] = await Promise.all([
      api.get('/brain-mesh/nodes/join-tokens'),
      api.get('/brain-mesh/nodes/nodes'),
    ]);
    joinTokens.value = tokensRes.data;
    nodes.value = nodesRes.data;
  } catch (err) {
    nodeError.value = err.response?.data?.error || 'Failed to load compute nodes';
  }
}

async function createJoinToken() {
  nodeError.value = '';
  creatingToken.value = true;
  try {
    const res = await api.post('/brain-mesh/nodes/join-tokens', { label: newTokenLabel.value || undefined });
    newTokenPlaintext.value = res.data.token;
    newTokenLabel.value = '';
    await loadNodes();
  } catch (err) {
    nodeError.value = err.response?.data?.error || 'Failed to generate join token';
  } finally {
    creatingToken.value = false;
  }
}

async function copyJoinToken() {
  if (!newTokenPlaintext.value) return;
  await navigator.clipboard.writeText(newTokenPlaintext.value);
}

async function revokeJoinToken(token) {
  nodeError.value = '';
  try {
    await api.delete(`/brain-mesh/nodes/join-tokens/${token.id}`);
    await loadNodes();
  } catch (err) {
    nodeError.value = err.response?.data?.error || 'Failed to revoke join token';
  }
}

async function revokeNode(node) {
  nodeError.value = '';
  try {
    await api.delete(`/brain-mesh/nodes/nodes/${node.id}`);
    await loadNodes();
  } catch (err) {
    nodeError.value = err.response?.data?.error || 'Failed to revoke node';
  }
}

async function addExcludedSymbol() {
  excludedSymbolError.value = '';
  savingExcludedSymbol.value = true;
  try {
    await api.post('/settings/excluded-symbols', {
      symbol: excludedSymbolDraft.value.symbol,
      reason: excludedSymbolDraft.value.reason || 'Manually excluded in Settings.',
      source: 'manual-settings',
    });
    excludedSymbolDraft.value = { symbol: '', reason: '' };
    await load();
  } catch (err) {
    excludedSymbolError.value = err.response?.data?.error || 'Excluded symbol save failed';
  } finally {
    savingExcludedSymbol.value = false;
  }
}

async function removeExcludedSymbol(symbol) {
  excludedSymbolError.value = '';
  try {
    await api.delete(`/settings/excluded-symbols/${encodeURIComponent(symbol)}`);
    await load();
  } catch (err) {
    excludedSymbolError.value = err.response?.data?.error || 'Excluded symbol remove failed';
  }
}

async function toggleKillSwitch() {
  const path = killSwitchEngaged.value ? '/settings/kill-switch/release' : '/settings/kill-switch/engage';
  await api.post(path, { reason: 'toggled from settings' });
  await load();
}

function providerIcon(type) {
  if (type === 'broker') return 'mdi-bank';
  if (type === 'billing') return 'mdi-credit-card-check';
  if (type === 'market-data') return 'mdi-chart-timeline-variant';
  if (type === 'data-source') return 'mdi-database-search';
  if (type === 'chat-research') return 'mdi-message-text-fast';
  return 'mdi-brain';
}

function providerTypeRank(type) {
  const index = providerTypeOrder.indexOf(type);
  return index === -1 ? providerTypeOrder.length : index;
}

function sortProviders(left, right) {
  const priorityDelta = (providerPriority[left.providerKey] || 99) - (providerPriority[right.providerKey] || 99);
  if (priorityDelta) return priorityDelta;
  return String(left.displayName || left.providerKey).localeCompare(String(right.displayName || right.providerKey));
}

function providerTypeLabel(type) {
  if (type === 'broker') return 'Broker';
  if (type === 'billing') return 'Billing';
  if (type === 'market-data') return 'Market data';
  if (type === 'data-source') return 'Data sources';
  if (type === 'chat-research') return 'Chat research';
  if (type === 'ai') return 'AI / reasoning';
  return 'Other providers';
}

function providerTypeDescription(type) {
  if (type === 'broker') return 'Execution credentials for live or paper trading.';
  if (type === 'billing') return 'Payment and subscription credentials for upcoming paid signup workflows.';
  if (type === 'market-data') return 'Market-data providers used for quote, profile, and financial enrichment.';
  if (type === 'data-source') return 'Official datasets and optional API keys used by autonomous research.';
  if (type === 'chat-research') return 'Research assistants used to interpret crawled content and expand analysis.';
  if (type === 'ai') return 'Local and remote reasoning engines available to BMCL and agent workflows.';
  return 'Additional integrations available to the trading brain.';
}

function providerHint(provider) {
  if (provider.providerKey === 'eia') {
    return 'Add the free EIA API key here to unlock EIA API v2 energy datasets for fuel prices, fuel volumes, refinery output, inventories, electricity, and natural-gas research.';
  }
  if (provider.providerKey === 'stripe') {
    return 'Stripe is reserved for the upcoming signup and billing workflow. Store test or live keys here now; checkout, webhooks, and billing portal routes will be wired in a later pass.';
  }
  return '';
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

function parseExcludedSymbols(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
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
onMounted(loadNodes);
onUnmounted(() => {
  window.removeEventListener('pointermove', moveSettingsWindow);
});
</script>

<style scoped>
.provider-groups {
  display: grid;
  gap: 1rem;
}

.provider-group {
  padding: 1rem;
  border: 1px solid rgba(102, 217, 255, 0.16);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.26), inset 0 1px 0 rgba(255, 255, 255, 0.04);
}

.provider-group-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 0.75rem;
}

.provider-group-heading {
  min-width: 0;
}

.provider-group-title {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  color: rgba(255, 255, 255, 0.92);
  font-weight: 700;
}

.provider-group-copy {
  margin-top: 0.25rem;
  color: rgba(255, 255, 255, 0.46);
  font-size: 0.82rem;
  line-height: 1.45;
}

.excluded-symbol-admin {
  display: grid;
  grid-template-columns: minmax(110px, 0.35fr) minmax(0, 1fr) auto;
  gap: 0.75rem;
  align-items: center;
}

.excluded-symbol-list {
  display: grid;
  gap: 0.65rem;
  max-height: 340px;
  overflow: auto;
  padding-right: 0.2rem;
}

.excluded-symbol-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.75rem;
  padding: 0.85rem 0.95rem;
}

.provider-hint {
  border-left: 2px solid rgba(102, 217, 255, 0.72);
  background: linear-gradient(90deg, rgba(102, 217, 255, 0.1), rgba(102, 217, 255, 0));
  color: rgba(255, 255, 255, 0.56);
  font-size: 0.82rem;
  line-height: 1.5;
  padding: 0.65rem 0.75rem;
}

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
