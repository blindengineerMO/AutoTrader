<template>
  <div class="page-shell">
    <div class="flex flex-col lg:flex-row lg:items-end justify-between gap-6 mb-10">
      <div>
        <p class="page-kicker mb-3">Live account status &amp; guardrails</p>
        <h1 class="page-title">Dashboard</h1>
      </div>
      <GlassButton :danger="!killSwitchEngaged" @click="toggleKillSwitch" :disabled="toggling">
        <v-icon :icon="killSwitchEngaged ? 'mdi-play' : 'mdi-stop-circle'" class="mr-1" />
        {{ killSwitchEngaged ? 'Resume trading' : 'Engage kill switch' }}
      </GlassButton>
    </div>

    <div v-if="loading" class="glass-panel p-5 text-white/50">Loading...</div>

    <div v-else class="bento-grid stagger">
      <GlassCard title="Cash balance" class="bento-span-4 min-h-[190px]">
        <div class="hud-value font-headline text-5xl md:text-6xl">${{ fmt(summary.brokerAccount?.cash_balance_usd) }}</div>
        <div class="text-xs text-white/40 mt-1">{{ summary.brokerAccount?.status }}</div>
        <div class="hud-readout" aria-hidden="true"><span v-for="i in 12" :key="i" /></div>
      </GlassCard>

      <GlassCard title="Today's P&L" class="bento-span-3 min-h-[190px]" :tone="summary.todaysPnl < 0 ? 'danger' : 'default'">
        <div class="hud-value font-headline text-4xl" :class="summary.todaysPnl < 0 ? 'text-danger' : 'text-accent'">
          {{ summary.todaysPnl >= 0 ? '+' : '' }}${{ fmt(summary.todaysPnl) }}
        </div>
        <div class="text-xs text-white/40 mt-1">Limit: -${{ fmt(summary.settings?.daily_loss_limit_usd) }}</div>
        <div class="hud-node-row" aria-hidden="true"><span v-for="i in 9" :key="i" /></div>
      </GlassCard>

      <GlassCard title="Kill switch" class="bento-span-3 min-h-[190px]">
        <div class="hud-value font-headline text-4xl" :class="killSwitchEngaged ? 'text-danger' : 'text-accent'">
          {{ killSwitchEngaged ? 'ENGAGED' : 'CLEAR' }}
        </div>
        <div class="text-xs text-white/40 mt-1">Trading {{ summary.settings?.trading_enabled ? 'enabled' : 'disabled' }}</div>
        <div class="hud-readout" aria-hidden="true"><span v-for="i in 12" :key="i" /></div>
      </GlassCard>

      <GlassCard title="Open positions" class="bento-span-2 min-h-[190px]">
        <div class="hud-value font-headline text-5xl">{{ summary.positions?.length || 0 }}</div>
        <div class="text-xs text-white/40 mt-1">Max {{ summary.settings?.max_trades_per_symbol_per_24h }} trades/symbol/24h</div>
      </GlassCard>

      <GlassCard title="Positions" class="bento-span-7">
        <div class="grid grid-cols-1 lg:grid-cols-[1fr_220px] gap-4">
          <HudLineChart :values="telemetryValues" />
          <div class="hud-stat-grid lg:grid-cols-1">
            <div class="hud-stat">
              <strong>{{ summary.positions?.length || 0 }}</strong>
              <span>open vectors</span>
            </div>
            <div class="hud-stat">
              <strong>{{ summary.recentOrders?.length || 0 }}</strong>
              <span>recent orders</span>
            </div>
            <div class="hud-stat">
              <strong>{{ summary.settings?.trading_enabled ? 'ON' : 'SIM' }}</strong>
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
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in summary.positions" :key="p.id">
              <td class="font-medium">{{ p.symbol }}</td>
              <td>{{ p.quantity }}</td>
              <td>${{ fmt(p.avg_cost_usd) }}</td>
            </tr>
          </tbody>
        </v-table>
        <div v-else class="text-white/40 text-sm">No open positions.</div>
      </GlassCard>

      <GlassCard title="Recent orders" class="bento-span-5 -mt-6 lg:mt-10">
        <div class="grid grid-cols-[170px_1fr] gap-4 items-center mb-4">
          <HudDoughnutChart
            :values="allocationValues"
            :center-value="killSwitchEngaged ? 'HALT' : 'SIM'"
            center-label="state"
          />
          <div class="hud-card-meta">
            <span class="hud-chip">cash {{ fmt(summary.brokerAccount?.cash_balance_usd) }}</span>
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
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import api from '../api/client';
import GlassCard from '../components/GlassCard.vue';
import GlassButton from '../components/GlassButton.vue';
import HudDoughnutChart from '../components/HudDoughnutChart.vue';
import HudLineChart from '../components/HudLineChart.vue';

const summary = ref({});
const loading = ref(true);
const toggling = ref(false);

const killSwitchEngaged = computed(() => Boolean(summary.value.settings?.kill_switch_engaged));
const telemetryValues = computed(() => {
  const pnl = Number(summary.value.todaysPnl || 0);
  const cash = Number(summary.value.brokerAccount?.cash_balance_usd || 0);
  const positions = Number(summary.value.positions?.length || 0);
  return [18, 26 + positions * 4, 31, 28 + cash / 12, 38 + pnl, 35 + positions * 6, 46 + cash / 10].map((n) =>
    Math.max(4, Number(n.toFixed(2)))
  );
});
const allocationValues = computed(() => {
  const cash = Math.max(1, Number(summary.value.brokerAccount?.cash_balance_usd || 0) || 42);
  const positions = Math.max(1, Number(summary.value.positions?.length || 0) * 12);
  const orders = Math.max(1, Number(summary.value.recentOrders?.length || 0) * 8);
  return [cash, positions, orders, 18];
});

function fmt(n) {
  return Number(n ?? 0).toFixed(2);
}

async function load() {
  loading.value = true;
  const { data } = await api.get('/dashboard/summary');
  summary.value = data;
  loading.value = false;
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
