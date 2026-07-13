<template>
  <div class="page-shell">
    <div class="flex flex-col lg:flex-row lg:items-end justify-between gap-6 mb-10">
      <div>
        <p class="page-kicker mb-3">Account status &amp; guardrails</p>
        <h1 class="page-title">Dashboard</h1>
      </div>
      <GlassButton :danger="!killSwitchEngaged" @click="toggleKillSwitch" :disabled="toggling">
        <v-icon :icon="killSwitchEngaged ? 'mdi-play' : 'mdi-stop-circle'" class="mr-1" />
        {{ killSwitchEngaged ? 'Resume trading' : 'Engage kill switch' }}
      </GlassButton>
    </div>

    <div v-if="loading" class="glass-panel p-5 text-white/50">Loading...</div>

    <grid-layout
      v-else
      v-model:layout="layout"
      :col-num="12"
      :row-height="88"
      :margin="[16, 16]"
      :is-draggable="true"
      :is-resizable="true"
      :vertical-compact="true"
      :use-css-transforms="true"
      class="widget-grid"
      @layout-updated="onLayoutUpdated"
    >
      <grid-item v-for="item in layout" :key="item.i" v-bind="item" drag-allow-from=".widget-drag-handle">
        <GlassCard v-if="item.i === 'cash-balance'" title="Cash balance" class="h-full widget-card">
          <template #actions><span class="widget-drag-handle" aria-hidden="true"><v-icon icon="mdi-drag" size="16" /></span></template>
          <div class="hud-value font-headline text-5xl md:text-6xl">${{ fmt(summary.brokerAccount?.cash_balance_usd) }}</div>
          <div class="text-xs text-white/40 mt-1">
            {{ summary.brokerAccount?.status }} · buying power ${{ fmt(summary.brokerAccount?.buying_power_usd) }}
          </div>
          <div class="hud-readout" aria-hidden="true"><span v-for="i in 12" :key="i" /></div>
        </GlassCard>

        <GlassCard v-else-if="item.i === 'marked-pnl'" title="Marked P&L" class="h-full widget-card" :tone="summary.todaysPnl < 0 ? 'danger' : 'default'">
          <template #actions><span class="widget-drag-handle" aria-hidden="true"><v-icon icon="mdi-drag" size="16" /></span></template>
          <div class="hud-value font-headline text-4xl" :class="summary.todaysPnl < 0 ? 'text-danger' : 'text-accent'">
            {{ summary.todaysPnl >= 0 ? '+' : '' }}${{ fmt(summary.todaysPnl) }}
          </div>
          <div class="text-xs text-white/40 mt-1">
            realized {{ pnlSign }}${{ fmt(Math.abs(summary.realizedTodayPnl || 0)) }} · open {{ openPnlSign }}${{ fmt(Math.abs(summary.unrealizedPnlUsd || 0)) }}
          </div>
          <div class="hud-node-row" aria-hidden="true"><span v-for="i in 9" :key="i" /></div>
        </GlassCard>

        <GlassCard v-else-if="item.i === 'kill-switch'" title="Kill switch" class="h-full widget-card">
          <template #actions><span class="widget-drag-handle" aria-hidden="true"><v-icon icon="mdi-drag" size="16" /></span></template>
          <div class="hud-value font-headline text-4xl" :class="killSwitchEngaged ? 'text-danger' : 'text-accent'">
            {{ killSwitchEngaged ? 'ENGAGED' : 'CLEAR' }}
          </div>
          <div class="text-xs text-white/40 mt-1">Trading {{ summary.settings?.trading_enabled ? 'enabled' : 'disabled' }}</div>
          <div class="hud-readout" aria-hidden="true"><span v-for="i in 12" :key="i" /></div>
        </GlassCard>

        <GlassCard v-else-if="item.i === 'open-positions'" title="Open positions" class="h-full widget-card">
          <template #actions><span class="widget-drag-handle" aria-hidden="true"><v-icon icon="mdi-drag" size="16" /></span></template>
          <div class="hud-value font-headline text-5xl">{{ summary.positions?.length || 0 }}</div>
          <div class="text-xs text-white/40 mt-1">Max {{ summary.settings?.max_trades_per_symbol_per_24h }} trades/symbol/24h</div>
        </GlassCard>

        <GlassCard v-else-if="item.i === 'positions'" title="Positions" class="h-full widget-card overflow-auto">
          <template #actions><span class="widget-drag-handle" aria-hidden="true"><v-icon icon="mdi-drag" size="16" /></span></template>
          <div class="grid grid-cols-1 lg:grid-cols-[1fr_220px] gap-4">
            <HudLineChart
              :labels="positionChartData.labels"
              :values="positionChartData.values"
              dataset-label="Position value"
              value-prefix="$"
              aria-label="Position market value chart"
            />
            <div class="hud-stat-grid lg:grid-cols-1">
              <div class="hud-stat">
                <strong>${{ fmt(summary.portfolioValueUsd) }}</strong>
                <span>portfolio value</span>
              </div>
              <div class="hud-stat">
                <strong>${{ fmt(summary.positionsMarketValueUsd) }}</strong>
                <span>position value</span>
              </div>
              <div class="hud-stat">
                <strong>{{ executionState }}</strong>
                <span>execution state</span>
              </div>
            </div>
          </div>

          <v-table v-if="summary.positions?.length" density="comfortable" class="bg-transparent mt-4">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Qty</th>
                <th>Avg cost</th>
                <th>Market</th>
                <th>Value</th>
                <th>Open P&L</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in summary.positions" :key="p.id">
                <td class="font-medium">{{ p.symbol }}</td>
                <td>{{ p.quantity }}</td>
                <td>${{ fmt(p.avg_cost_usd) }}</td>
                <td>${{ fmt(p.market_price_usd) }}</td>
                <td>${{ fmt(p.market_value_usd) }}</td>
                <td :class="p.unrealized_pnl_usd < 0 ? 'text-danger' : 'text-accent'">
                  {{ p.unrealized_pnl_usd >= 0 ? '+' : '' }}${{ fmt(p.unrealized_pnl_usd) }}
                </td>
              </tr>
            </tbody>
          </v-table>
          <div v-else class="text-white/40 text-sm">No open positions.</div>
        </GlassCard>

        <GlassCard v-else-if="item.i === 'recent-orders'" title="Recent orders" class="h-full widget-card overflow-auto">
          <template #actions><span class="widget-drag-handle" aria-hidden="true"><v-icon icon="mdi-drag" size="16" /></span></template>
          <div class="grid grid-cols-[170px_1fr] gap-4 items-center mb-4">
            <HudDoughnutChart
              :values="allocationValues"
              :center-value="killSwitchEngaged ? 'HALT' : executionState"
              center-label="state"
            />
            <div class="hud-card-meta">
              <span class="hud-chip">cash {{ fmt(summary.brokerAccount?.cash_balance_usd) }}</span>
              <span class="hud-chip">equity {{ fmt(summary.portfolioValueUsd) }}</span>
              <span class="hud-chip">p&l {{ summary.todaysPnl >= 0 ? '+' : '' }}{{ fmt(summary.todaysPnl) }}</span>
              <span class="hud-chip">risk {{ summary.settings?.max_trades_per_symbol_per_24h }}x</span>
            </div>
          </div>

          <v-table v-if="summary.recentOrders?.length" density="comfortable" class="bg-transparent">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Side</th>
                <th>Qty</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="o in summary.recentOrders" :key="o.id">
                <td class="font-medium">{{ o.symbol }}</td>
                <td :class="o.side === 'buy' ? 'text-accent' : 'text-danger'">{{ o.side }}</td>
                <td>{{ o.quantity }}</td>
                <td>{{ o.status }}</td>
              </tr>
            </tbody>
          </v-table>
          <div v-else class="text-white/40 text-sm">No orders yet.</div>
        </GlassCard>
      </grid-item>
    </grid-layout>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { GridLayout, GridItem } from 'vue3-grid-layout-next';
import api from '../api/client';
import GlassCard from '../components/GlassCard.vue';
import GlassButton from '../components/GlassButton.vue';
import HudDoughnutChart from '../components/HudDoughnutChart.vue';
import HudLineChart from '../components/HudLineChart.vue';
import { buildPositionChartData } from '../utils/dashboardChartData';

const DEFAULT_LAYOUT = [
  { i: 'cash-balance', x: 0, y: 0, w: 4, h: 2 },
  { i: 'marked-pnl', x: 4, y: 0, w: 3, h: 2 },
  { i: 'kill-switch', x: 7, y: 0, w: 3, h: 2 },
  { i: 'open-positions', x: 10, y: 0, w: 2, h: 2 },
  { i: 'positions', x: 0, y: 2, w: 7, h: 5 },
  { i: 'recent-orders', x: 7, y: 2, w: 5, h: 5 },
];

const summary = ref({});
const loading = ref(true);
const toggling = ref(false);
const layout = ref(DEFAULT_LAYOUT.map((item) => ({ ...item })));
let saveTimer = null;

const killSwitchEngaged = computed(() => Boolean(summary.value.settings?.kill_switch_engaged));
const executionState = computed(() => {
  if (summary.value.settings?.simulation_mode_enabled) return 'SIM';
  return summary.value.settings?.trading_enabled ? 'ON' : 'SIM';
});
const pnlSign = computed(() => (Number(summary.value.realizedTodayPnl || 0) >= 0 ? '+' : '-'));
const openPnlSign = computed(() => (Number(summary.value.unrealizedPnlUsd || 0) >= 0 ? '+' : '-'));
const positionChartData = computed(() => buildPositionChartData(summary.value.positions));
const allocationValues = computed(() => {
  const cash = Math.max(1, Number(summary.value.brokerAccount?.cash_balance_usd || 0) || 42);
  const positions = Math.max(1, Number(summary.value.positionsMarketValueUsd || 0));
  const orders = Math.max(1, Number(summary.value.recentOrders?.length || 0) * 8);
  return [cash, positions, orders, 18];
});

function fmt(n) {
  return Number(n ?? 0).toFixed(2);
}

async function load() {
  loading.value = true;
  const [{ data }, settingsRes] = await Promise.all([
    api.get('/dashboard/summary'),
    api.get('/settings').catch(() => null),
  ]);
  summary.value = data;
  const savedLayout = settingsRes?.data?.dashboard_layout_json;
  if (savedLayout) {
    try {
      const parsed = JSON.parse(savedLayout);
      if (Array.isArray(parsed?.dashboard) && parsed.dashboard.length) {
        layout.value = parsed.dashboard;
      }
    } catch {
      // ignore malformed layout, fall back to default
    }
  }
  loading.value = false;
}

function onLayoutUpdated(newLayout) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    api.patch('/settings', { dashboardLayout: { dashboard: newLayout } }).catch(() => {});
  }, 600);
}

async function toggleKillSwitch() {
  toggling.value = true;
  try {
    const path = killSwitchEngaged.value ? '/settings/kill-switch/release' : '/settings/kill-switch/engage';
    await api.post(path, { reason: 'toggled from dashboard' });
    await load();
  } finally {
    toggling.value = false;
  }
}

onMounted(load);
</script>
