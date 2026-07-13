<template>
  <div class="page-shell watcher-desk">
    <div class="workspace-hero mb-7">
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
        <div class="mt-5">
          <GlassButton :disabled="loading" @click="load">
            <v-icon size="16" class="mr-1">mdi-refresh</v-icon>
            {{ loading ? 'Refreshing...' : 'Refresh roster' }}
          </GlassButton>
        </div>
      </div>
    </div>

    <div v-if="error" class="glass-panel p-4 text-danger text-sm mb-5">{{ error }}</div>

    <div class="bento-grid stagger">
      <GlassCard title="Watcher Roster" class="bento-span-4">
        <div v-if="!agents.length" class="text-white/42 text-sm">
          No watcher agents yet. Watchers are created automatically as the Brain discovers and researches symbols.
        </div>
        <div v-else class="company-memory-list">
          <button
            v-for="agent in agents"
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
              <div v-for="run in detail.researchRuns" :key="run.id" class="run-row mini-glass">
                <span>
                  <strong>{{ run.predicted_action }} · ${{ fmt(run.price_at_research) }}</strong>
                  <small>{{ dateOnly(run.run_at) }} · score {{ run.local_ai_score }} · {{ run.graded ? 'graded' : 'ungraded' }}</small>
                </span>
                <span>{{ run.rationale?.theme || 'watcher' }}</span>
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

const priorityCount = computed(() => agents.value.filter((agent) => agent.priceTier === 'priority').length);
const standardCount = computed(() => agents.value.length - priorityCount.value);

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
  } catch (err) {
    error.value = err.response?.data?.error || 'Unable to load watcher agent detail';
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

watch(selectedSymbol, (symbol) => loadDetail(symbol));

onMounted(load);
</script>
