<template>
  <div class="page-shell agents-desk">
    <div class="agents-hero ops-command-bar mb-6">
      <div class="min-w-0">
        <p class="page-kicker mb-3">Personality-biased trading agents, BrainMesh debate, and consensus strategy</p>
        <h1 class="page-title">Agent Council</h1>
        <p class="page-copy mt-4 max-w-3xl">
          Simulated public-persona agents research with the top-level brains, argue over candidates, and produce a consensus recommendation trail.
        </p>
      </div>
      <div class="research-command mini-glass">
        <div class="text-xs uppercase text-white/40">council</div>
        <div class="font-headline text-lg text-accent">{{ latestRun ? `run #${latestRun.id}` : 'standby' }}</div>
        <div class="hud-stat-grid mt-4">
          <div class="hud-stat">
            <strong>{{ agents.length }}</strong>
            <span>agents</span>
          </div>
          <div class="hud-stat">
            <strong>{{ latestRun?.summary?.finalRecommendations?.length || 0 }}</strong>
            <span>consensus</span>
          </div>
          <div class="hud-stat">
            <strong>{{ meshTrace }}</strong>
            <span>mesh</span>
          </div>
        </div>
        <div class="flex flex-wrap gap-3 mt-5">
          <GlassButton :disabled="Boolean(busy)" @click="runCouncil">
            <v-icon size="16" class="mr-1">mdi-forum</v-icon>
            {{ busy === 'council' ? 'Debating...' : 'Run council' }}
          </GlassButton>
          <button
            class="hud-window-toggle"
            :class="{ active: recommendationsWindowOpen }"
            @click="recommendationsWindowOpen = true"
          >
            <v-icon size="15">mdi-chart-timeline-variant</v-icon>
            picks
          </button>
          <button
            class="hud-window-toggle"
            :class="{ active: historyWindowOpen }"
            @click="historyWindowOpen = true"
          >
            <v-icon size="15">mdi-history</v-icon>
            runs
          </button>
          <GlassButton variant="ghost" :disabled="Boolean(busy)" @click="dialogOpen = true">
            <v-icon size="16" class="mr-1">mdi-account-plus</v-icon>
            Add agent
          </GlassButton>
          <GlassButton variant="ghost" :disabled="Boolean(busy)" @click="importDialogOpen = true">
            <v-icon size="16" class="mr-1">mdi-import</v-icon>
            Import
          </GlassButton>
        </div>
      </div>
    </div>

    <div v-if="error" class="glass-panel p-4 text-danger text-sm mb-5">{{ error }}</div>

    <aside
      v-if="agentTerminalOpen && activeAgentRun"
      class="floating-terminal agent-research-terminal"
      :style="{ transform: `translate(${agentTerminalPosition.x}px, ${agentTerminalPosition.y}px)` }"
    >
      <div class="terminal-head movable-head" @pointerdown="startTerminalDrag">
        <span>agent research · {{ activeAgentRun.name }} · {{ activeAgentRun.status }}</span>
        <button @click.stop="agentTerminalOpen = false"><v-icon size="16">mdi-close</v-icon></button>
      </div>
      <div class="terminal-body">
        <div v-for="(line, index) in activeAgentRun.terminal" :key="`${line.ts}-${index}`" class="terminal-line" :class="line.level">
          <span>{{ timeOnly(line.ts) }}</span>
          <strong>{{ line.phase }}</strong>
          <p>{{ line.message }}</p>
          <code v-if="line.data">{{ compact(line.data) }}</code>
        </div>
      </div>
    </aside>

    <div class="agents-workspace">
      <GlassCard title="Personality agents" class="agents-roster">
        <div v-if="!agents.length" class="text-white/42 text-sm">No agents yet.</div>
        <div v-else class="agent-card-grid">
          <button
            v-for="agent in agents"
            :key="agent.id"
            class="agent-persona-card mini-glass"
            :class="{ active: selectedAgent?.id === agent.id }"
            @click="selectedAgent = agent"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="font-headline text-lg truncate">{{ agent.name }}</div>
                <div class="text-xs text-white/38 truncate">{{ agent.persona?.archetype }}</div>
              </div>
              <v-icon size="18" class="text-accent">mdi-brain</v-icon>
            </div>
            <p class="text-white/58 text-xs leading-5 mt-3">{{ agent.persona?.summary }}</p>
            <div class="hud-card-meta mt-3">
              <span v-for="style in agent.persona?.style?.slice(0, 3)" :key="style" class="hud-chip">{{ style }}</span>
            </div>
          </button>
        </div>
      </GlassCard>

      <GlassCard title="Agent model" class="agents-detail">
        <div v-if="!selectedAgent" class="text-white/42 text-sm">Select an agent to inspect its model and sources.</div>
        <div v-else>
          <div class="flex flex-wrap items-start justify-between gap-4 mb-5">
            <div>
              <div class="font-headline text-2xl text-accent">{{ selectedAgent.name }}</div>
              <div class="text-xs text-white/42">{{ selectedAgent.brain_id }}</div>
            </div>
            <div class="agent-action-bar">
              <span class="hud-chip">{{ selectedAgent.status }}</span>
              <button class="hud-window-toggle" @click="openEdit(selectedAgent)">
                <v-icon size="15">mdi-pencil</v-icon>
                edit
              </button>
              <button class="hud-window-toggle" @click="exportAgent(selectedAgent)">
                <v-icon size="15">mdi-export</v-icon>
                export
              </button>
              <button class="hud-window-toggle danger-toggle" @click="deleteAgent(selectedAgent)">
                <v-icon size="15">mdi-delete</v-icon>
                delete
              </button>
            </div>
          </div>
          <p class="text-white/65 text-sm leading-6">{{ selectedAgent.persona?.disclaimer }}</p>
          <div v-if="selectedAgent.workspace" class="workspace-path mini-glass mt-4">
            <v-icon size="16" class="text-accent">mdi-folder-cog</v-icon>
            <span>{{ selectedAgent.workspace.path }}</span>
          </div>
          <div class="agent-bias-grid mt-5">
            <div class="mini-glass p-4">
              <div class="text-xs uppercase text-white/36 mb-3">sector bias</div>
              <div class="bias-list">
                <div v-for="[sector, value] in entries(selectedAgent.bias?.sectors)" :key="sector">
                  <span>{{ sector }}</span>
                  <strong>{{ signed(value) }}</strong>
                </div>
              </div>
            </div>
            <div class="mini-glass p-4">
              <div class="text-xs uppercase text-white/36 mb-3">factor bias</div>
              <div class="bias-list">
                <div v-for="[factor, value] in entries(selectedAgent.bias?.factors)" :key="factor">
                  <span>{{ factor }}</span>
                  <strong>{{ signed(value) }}</strong>
                </div>
              </div>
            </div>
          </div>
          <div class="mt-5">
            <div class="text-xs uppercase text-white/36 mb-3">attached sources</div>
            <div v-if="!agentSourcePager.total" class="text-white/42 text-sm">No attached sources for this agent yet.</div>
            <div v-else class="source-list">
              <a v-for="url in paginatedAgentSources" :key="url" :href="url" target="_blank" rel="noreferrer" class="source-row mini-glass">
                <span class="source-dot"></span>
                <span class="min-w-0">
                  <strong>{{ host(url) }}</strong>
                  <small>{{ url }}</small>
                </span>
              </a>
            </div>
            <div v-if="agentSourcePager.total" class="agent-source-pagination mt-3">
              <div class="agent-source-summary">
                <span>{{ agentSourcePager.total }} sources</span>
                <span>{{ agentSourcePager.start }}-{{ agentSourcePager.end }} visible</span>
                <span>page {{ agentSourcePager.current }} / {{ agentSourcePager.totalPages }}</span>
              </div>
              <div class="agent-source-controls">
                <v-select
                  v-model="agentSourcePageSize"
                  :items="[5, 10, 25]"
                  label="Rows"
                  variant="outlined"
                  density="compact"
                  hide-details
                  class="agent-source-page-size"
                />
                <button class="hud-window-toggle" :disabled="agentSourcePage <= 1" @click="agentSourcePage -= 1">
                  <v-icon size="15">mdi-chevron-left</v-icon>
                  prev
                </button>
                <button
                  class="hud-window-toggle"
                  :disabled="agentSourcePage >= agentSourcePager.totalPages"
                  @click="agentSourcePage += 1"
                >
                  next
                  <v-icon size="15">mdi-chevron-right</v-icon>
                </button>
              </div>
            </div>
          </div>
        </div>
      </GlassCard>
    </div>

    <aside
      v-if="recommendationsWindowOpen"
      class="floating-glass-window floating-agent-window floating-agent-recommendations"
    >
      <div class="floating-window-head">
        <span>
          Consensus recommendations
          <small>{{ latestRun ? `run #${latestRun.id}` : 'standby' }}</small>
        </span>
        <button @click="recommendationsWindowOpen = false"><v-icon size="16">mdi-close</v-icon></button>
      </div>
      <div class="floating-window-body">
        <div v-if="!latestRun" class="text-white/42 text-sm">Run the council to produce recommendations.</div>
        <div v-else class="consensus-list">
          <div v-for="rec in latestRun.summary.finalRecommendations" :key="rec.symbol" class="consensus-row mini-glass">
            <div>
              <strong class="font-headline text-lg">{{ rec.symbol }}</strong>
              <small>{{ rec.supportingAgents?.join(', ') || 'no supporting agents' }}</small>
            </div>
            <span class="hud-chip" :class="rec.action === 'buy' ? 'text-accent' : rec.action === 'sell' ? 'text-danger' : ''">{{ rec.action }}</span>
            <div class="score-ring" :style="{ '--score': `${Math.max(0, Math.min(100, rec.avgConviction || 0))}%` }">
              <span>{{ rec.avgConviction }}</span>
            </div>
          </div>
        </div>
      </div>
    </aside>

    <aside
      v-if="historyWindowOpen"
      class="floating-glass-window floating-agent-window floating-agent-history"
    >
      <div class="floating-window-head">
        <span>
          Council run history
          <small>{{ runs.length }} records</small>
        </span>
        <button @click="historyWindowOpen = false"><v-icon size="16">mdi-close</v-icon></button>
      </div>
      <div class="floating-window-body">
        <div v-if="!runs.length" class="text-white/42 text-sm">No council runs yet.</div>
        <div v-else class="flex flex-col gap-3">
          <button
            v-for="run in runs"
            :key="run.id"
            class="run-row mini-glass"
            :class="{ active: selectedRunId === run.id }"
            @click="openRunResult(run)"
          >
            <span>
              <strong>#{{ run.id }} · {{ run.status }}</strong>
              <small>{{ run.created_at }} · {{ run.conversation_id }}</small>
            </span>
            <span>{{ run.summary?.finalRecommendations?.length || 0 }}</span>
          </button>
        </div>
      </div>
    </aside>

    <aside
      v-if="runResultWindowOpen && selectedRunResult"
      class="floating-glass-window floating-agent-window floating-agent-run-results"
      :style="{ transform: `translate(${runResultWindowPosition.x}px, ${runResultWindowPosition.y}px)` }"
    >
      <div class="floating-window-head movable-head" @pointerdown="startRunResultDrag">
        <span>
          council run results
          <small>#{{ selectedRunResult.id }} · {{ selectedRunResult.status }}</small>
        </span>
        <button @click.stop="runResultWindowOpen = false"><v-icon size="16">mdi-close</v-icon></button>
      </div>
      <div class="floating-window-body">
        <div class="hud-stat-grid mb-4">
          <div class="hud-stat">
            <strong>{{ selectedRunResult.summary?.agentCount || agents.length }}</strong>
            <span>agents</span>
          </div>
          <div class="hud-stat">
            <strong>{{ selectedRunResult.summary?.recommendationCount || selectedRunResult.recommendations?.length || 0 }}</strong>
            <span>votes</span>
          </div>
          <div class="hud-stat">
            <strong>{{ selectedRunResult.summary?.finalRecommendations?.length || 0 }}</strong>
            <span>consensus</span>
          </div>
        </div>

        <div class="run-result-section">
          <div class="text-xs uppercase text-white/36 mb-3">consensus recommendations</div>
          <div v-if="!selectedRunResult.summary?.finalRecommendations?.length" class="text-white/42 text-sm">No consensus recommendations were stored for this run.</div>
          <div v-else class="consensus-list">
            <div v-for="rec in selectedRunResult.summary.finalRecommendations" :key="`${selectedRunResult.id}-${rec.symbol}`" class="consensus-row mini-glass">
              <div>
                <strong class="font-headline text-lg">{{ rec.symbol }}</strong>
                <small>{{ rec.supportingAgents?.join(', ') || 'no supporting agents' }}</small>
              </div>
              <span class="hud-chip" :class="rec.action === 'buy' ? 'text-accent' : rec.action === 'sell' ? 'text-danger' : ''">{{ rec.action }}</span>
              <div class="score-ring" :style="{ '--score': `${Math.max(0, Math.min(100, rec.avgConviction || rec.consensusScore || 0))}%` }">
                <span>{{ rec.avgConviction || rec.consensusScore || 0 }}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="run-result-section mt-4">
          <div class="text-xs uppercase text-white/36 mb-3">agent votes</div>
          <div v-if="!selectedRunResult.recommendations?.length" class="text-white/42 text-sm">No individual agent votes were stored for this run.</div>
          <div v-else class="run-vote-list">
            <div v-for="vote in selectedRunResult.recommendations" :key="`${selectedRunResult.id}-${vote.agent_id}-${vote.symbol}`" class="run-vote-row mini-glass">
              <strong>{{ agentNameFor(vote.agent_id) }}</strong>
              <span :class="vote.action === 'buy' ? 'text-accent' : vote.action === 'sell' ? 'text-danger' : 'text-white/58'">{{ vote.action }} {{ vote.symbol }}</span>
              <small>{{ vote.conviction }} · {{ vote.rationale || vote.evidence?.reason || 'no rationale captured' }}</small>
            </div>
          </div>
        </div>

        <details class="run-result-raw mt-4">
          <summary>summary payload</summary>
          <code>{{ compact(selectedRunResult.summary) }}</code>
        </details>
      </div>
    </aside>

    <v-dialog v-model="dialogOpen" max-width="520">
      <div class="glass-panel p-5">
        <div class="flex items-center justify-between gap-3 mb-4">
          <div>
            <div class="font-headline text-xl">Create Agent</div>
            <div class="text-xs text-white/42">Name a person or strategy archetype. The system will crawl, research investments, expand companies through Finnhub, and build the model.</div>
          </div>
          <button class="text-white/60" @click="dialogOpen = false"><v-icon>mdi-close</v-icon></button>
        </div>
        <v-text-field v-model="agentName" label="Agent name" variant="outlined" density="comfortable" hide-details />
        <div class="flex justify-end gap-3 mt-5">
          <GlassButton variant="ghost" @click="dialogOpen = false">Cancel</GlassButton>
          <GlassButton :disabled="Boolean(busy) || !agentName.trim()" @click="createAgent">
            {{ busy === 'create' ? 'Creating...' : 'Create' }}
          </GlassButton>
        </div>
      </div>
    </v-dialog>

    <v-dialog v-model="editDialogOpen" max-width="820">
      <div class="glass-panel p-5">
        <div class="flex items-center justify-between gap-3 mb-4">
          <div>
            <div class="font-headline text-xl">Edit Agent</div>
            <div class="text-xs text-white/42">Update metadata, source URLs, and personality traits. Changes sync to the agent folder spec.</div>
          </div>
          <button class="text-white/60" @click="editDialogOpen = false"><v-icon>mdi-close</v-icon></button>
        </div>
        <div class="agent-edit-grid">
          <v-text-field v-model="editForm.name" label="Name" variant="outlined" density="comfortable" hide-details />
          <v-select
            v-model="editForm.status"
            :items="['active', 'paused', 'archived']"
            label="Status"
            variant="outlined"
            density="comfortable"
            hide-details
          />
        </div>
        <v-textarea v-model="editForm.personaJson" label="Persona JSON" variant="outlined" rows="7" class="mt-4" hide-details />
        <v-textarea v-model="editForm.biasJson" label="Bias JSON" variant="outlined" rows="7" class="mt-4" hide-details />
        <v-textarea v-model="editForm.sourceUrlsText" label="Source URLs, one per line" variant="outlined" rows="5" class="mt-4" hide-details />
        <div class="flex justify-end gap-3 mt-5">
          <GlassButton variant="ghost" @click="editDialogOpen = false">Cancel</GlassButton>
          <GlassButton :disabled="Boolean(busy)" @click="saveAgent">
            {{ busy === 'save' ? 'Saving...' : 'Save' }}
          </GlassButton>
        </div>
      </div>
    </v-dialog>

    <v-dialog v-model="importDialogOpen" max-width="760">
      <div class="glass-panel p-5">
        <div class="flex items-center justify-between gap-3 mb-4">
          <div>
            <div class="font-headline text-xl">Import Agent</div>
            <div class="text-xs text-white/42">Paste an exported agent JSON payload or an agent spec.</div>
          </div>
          <button class="text-white/60" @click="importDialogOpen = false"><v-icon>mdi-close</v-icon></button>
        </div>
        <v-textarea v-model="importPayload" label="Agent JSON" variant="outlined" rows="12" hide-details />
        <div class="flex justify-end gap-3 mt-5">
          <GlassButton variant="ghost" @click="importDialogOpen = false">Cancel</GlassButton>
          <GlassButton :disabled="Boolean(busy) || !importPayload.trim()" @click="importAgent">
            {{ busy === 'import' ? 'Importing...' : 'Import' }}
          </GlassButton>
        </div>
      </div>
    </v-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import api from '../api/client';
import GlassCard from '../components/GlassCard.vue';
import GlassButton from '../components/GlassButton.vue';

const agents = ref([]);
const runs = ref([]);
const selectedAgent = ref(null);
const selectedRunId = ref(null);
const dialogOpen = ref(false);
const editDialogOpen = ref(false);
const importDialogOpen = ref(false);
const recommendationsWindowOpen = ref(false);
const historyWindowOpen = ref(false);
const runResultWindowOpen = ref(false);
const selectedRunResult = ref(null);
const runResultWindowPosition = ref({ x: 0, y: 0 });
const agentSourcePage = ref(1);
const agentSourcePageSize = ref(5);
const agentName = ref('');
const importPayload = ref('');
const activeAgentRun = ref(null);
const agentTerminalOpen = ref(false);
const agentTerminalPosition = ref({ x: 0, y: 0 });
const terminalDrag = ref(null);
const runResultDrag = ref(null);
const editForm = ref({
  id: null,
  name: '',
  status: 'active',
  personaJson: '{}',
  biasJson: '{}',
  sourceUrlsText: '',
});
const busy = ref('');
const error = ref('');
let agentPollTimer = null;

const latestRun = computed(() => runs.value.find((run) => run.id === selectedRunId.value) || runs.value[0] || null);
const meshTrace = computed(() => latestRun.value?.conversation_id ? 'online' : 'ready');
const selectedAgentSources = computed(() => selectedAgent.value?.sourceUrls || []);
const agentSourcePager = computed(() => {
  const total = selectedAgentSources.value.length;
  const size = Number(agentSourcePageSize.value) || 5;
  const totalPages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(agentSourcePage.value, totalPages);
  const start = total ? (current - 1) * size + 1 : 0;
  const end = Math.min(total, current * size);
  return { total, size, totalPages, current, start, end };
});
const paginatedAgentSources = computed(() => {
  const pager = agentSourcePager.value;
  const start = (pager.current - 1) * pager.size;
  return selectedAgentSources.value.slice(start, start + pager.size);
});

async function load() {
  const [agentRes, runRes] = await Promise.all([
    api.get('/agents'),
    api.get('/agents/council/runs'),
  ]);
  agents.value = agentRes.data;
  runs.value = runRes.data;
  selectedAgent.value = agents.value.find((agent) => agent.id === selectedAgent.value?.id) || agents.value[0] || null;
}

async function createAgent() {
  error.value = '';
  busy.value = 'create';
  const requestedName = agentName.value.trim();
  activeAgentRun.value = {
    id: 'starting',
    name: requestedName,
    status: 'starting',
    phase: 'request',
    progress: 1,
    terminal: [
      {
        ts: new Date().toISOString(),
        phase: 'request',
        progress: 1,
        level: 'info',
        message: `Opening autonomous agent research run for ${requestedName}.`,
        data: { endpoint: '/api/agents/research-create' },
      },
    ],
  };
  agentTerminalOpen.value = true;
  try {
    const { data } = await api.post('/agents/research-create', { name: requestedName });
    activeAgentRun.value = {
      ...data,
      terminal: [...activeAgentRun.value.terminal, ...(data.terminal || [])],
    };
    agentName.value = '';
    dialogOpen.value = false;
    startAgentPolling(data.id);
  } catch (err) {
    error.value = err.response?.data?.error || 'Agent creation failed';
    activeAgentRun.value = {
      ...activeAgentRun.value,
      status: 'failed',
      phase: 'request',
      progress: 100,
      terminal: [
        ...activeAgentRun.value.terminal,
        {
          ts: new Date().toISOString(),
          phase: 'request',
          progress: 100,
          level: 'error',
          message: err.response?.data?.error || err.message || 'Agent creation request failed.',
          data: {
            status: err.response?.status,
            endpoint: '/api/agents/research-create',
          },
        },
      ],
    };
    busy.value = '';
  }
}

function startAgentPolling(runId) {
  clearAgentPolling();
  agentPollTimer = window.setInterval(async () => {
    try {
      const { data } = await api.get(`/agents/research-runs/${runId}`);
      activeAgentRun.value = data;
      if (!['queued', 'running'].includes(data.status)) {
        clearAgentPolling();
        busy.value = '';
        await load();
        if (data.agent?.id) selectedAgent.value = agents.value.find((agent) => agent.id === data.agent.id) || data.agent;
        if (data.status === 'failed') error.value = data.error || 'Agent research failed';
      }
    } catch (err) {
      clearAgentPolling();
      busy.value = '';
      error.value = err.response?.data?.error || 'Agent research polling failed';
    }
  }, 1200);
}

function clearAgentPolling() {
  if (agentPollTimer) window.clearInterval(agentPollTimer);
  agentPollTimer = null;
}

function startTerminalDrag(event) {
  terminalDrag.value = {
    startX: event.clientX,
    startY: event.clientY,
    originX: agentTerminalPosition.value.x,
    originY: agentTerminalPosition.value.y,
  };
  window.addEventListener('pointermove', moveTerminal);
  window.addEventListener('pointerup', stopTerminalDrag, { once: true });
}

function moveTerminal(event) {
  if (!terminalDrag.value) return;
  agentTerminalPosition.value = {
    x: terminalDrag.value.originX + event.clientX - terminalDrag.value.startX,
    y: terminalDrag.value.originY + event.clientY - terminalDrag.value.startY,
  };
}

function stopTerminalDrag() {
  terminalDrag.value = null;
  window.removeEventListener('pointermove', moveTerminal);
}

function openRunResult(run) {
  selectedRunId.value = run.id;
  selectedRunResult.value = run;
  runResultWindowOpen.value = true;
}

function startRunResultDrag(event) {
  if (event.target?.closest?.('button')) return;
  runResultDrag.value = {
    startX: event.clientX,
    startY: event.clientY,
    originX: runResultWindowPosition.value.x,
    originY: runResultWindowPosition.value.y,
  };
  window.addEventListener('pointermove', moveRunResult);
  window.addEventListener('pointerup', stopRunResultDrag, { once: true });
}

function moveRunResult(event) {
  if (!runResultDrag.value) return;
  runResultWindowPosition.value = {
    x: runResultDrag.value.originX + event.clientX - runResultDrag.value.startX,
    y: runResultDrag.value.originY + event.clientY - runResultDrag.value.startY,
  };
}

function stopRunResultDrag() {
  runResultDrag.value = null;
  window.removeEventListener('pointermove', moveRunResult);
}

function timeOnly(value) {
  return value ? new Date(value).toLocaleTimeString() : '';
}

function compact(value) {
  const text = JSON.stringify(value);
  return text.length > 220 ? `${text.slice(0, 220)}...` : text;
}

onUnmounted(() => {
  clearAgentPolling();
  window.removeEventListener('pointermove', moveTerminal);
  window.removeEventListener('pointermove', moveRunResult);
});

function openEdit(agent) {
  error.value = '';
  editForm.value = {
    id: agent.id,
    name: agent.name,
    status: agent.status,
    personaJson: JSON.stringify(agent.persona || {}, null, 2),
    biasJson: JSON.stringify(agent.bias || {}, null, 2),
    sourceUrlsText: (agent.sourceUrls || []).join('\n'),
  };
  editDialogOpen.value = true;
}

async function saveAgent() {
  error.value = '';
  busy.value = 'save';
  try {
    const payload = {
      name: editForm.value.name,
      status: editForm.value.status,
      persona: JSON.parse(editForm.value.personaJson || '{}'),
      bias: JSON.parse(editForm.value.biasJson || '{}'),
      sourceUrls: editForm.value.sourceUrlsText.split(/\n+/).map((url) => url.trim()).filter(Boolean),
    };
    const { data } = await api.patch(`/agents/${editForm.value.id}`, payload);
    editDialogOpen.value = false;
    await load();
    selectedAgent.value = agents.value.find((agent) => agent.id === data.id) || data;
  } catch (err) {
    error.value = err.response?.data?.error || err.message || 'Agent save failed';
  } finally {
    busy.value = '';
  }
}

async function deleteAgent(agent) {
  if (!window.confirm(`Delete ${agent.name}? The workspace will be retained and marked deleted.`)) return;
  error.value = '';
  busy.value = 'delete';
  try {
    await api.delete(`/agents/${agent.id}`);
    selectedAgent.value = null;
    await load();
  } catch (err) {
    error.value = err.response?.data?.error || 'Agent delete failed';
  } finally {
    busy.value = '';
  }
}

async function exportAgent(agent) {
  error.value = '';
  busy.value = 'export';
  try {
    const { data } = await api.get(`/agents/${agent.id}/export`);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${agent.slug || agent.name}-agent-export.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    error.value = err.response?.data?.error || 'Agent export failed';
  } finally {
    busy.value = '';
  }
}

async function importAgent() {
  error.value = '';
  busy.value = 'import';
  try {
    const payload = JSON.parse(importPayload.value);
    const { data } = await api.post('/agents/import', payload);
    importPayload.value = '';
    importDialogOpen.value = false;
    await load();
    selectedAgent.value = agents.value.find((agent) => agent.id === data.id) || data;
  } catch (err) {
    error.value = err.response?.data?.error || err.message || 'Agent import failed';
  } finally {
    busy.value = '';
  }
}

async function runCouncil() {
  error.value = '';
  busy.value = 'council';
  try {
    const { data } = await api.post('/agents/council/run', {});
    await load();
    selectedRunId.value = data.id;
    recommendationsWindowOpen.value = true;
  } catch (err) {
    error.value = err.response?.data?.error || 'Council run failed';
  } finally {
    busy.value = '';
  }
}

function entries(value) {
  return Object.entries(value || {}).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
}

function agentNameFor(agentId) {
  return agents.value.find((agent) => agent.id === agentId || agent.id === Number(agentId))?.name || `agent ${agentId}`;
}

function signed(value) {
  const number = Number(value || 0);
  return `${number >= 0 ? '+' : ''}${number.toFixed(2)}`;
}

watch(
  () => [selectedAgent.value?.id, agentSourcePageSize.value],
  () => {
    agentSourcePage.value = 1;
  }
);

watch(agentSourcePager, (pager) => {
  if (agentSourcePage.value > pager.totalPages) agentSourcePage.value = pager.totalPages;
});

function host(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

onMounted(load);
</script>
