<template>
  <div class="page-shell trading-dashboard">
    <div class="trade-command-bar glass-panel">
      <div class="trade-brand">
        <span class="trade-mark">AT</span>
        <div class="min-w-0">
          <div class="trade-title">AUTOTRADER MARKET OPS</div>
          <div class="trade-tape">
            <span>{{ operatingMode }}</span>
            <span>{{ marketClock }}</span>
            <span>{{ summary.positions?.length || 0 }} POS</span>
            <span>{{ summary.latestReports?.length || 0 }} RPT</span>
          </div>
        </div>
      </div>

      <div class="trade-search mini-glass">
        <v-icon icon="mdi-magnify" size="15" />
        <input v-model="symbolFilter" placeholder="filter symbols, reports, orders" />
      </div>

      <div class="trade-toolbar">
        <button class="hud-window-toggle" :class="{ active: activeWindow === 'positions' }" @click="openWindow('positions')">
          <v-icon size="15">mdi-chart-box-outline</v-icon>
          positions
        </button>
        <button class="hud-window-toggle" :class="{ active: activeWindow === 'leaderboard' }" @click="openWindow('leaderboard')">
          <v-icon size="15">mdi-podium</v-icon>
          board
        </button>
        <button class="hud-window-toggle" :class="{ active: activeWindow === 'reports' }" @click="openWindow('reports')">
          <v-icon size="15">mdi-file-chart-outline</v-icon>
          reports
        </button>
        <button class="hud-window-toggle" :class="{ active: activeWindow === 'orders' }" @click="openWindow('orders')">
          <v-icon size="15">mdi-swap-horizontal</v-icon>
          tape
        </button>
        <button class="hud-window-toggle" :class="{ active: activeWindow === 'bmcl' }" @click="openWindow('bmcl')">
          <v-icon size="15">mdi-lan-connect</v-icon>
          bmcl
        </button>
        <GlassButton :danger="!killSwitchEngaged" class="trade-kill-button" @click="toggleKillSwitch" :disabled="toggling">
          <v-icon :icon="killSwitchEngaged ? 'mdi-play' : 'mdi-stop-circle'" size="16" class="mr-1" />
          {{ killSwitchEngaged ? 'Resume' : 'Kill' }}
        </GlassButton>
      </div>
    </div>

    <div v-if="loading" class="glass-panel p-4 text-white/50 text-sm">Loading trading surface...</div>

    <grid-layout
      v-else
      v-model:layout="layout"
      :col-num="12"
      :row-height="72"
      :margin="[12, 12]"
      :is-draggable="true"
      :is-resizable="true"
      :vertical-compact="true"
      :use-css-transforms="true"
      class="widget-grid trading-widget-grid"
      @layout-updated="onLayoutUpdated"
    >
      <grid-item v-for="item in layout" :key="item.i" v-bind="item" drag-allow-from=".widget-drag-handle">
        <GlassCard v-if="item.i === 'portfolio-pulse'" title="Portfolio pulse" class="h-full widget-card trading-card">
          <template #actions><CardActions @expand="openWindow('positions')" /></template>
          <div class="trade-metric-main">
            <div>
              <span class="trade-metric-label">equity</span>
              <strong>${{ fmt(summary.portfolioValueUsd) }}</strong>
            </div>
            <div :class="summary.todaysPnl < 0 ? 'trade-delta danger' : 'trade-delta'">
              {{ summary.todaysPnl >= 0 ? '+' : '' }}${{ fmt(summary.todaysPnl) }}
            </div>
          </div>
          <div class="trade-spark">
            <HudAreaChart
              :labels="portfolioChart.labels"
              :series="portfolioChart.series"
              value-prefix="$"
              aria-label="Portfolio exposure chart"
            />
          </div>
          <div class="trade-micro-grid">
            <MetricMicro label="cash" :value="`$${fmt(summary.brokerAccount?.cash_balance_usd)}`" />
            <MetricMicro label="positions" :value="`$${fmt(summary.positionsMarketValueUsd)}`" />
            <MetricMicro label="basis" :value="`$${fmt(summary.positionsCostBasisUsd)}`" />
            <MetricMicro label="buying" :value="`$${fmt(summary.brokerAccount?.buying_power_usd)}`" />
          </div>
        </GlassCard>

        <GlassCard v-else-if="item.i === 'position-exposure'" title="Position exposure" class="h-full widget-card trading-card">
          <template #actions><CardActions @expand="openWindow('positions')" /></template>
          <div class="trade-split">
            <HudDoughnutChart
              :values="allocationValues"
              :labels="allocationLabels"
              :center-value="String(summary.positions?.length || 0)"
              center-label="open"
            />
            <div class="dense-stack">
              <button
                v-for="p in filteredPositions.slice(0, 5)"
                :key="p.id"
                class="ticker-row"
                @click="openWindow('positions', p.symbol)"
              >
                <span>
                  <strong>{{ p.symbol }}</strong>
                  <small>{{ p.quantity }} @ ${{ fmt(p.market_price_usd) }}</small>
                </span>
                <span :class="p.unrealized_pnl_usd < 0 ? 'text-danger' : 'text-accent'">
                  {{ p.unrealized_pnl_usd >= 0 ? '+' : '' }}${{ fmt(p.unrealized_pnl_usd) }}
                </span>
              </button>
              <div v-if="!filteredPositions.length" class="empty-dense">No open positions.</div>
            </div>
          </div>
        </GlassCard>

        <GlassCard v-else-if="item.i === 'leaderboard'" title="Stock leaderboard" class="h-full widget-card trading-card">
          <template #actions><CardActions @expand="openWindow('leaderboard')" /></template>
          <div class="leader-chart">
            <HudBarChart
              :labels="leaderboardChart.labels"
              :values="leaderboardChart.values"
              :colors="leaderboardChart.colors"
              dataset-label="score"
              aria-label="Stock leaderboard scores"
            />
          </div>
          <div class="leader-list">
            <button
              v-for="row in filteredLeaderboard.slice(0, 6)"
              :key="`${row.symbol}-${row.source}`"
              class="leader-row"
              @click="openWindow('leaderboard', row.symbol)"
            >
              <span class="rank">{{ row.rank }}</span>
              <span class="sym">{{ row.symbol }}</span>
              <span class="bias" :class="row.action === 'sell' ? 'danger' : row.action === 'buy' ? 'accent' : ''">{{ row.action }}</span>
              <span class="score">{{ row.score }}</span>
            </button>
            <div v-if="!filteredLeaderboard.length" class="empty-dense">No ranked symbols yet.</div>
          </div>
        </GlassCard>

        <GlassCard v-else-if="item.i === 'research-reports'" title="Research reports" class="h-full widget-card trading-card">
          <template #actions><CardActions @expand="openWindow('reports')" /></template>
          <div class="report-terminal">
            <button
              v-for="report in filteredReports.slice(0, 4)"
              :key="report.id"
              class="report-tile"
              @click="openWindow('reports', report.id)"
            >
              <span class="report-id">#{{ report.id }}</span>
              <span class="report-mode">{{ report.mode }}</span>
              <strong>{{ report.summary?.actions?.length || 0 }} actions · {{ report.summary?.sourceStack?.length || 0 }} src</strong>
              <small>{{ report.summary?.researchNarrative?.summary || report.summary?.overallRationale || 'Decision evidence pending.' }}</small>
            </button>
            <div v-if="!filteredReports.length" class="empty-dense">No research reports yet.</div>
          </div>
        </GlassCard>

        <GlassCard v-else-if="item.i === 'order-flow'" title="Order flow" class="h-full widget-card trading-card">
          <template #actions><CardActions @expand="openWindow('orders')" /></template>
          <div class="order-tape">
            <div v-for="order in filteredOrders.slice(0, 8)" :key="order.id" class="order-tape-row">
              <span class="side" :class="order.side === 'buy' ? 'accent' : 'danger'">{{ order.side }}</span>
              <strong>{{ order.symbol }}</strong>
              <span>{{ order.quantity }}</span>
              <small>{{ order.status }}</small>
            </div>
            <div v-if="!filteredOrders.length" class="empty-dense">No order flow yet.</div>
          </div>
          <div class="trade-micro-grid mt-3">
            <MetricMicro label="orders" :value="String(summary.recentOrders?.length || 0)" />
            <MetricMicro label="buys" :value="String(orderStats.buys)" />
            <MetricMicro label="sells" :value="String(orderStats.sells)" />
            <MetricMicro label="open pnl" :value="`${openPnlSign}$${fmt(Math.abs(summary.unrealizedPnlUsd || 0))}`" />
          </div>
        </GlassCard>

        <GlassCard v-else-if="item.i === 'risk-control'" title="Risk control" class="h-full widget-card trading-card" :tone="killSwitchEngaged ? 'danger' : 'default'">
          <template #actions><CardActions @expand="openWindow('reports')" /></template>
          <div class="risk-grid">
            <div class="risk-core" :class="{ danger: killSwitchEngaged }">
              <span>{{ killSwitchEngaged ? 'HALT' : executionState }}</span>
            </div>
            <div class="dense-stack risk-control-stack">
              <div class="risk-control-line">
                <span>trading</span>
                <button
                  class="cyber-switch"
                  :class="{ active: tradingEnabled }"
                  :aria-pressed="tradingEnabled"
                  :disabled="savingSetting"
                  @click="requestTradingToggle"
                >
                  <span class="cyber-switch-track"><span /></span>
                  <strong>{{ tradingEnabled ? 'live' : 'paused' }}</strong>
                </button>
              </div>
              <div class="risk-control-line">
                <span>simulation</span>
                <button
                  class="cyber-switch"
                  :class="{ active: simulationEnabled }"
                  :aria-pressed="simulationEnabled"
                  :disabled="savingSetting"
                  @click="requestSimulationToggle"
                >
                  <span class="cyber-switch-track"><span /></span>
                  <strong>{{ simulationEnabled ? 'on' : 'off' }}</strong>
                </button>
              </div>
              <div class="risk-control-line">
                <span>trade cap</span>
                <div class="cap-stepper">
                  <button :disabled="savingSetting || tradeCap <= 1" aria-label="Lower trade cap" @click="requestTradeCap(tradeCap - 1)">
                    <v-icon size="13">mdi-minus</v-icon>
                  </button>
                  <strong>{{ tradeCap }}/symbol</strong>
                  <button :disabled="savingSetting || tradeCap >= 10" aria-label="Raise trade cap" @click="requestTradeCap(tradeCap + 1)">
                    <v-icon size="13">mdi-plus</v-icon>
                  </button>
                </div>
              </div>
              <MetricLine label="acct" :value="summary.brokerAccount?.status || 'unknown'" />
            </div>
          </div>
          <div class="risk-scanline" aria-hidden="true"><span v-for="i in 18" :key="i" /></div>
        </GlassCard>

        <GlassCard v-else-if="item.i === 'report-actions'" title="Decision actions" class="h-full widget-card trading-card">
          <template #actions><CardActions @expand="openWindow('reports')" /></template>
          <div class="dense-table">
            <div class="dense-head">
              <span>symbol</span><span>action</span><span>score</span><span>status</span>
            </div>
            <button
              v-for="action in latestActions.slice(0, 8)"
              :key="`${action.symbol}-${action.action}-${action.status}`"
              class="dense-row"
              @click="openWindow('reports', action.symbol)"
            >
              <strong>{{ action.symbol }}</strong>
              <span :class="action.action === 'buy' ? 'text-accent' : action.action === 'sell' ? 'text-danger' : 'text-white/55'">{{ action.action }}</span>
              <span>{{ action.evidence?.localAiScore || action.localAiScore || 'n/a' }}</span>
              <small>{{ action.status || action.actionBias || 'review' }}</small>
            </button>
            <div v-if="!latestActions.length" class="empty-dense">No decision actions yet.</div>
          </div>
        </GlassCard>

        <GlassCard v-else-if="item.i === 'account-matrix'" title="Account matrix" class="h-full widget-card trading-card">
          <template #actions><CardActions @expand="openWindow('positions')" /></template>
          <div class="matrix-grid">
            <MetricMicro label="mode" :value="executionState" />
            <MetricMicro label="realized" :value="`${pnlSign}$${fmt(Math.abs(summary.realizedTodayPnl || 0))}`" />
            <MetricMicro label="unrealized" :value="`${openPnlSign}$${fmt(Math.abs(summary.unrealizedPnlUsd || 0))}`" />
            <MetricMicro label="cash %" :value="`${cashWeight}%`" />
          </div>
        </GlassCard>

        <GlassCard v-else-if="item.i === 'alpaca-status'" title="Alpaca broker" class="h-full widget-card trading-card">
          <template #actions><CardActions @expand="openWindow('orders')" /></template>
          <div class="alpaca-status-grid">
            <div class="alpaca-mode-badge" :class="{ live: alpacaDashboard.mode === 'live' }">
              <span>{{ alpacaDashboard.mode }}</span>
              <small>{{ alpacaDashboard.configured ? 'configured' : 'missing keys' }}</small>
            </div>
            <div class="matrix-grid">
              <MetricMicro label="balance" :value="`$${fmt(alpacaDashboard.cashBalanceUsd)}`" />
              <MetricMicro label="buying" :value="`$${fmt(alpacaDashboard.buyingPowerUsd)}`" />
              <MetricMicro label="month" :value="String(alpacaDashboard.tradeCounts.month)" />
              <MetricMicro label="quarter" :value="String(alpacaDashboard.tradeCounts.quarter)" />
              <MetricMicro label="year" :value="String(alpacaDashboard.tradeCounts.year)" />
              <MetricMicro label="acct" :value="alpacaDashboard.accountId ? 'linked' : 'none'" />
            </div>
          </div>
        </GlassCard>

        <GlassCard v-else-if="item.i === 'simulation-funding'" title="Simulation funding" class="h-full widget-card trading-card">
          <template #actions><CardActions @expand="refreshDashboardWidgets" /></template>
          <div class="simulation-funding-form">
            <v-text-field v-model.number="fundingDraft.amountUsd" type="number" min="0.01" step="1" label="Amount" variant="outlined" density="compact" hide-details />
            <v-select v-model="fundingDraft.cadence" :items="fundingCadenceItems" label="Cadence" variant="outlined" density="compact" hide-details />
            <v-text-field v-model="fundingDraft.timeOfDay" type="time" label="Time" variant="outlined" density="compact" hide-details />
            <v-select v-if="fundingDraft.cadence === 'weekly'" v-model="fundingDraft.weekday" :items="fundingWeekdayItems" label="Day" variant="outlined" density="compact" hide-details />
            <v-text-field v-if="fundingDraft.cadence === 'monthly'" v-model.number="fundingDraft.monthDay" type="number" min="1" max="28" label="Day" variant="outlined" density="compact" hide-details />
            <div class="simulation-funding-actions">
              <GlassButton :disabled="fundingBusy || !simulationEnabled" @click="addSimulationCashNow">
                add now
              </GlassButton>
              <GlassButton variant="ghost" :disabled="fundingBusy || !simulationEnabled || fundingDraft.cadence === 'once'" @click="scheduleSimulationCash">
                schedule
              </GlassButton>
            </div>
          </div>
          <div v-if="fundingError" class="text-danger text-xs mt-2">{{ fundingError }}</div>
          <div class="trade-micro-grid mt-3">
            <MetricMicro label="cash" :value="`$${fmt(fundingDashboard.cashUsd)}`" />
            <MetricMicro label="deployed" :value="`$${fmt(fundingDashboard.deployedUsd)}`" />
            <MetricMicro label="added" :value="`$${fmt(fundingDashboard.totalAddedUsd)}`" />
            <MetricMicro label="rules" :value="String(fundingDashboard.rules.length)" />
          </div>
          <div class="funding-feed mt-3">
            <div v-for="event in fundingDashboard.events.slice(0, 3)" :key="event.id" class="funding-row">
              <strong>+${{ fmt(event.amount_usd) }}</strong>
              <span>{{ compactDate(event.created_at) }}</span>
            </div>
            <div v-if="!fundingDashboard.events.length" class="empty-dense">
              No extra funding events yet. Starting cash and simulated trades are tracked in cash/deployed.
            </div>
          </div>
        </GlassCard>

        <GlassCard v-else-if="item.i === 'bmcl-conversations'" title="BMCL messages" class="h-full widget-card trading-card">
          <template #actions><CardActions @expand="openWindow('bmcl')" /></template>
          <div class="bmcl-card-head">
            <MetricMicro label="batches" :value="String(filteredBmclConversations.length)" />
            <MetricMicro label="latest" :value="compactDate(filteredBmclConversations[0]?.updated_at)" />
          </div>
          <div class="bmcl-summary-list">
            <button
              v-for="conversation in filteredBmclConversations.slice(0, 50)"
              :key="conversation.id"
              class="bmcl-summary-row"
              @click="openBmclConversation(conversation)"
            >
              <span class="bmcl-topic">
                <strong>{{ conversation.topic }}</strong>
                <small>{{ compactDate(conversation.updated_at) }} · {{ conversation.messageCount }} frames</small>
              </span>
              <span class="bmcl-summary">{{ conversation.summary }}</span>
              <span class="bmcl-op">{{ conversation.lastOperation }}</span>
            </button>
            <div v-if="!filteredBmclConversations.length" class="empty-dense">No completed BMCL message batches yet.</div>
          </div>
        </GlassCard>
      </grid-item>
    </grid-layout>

    <div
      v-if="activeWindow"
      class="floating-data-window glass-panel"
      :style="{ transform: `translate(${windowPosition.x}px, ${windowPosition.y}px)` }"
    >
      <div class="floating-window-head" @pointerdown="startWindowDrag" @mousedown="startWindowDrag">
        <div>
          <strong>{{ windowTitle }}</strong>
          <small>{{ windowSubtitle }}</small>
        </div>
        <button type="button" @click="activeWindow = ''" aria-label="Close data window">
          <v-icon icon="mdi-close" size="18" />
        </button>
      </div>

      <div class="floating-window-body">
        <template v-if="activeWindow === 'positions'">
          <v-table density="compact" class="bg-transparent dense-vtable">
            <thead>
              <tr><th>Symbol</th><th>Qty</th><th>Avg</th><th>Market</th><th>Value</th><th>P&L</th><th>Quote</th></tr>
            </thead>
            <tbody>
              <tr v-for="p in filteredPositions" :key="p.id">
                <td>{{ p.symbol }}</td><td>{{ p.quantity }}</td><td>${{ fmt(p.avg_cost_usd) }}</td><td>${{ fmt(p.market_price_usd) }}</td><td>${{ fmt(p.market_value_usd) }}</td>
                <td :class="p.unrealized_pnl_usd < 0 ? 'text-danger' : 'text-accent'">{{ p.unrealized_pnl_usd >= 0 ? '+' : '' }}${{ fmt(p.unrealized_pnl_usd) }}</td>
                <td>{{ p.quote_source }}</td>
              </tr>
            </tbody>
          </v-table>
        </template>

        <template v-else-if="activeWindow === 'leaderboard'">
          <div class="float-grid">
            <div v-for="row in filteredLeaderboard" :key="`${row.symbol}-${row.rank}`" class="float-card mini-glass">
              <div class="float-card-top">
                <strong>{{ row.rank }} · {{ row.symbol }}</strong>
                <span :class="row.action === 'sell' ? 'text-danger' : row.action === 'buy' ? 'text-accent' : 'text-white/55'">{{ row.action }}</span>
              </div>
              <div class="float-score">{{ row.score }}</div>
              <small>{{ row.reason }}</small>
            </div>
          </div>
        </template>

        <template v-else-if="activeWindow === 'reports'">
          <div class="float-report-list">
            <article v-for="report in filteredReports" :key="report.id" class="mini-glass float-report">
              <div class="float-card-top">
                <strong>Report #{{ report.id }}</strong>
                <span>{{ report.mode }}</span>
              </div>
              <p>{{ report.summary?.researchNarrative?.summary || report.summary?.overallRationale || 'No narrative captured.' }}</p>
              <div class="dense-table mt-3">
                <div class="dense-head"><span>symbol</span><span>action</span><span>score</span><span>status</span></div>
                <div v-for="a in (report.summary?.actions || []).slice(0, 8)" :key="`${report.id}-${a.symbol}-${a.action}`" class="dense-row static-row">
                  <strong>{{ a.symbol }}</strong>
                  <span :class="a.action === 'buy' ? 'text-accent' : a.action === 'sell' ? 'text-danger' : 'text-white/55'">{{ a.action }}</span>
                  <span>{{ a.evidence?.localAiScore || a.localAiScore || 'n/a' }}</span>
                  <small>{{ a.status || 'review' }}</small>
                </div>
              </div>
            </article>
          </div>
        </template>

        <template v-else-if="activeWindow === 'orders'">
          <v-table density="compact" class="bg-transparent dense-vtable">
            <thead>
              <tr><th>Symbol</th><th>Side</th><th>Qty</th><th>Status</th><th>Type</th><th>Created</th></tr>
            </thead>
            <tbody>
              <tr v-for="o in filteredOrders" :key="o.id">
                <td>{{ o.symbol }}</td>
                <td :class="o.side === 'buy' ? 'text-accent' : 'text-danger'">{{ o.side }}</td>
                <td>{{ o.quantity }}</td>
                <td>{{ o.status }}</td>
                <td>{{ o.order_type || o.type || 'market' }}</td>
                <td>{{ compactDate(o.created_at) }}</td>
              </tr>
            </tbody>
          </v-table>
        </template>

        <template v-else-if="activeWindow === 'bmcl'">
          <div v-if="!selectedBmclConversation" class="empty-dense">Select a completed BMCL message batch from the dashboard card.</div>
          <div v-else class="bmcl-conversation-detail">
            <div class="bmcl-detail-summary mini-glass">
              <div>
                <span>topic</span>
                <strong>{{ selectedBmclConversation.topic }}</strong>
              </div>
              <div>
                <span>frames</span>
                <strong>{{ selectedBmclConversation.messageCount }}</strong>
              </div>
              <div>
                <span>completed</span>
                <strong>{{ compactDate(selectedBmclConversation.updated_at) }}</strong>
              </div>
            </div>
            <p class="bmcl-detail-copy">{{ selectedBmclConversation.summary }}</p>
            <div v-if="bmclLoading" class="empty-dense">Loading BMCL transcript...</div>
            <div v-else class="bmcl-transcript">
              <article v-for="message in bmclMessages" :key="message.id" class="bmcl-frame mini-glass">
                <div class="bmcl-frame-head">
                  <strong>{{ message.sender }}</strong>
                  <span>{{ message.kind }} · {{ message.op }}</span>
                  <small>{{ compactDate(message.created_at) }}</small>
                </div>
                <div class="bmcl-frame-route">{{ message.recipient }}</div>
                <pre>{{ summarizeEnvelope(message.envelope) }}</pre>
              </article>
              <div v-if="!bmclMessages.length" class="empty-dense">No BMCL frames were retained for this message batch.</div>
            </div>
          </div>
        </template>
      </div>
    </div>

    <div v-if="confirmDialog.open" class="modal-backdrop">
      <div class="glass-panel modal-card risk-confirm-modal p-6">
        <div class="modal-heading">
          <div>
            <div class="font-display text-xl mb-1">{{ confirmDialog.title }}</div>
            <div class="text-sm text-white/50">{{ confirmDialog.subtitle }}</div>
          </div>
          <button class="hud-chip hud-chip-button" @click="closeConfirm">
            <v-icon size="16">mdi-close</v-icon>
          </button>
        </div>
        <div class="risk-confirm-body">
          <p>{{ confirmDialog.message }}</p>
          <div class="risk-confirm-grid">
            <div>
              <span>current</span>
              <strong>{{ confirmDialog.current }}</strong>
            </div>
            <div>
              <span>new</span>
              <strong>{{ confirmDialog.next }}</strong>
            </div>
          </div>
          <div class="risk-confirm-note">{{ confirmDialog.ramification }}</div>
          <div v-if="confirmDialog.error" class="text-danger text-sm">{{ confirmDialog.error }}</div>
        </div>
        <div class="flex justify-end gap-3 mt-5">
          <GlassButton variant="ghost" @click="closeConfirm">Cancel</GlassButton>
          <GlassButton :danger="confirmDialog.danger" :disabled="savingSetting" @click="confirmSettingChange">
            {{ savingSetting ? 'Applying...' : confirmDialog.confirmLabel }}
          </GlassButton>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue';
import { GridLayout, GridItem } from 'vue3-grid-layout-next';
import api from '../api/client';
import GlassCard from '../components/GlassCard.vue';
import GlassButton from '../components/GlassButton.vue';
import HudAreaChart from '../components/HudAreaChart.vue';
import HudBarChart from '../components/HudBarChart.vue';
import HudDoughnutChart from '../components/HudDoughnutChart.vue';

const MetricMicro = defineComponent({
  props: { label: String, value: [String, Number] },
  setup(props) {
    return () => h('div', { class: 'metric-micro' }, [
      h('span', props.label),
      h('strong', props.value ?? '0'),
    ]);
  },
});

const MetricLine = defineComponent({
  props: { label: String, value: [String, Number] },
  setup(props) {
    return () => h('div', { class: 'metric-line' }, [
      h('span', props.label),
      h('strong', props.value ?? 'n/a'),
    ]);
  },
});

const CardActions = defineComponent({
  emits: ['expand'],
  setup(_, { emit }) {
    return () => h('div', { class: 'card-actions' }, [
      h('button', {
        type: 'button',
        class: 'icon-chip',
        onClick: () => emit('expand'),
        'aria-label': 'Open floating detail window',
      }, [h('i', { class: 'mdi mdi-arrow-expand-all' })]),
      h('span', { class: 'widget-drag-handle', 'aria-hidden': 'true' }, [h('i', { class: 'mdi mdi-drag' })]),
    ]);
  },
});

const DASHBOARD_LAYOUT_VERSION = 7;

const DEFAULT_LAYOUT = [
  { i: 'portfolio-pulse', x: 0, y: 0, w: 4, h: 4 },
  { i: 'leaderboard', x: 4, y: 0, w: 4, h: 4 },
  { i: 'risk-control', x: 8, y: 0, w: 4, h: 4 },
  { i: 'account-matrix', x: 8, y: 4, w: 4, h: 2 },
  { i: 'position-exposure', x: 8, y: 6, w: 4, h: 4 },
  { i: 'research-reports', x: 0, y: 4, w: 4, h: 4 },
  { i: 'report-actions', x: 4, y: 4, w: 4, h: 4 },
  { i: 'order-flow', x: 8, y: 10, w: 4, h: 3 },
  { i: 'alpaca-status', x: 0, y: 8, w: 4, h: 3 },
  { i: 'simulation-funding', x: 4, y: 8, w: 4, h: 4 },
  { i: 'bmcl-conversations', x: 0, y: 12, w: 8, h: 4 },
];

const summary = ref({});
const loading = ref(true);
const toggling = ref(false);
const symbolFilter = ref('');
const activeWindow = ref('');
const selectedSymbol = ref('');
const selectedBmclConversation = ref(null);
const bmclMessages = ref([]);
const bmclLoading = ref(false);
const fundingBusy = ref(false);
const fundingError = ref('');
const fundingDraft = ref({
  amountUsd: 10,
  cadence: 'daily',
  timeOfDay: '09:00',
  weekday: 1,
  monthDay: 1,
});
const windowPosition = ref({ x: 0, y: 0 });
const layout = ref(DEFAULT_LAYOUT.map((item) => ({ ...item })));
const savingSetting = ref(false);
const confirmDialog = ref({
  open: false,
  title: '',
  subtitle: '',
  message: '',
  current: '',
  next: '',
  ramification: '',
  confirmLabel: 'Apply change',
  danger: false,
  patch: null,
  error: '',
});
let saveTimer = null;
let dragStart = null;
let refreshTimer = null;

const killSwitchEngaged = computed(() => Boolean(summary.value.settings?.kill_switch_engaged));
const tradingEnabled = computed(() => Boolean(summary.value.settings?.trading_enabled));
const simulationEnabled = computed(() => Boolean(summary.value.settings?.simulation_mode_enabled));
const tradeCap = computed(() => Math.max(1, Math.min(10, Number(summary.value.settings?.max_trades_per_symbol_per_24h || 1))));
const executionState = computed(() => {
  if (killSwitchEngaged.value) return 'HALT';
  if (simulationEnabled.value) return 'SIM';
  return tradingEnabled.value ? 'LIVE' : 'SIM';
});
const operatingMode = computed(() => String(summary.value.operatingMode || executionState.value || 'standby').toUpperCase());
const marketClock = computed(() => new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }));
const pnlSign = computed(() => (Number(summary.value.realizedTodayPnl || 0) >= 0 ? '+' : '-'));
const openPnlSign = computed(() => (Number(summary.value.unrealizedPnlUsd || 0) >= 0 ? '+' : '-'));
const query = computed(() => symbolFilter.value.trim().toLowerCase());

const filteredPositions = computed(() => filterBySymbol(summary.value.positions || [], ['symbol', 'quote_source']));
const filteredOrders = computed(() => filterBySymbol(summary.value.recentOrders || [], ['symbol', 'side', 'status']));
const filteredReports = computed(() => {
  const reports = summary.value.latestReports || [];
  if (!query.value) return reports;
  return reports.filter((report) => {
    const text = [
      report.id,
      report.mode,
      report.summary?.overallRationale,
      report.summary?.researchNarrative?.summary,
      ...(report.summary?.actions || []).map((action) => `${action.symbol} ${action.action} ${action.status}`),
    ].join(' ').toLowerCase();
    return text.includes(query.value);
  });
});

const filteredBmclConversations = computed(() => {
  const conversations = summary.value.bmclConversations || [];
  if (!query.value) return conversations;
  return conversations.filter((conversation) => [
    conversation.id,
    conversation.topic,
    conversation.summary,
    conversation.lastOperation,
    ...(conversation.participants || []),
    ...(conversation.operations || []),
  ].join(' ').toLowerCase().includes(query.value));
});

const latestActions = computed(() => {
  const reports = summary.value.latestReports || [];
  return reports.flatMap((report) => (report.summary?.actions || []).map((action) => ({
    ...action,
    reportId: report.id,
    reportMode: report.mode,
  }))).slice(0, 24);
});

const stockLeaderboard = computed(() => {
  const rows = new Map();
  for (const position of summary.value.positions || []) {
    upsertLeaderboard(rows, position.symbol, {
      action: Number(position.unrealized_pnl_usd || 0) >= 0 ? 'hold' : 'review',
      score: Math.round(50 + Math.max(-25, Math.min(25, Number(position.unrealized_pnl_usd || 0)))),
      source: 'position',
      reason: `${position.quantity} shares, open P&L ${position.unrealized_pnl_usd >= 0 ? '+' : ''}$${fmt(position.unrealized_pnl_usd)}`,
    });
  }
  for (const action of latestActions.value) {
    const score = Number(action.evidence?.localAiScore || action.localAiScore || action.score || 50);
    upsertLeaderboard(rows, action.symbol, {
      action: action.action || action.actionBias || 'hold',
      score,
      source: `report-${action.reportId}`,
      reason: action.reason || action.status || `decision report #${action.reportId}`,
    });
  }
  return [...rows.values()]
    .sort((a, b) => b.score - a.score)
    .map((row, index) => ({ ...row, rank: index + 1 }));
});

const filteredLeaderboard = computed(() => filterBySymbol(stockLeaderboard.value, ['symbol', 'action', 'reason', 'source']));

const leaderboardChart = computed(() => {
  const rows = filteredLeaderboard.value.slice(0, 6);
  return {
    labels: rows.map((row) => row.symbol),
    values: rows.map((row) => row.score),
    colors: rows.map((row) => row.action === 'sell' ? '#ff3d81' : row.action === 'buy' ? '#1ed6ff' : '#7c5cff'),
  };
});

const portfolioChart = computed(() => {
  const positions = summary.value.positions || [];
  const labels = positions.length ? positions.map((position) => position.symbol) : ['cash', 'positions'];
  return {
    labels,
    series: [
      { label: 'Market', values: positions.length ? positions.map((p) => Number(p.market_value_usd || 0)) : [Number(summary.value.brokerAccount?.cash_balance_usd || 0), Number(summary.value.positionsMarketValueUsd || 0)], color: '#1ed6ff' },
      { label: 'Basis', values: positions.length ? positions.map((p) => Number(p.cost_basis_usd || 0)) : [0, Number(summary.value.positionsCostBasisUsd || 0)], color: '#7c5cff' },
    ],
  };
});

const allocationLabels = computed(() => (summary.value.positions || []).slice(0, 5).map((p) => p.symbol).concat(['Cash']));
const allocationValues = computed(() => {
  const positionValues = (summary.value.positions || []).slice(0, 5).map((p) => Math.max(1, Number(p.market_value_usd || 0)));
  return positionValues.concat([Math.max(1, Number(summary.value.brokerAccount?.cash_balance_usd || 0))]);
});

const orderStats = computed(() => {
  const orders = summary.value.recentOrders || [];
  return {
    buys: orders.filter((order) => order.side === 'buy').length,
    sells: orders.filter((order) => order.side === 'sell').length,
  };
});

const cashWeight = computed(() => {
  const cash = Number(summary.value.brokerAccount?.cash_balance_usd || 0);
  const total = Number(summary.value.portfolioValueUsd || 0);
  return total ? Math.round((cash / total) * 100) : 0;
});

const fundingDashboard = computed(() => ({
  rules: summary.value.simulationFunding?.rules || [],
  events: summary.value.simulationFunding?.events || [],
  totalAddedUsd: Number(summary.value.simulationFunding?.totalAddedUsd || 0),
  cashUsd: Number(summary.value.brokerAccount?.cash_balance_usd || 0),
  deployedUsd: Number(summary.value.positionsCostBasisUsd || 0),
  startingCashUsd: Number(summary.value.settings?.simulation_starting_cash_usd || 0),
}));

const fundingCadenceItems = [
  { title: 'Daily', value: 'daily' },
  { title: 'Weekly', value: 'weekly' },
  { title: 'Monthly', value: 'monthly' },
];

const fundingWeekdayItems = [
  { title: 'Sunday', value: 0 },
  { title: 'Monday', value: 1 },
  { title: 'Tuesday', value: 2 },
  { title: 'Wednesday', value: 3 },
  { title: 'Thursday', value: 4 },
  { title: 'Friday', value: 5 },
  { title: 'Saturday', value: 6 },
];

const alpacaDashboard = computed(() => ({
  mode: summary.value.alpacaAccount?.mode || 'paper',
  configured: Boolean(summary.value.alpacaAccount?.configured),
  accountId: summary.value.alpacaAccount?.accountId || '',
  cashBalanceUsd: Number(summary.value.alpacaAccount?.cashBalanceUsd || 0),
  buyingPowerUsd: Number(summary.value.alpacaAccount?.buyingPowerUsd || 0),
  tradeCounts: {
    month: Number(summary.value.alpacaAccount?.tradeCounts?.month || 0),
    quarter: Number(summary.value.alpacaAccount?.tradeCounts?.quarter || 0),
    year: Number(summary.value.alpacaAccount?.tradeCounts?.year || 0),
  },
}));

const windowTitle = computed(() => ({
  positions: 'Position ledger',
  leaderboard: 'Stock leaderboard',
  reports: 'Research report browser',
  orders: 'Order tape',
  bmcl: 'BMCL messages',
})[activeWindow.value] || 'Inspector');

const windowSubtitle = computed(() => {
  if (activeWindow.value === 'bmcl') return selectedBmclConversation.value?.id || 'completed message batches';
  return selectedSymbol.value || 'live workspace';
});

function upsertLeaderboard(rows, symbol, patch) {
  if (!symbol) return;
  const existing = rows.get(symbol);
  if (!existing || Number(patch.score || 0) > Number(existing.score || 0)) {
    rows.set(symbol, { symbol, ...patch, score: Math.round(Number(patch.score || 0)) });
  }
}

function filterBySymbol(rows, fields) {
  if (!query.value) return rows;
  return rows.filter((row) => fields.some((field) => String(row?.[field] || '').toLowerCase().includes(query.value)));
}

function fmt(n) {
  return Number(n ?? 0).toFixed(2);
}

function compactDate(value) {
  if (!value) return 'n/a';
  return new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
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
      if (parsed?.dashboardVersion === DASHBOARD_LAYOUT_VERSION && Array.isArray(parsed?.dashboard) && parsed.dashboard.length) {
        layout.value = mergeLayout(parsed.dashboard);
      }
    } catch {
      // ignore malformed layout, fall back to default
    }
  }
  loading.value = false;
}

async function refreshDashboardWidgets() {
  try {
    const { data } = await api.get('/dashboard/summary');
    summary.value = data;
  } catch {
    // Keep the current dashboard state if a periodic refresh misses.
  }
}

function mergeLayout(saved) {
  const byId = new Map(saved.map((item) => [item.i, item]));
  return DEFAULT_LAYOUT.map((item) => ({ ...item, ...(byId.get(item.i) || {}) }));
}

function onLayoutUpdated(newLayout) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    api.patch('/settings', { dashboardLayout: { dashboardVersion: DASHBOARD_LAYOUT_VERSION, dashboard: newLayout } }).catch(() => {});
  }, 600);
}

function openWindow(name, symbol = '') {
  activeWindow.value = activeWindow.value === name && selectedSymbol.value === symbol ? '' : name;
  selectedSymbol.value = symbol ? String(symbol) : '';
  if (name === 'bmcl' && !selectedBmclConversation.value && filteredBmclConversations.value.length) {
    loadBmclConversation(filteredBmclConversations.value[0]);
  }
  if (!windowPosition.value.x && !windowPosition.value.y) {
    windowPosition.value = { x: 0, y: 0 };
  }
}

function openBmclConversation(conversation) {
  selectedBmclConversation.value = conversation;
  activeWindow.value = 'bmcl';
  loadBmclConversation(conversation);
}

async function loadBmclConversation(conversation) {
  if (!conversation?.id) return;
  selectedBmclConversation.value = conversation;
  bmclLoading.value = true;
  try {
    const { data } = await api.get('/brain-mesh/messages', {
      params: { conversationId: conversation.id, limit: 250 },
    });
    bmclMessages.value = [...(data || [])].reverse();
  } finally {
    bmclLoading.value = false;
  }
}

async function addSimulationCashNow() {
  fundingError.value = '';
  fundingBusy.value = true;
  try {
    await postSimulationFunding('/now', {
      amountUsd: Number(fundingDraft.value.amountUsd || 0),
      memo: 'Dashboard simulation cash add',
    });
    await refreshDashboardWidgets();
  } catch (err) {
    fundingError.value = err.response?.data?.error || err.message || 'Unable to add simulation cash.';
  } finally {
    fundingBusy.value = false;
  }
}

async function scheduleSimulationCash() {
  fundingError.value = '';
  fundingBusy.value = true;
  try {
    await postSimulationFunding('/rules', {
      amountUsd: Number(fundingDraft.value.amountUsd || 0),
      cadence: fundingDraft.value.cadence,
      weekday: fundingDraft.value.weekday,
      monthDay: fundingDraft.value.monthDay,
      timeOfDay: fundingDraft.value.timeOfDay,
      memo: `Dashboard ${fundingDraft.value.cadence} simulation funding`,
      runNow: false,
    });
    await refreshDashboardWidgets();
  } catch (err) {
    fundingError.value = err.response?.data?.error || err.message || 'Unable to schedule simulation cash.';
  } finally {
    fundingBusy.value = false;
  }
}

async function postSimulationFunding(path, payload) {
  const aliases = [
    `/dashboard/simulation-funding${path}`,
    `/orders/simulation-funding${path}`,
    `/simulation-funding${path}`,
  ];
  let lastError = null;
  for (const alias of aliases) {
    try {
      return await api.post(alias, payload);
    } catch (err) {
      lastError = err;
      if (err.response?.status !== 404) throw err;
    }
  }
  throw lastError;
}

function summarizeEnvelope(envelope) {
  if (!envelope) return '{}';
  return JSON.stringify(envelope.body || envelope, null, 2);
}

function startWindowDrag(event) {
  if (event.target?.closest?.('button')) return;
  if (dragStart) return;
  event.preventDefault();
  dragStart = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    originX: windowPosition.value.x,
    originY: windowPosition.value.y,
  };
  window.addEventListener('pointermove', onWindowDrag);
  window.addEventListener('mousemove', onWindowDrag);
  document.addEventListener('pointermove', onWindowDrag);
  document.addEventListener('mousemove', onWindowDrag);
  window.addEventListener('pointerup', stopWindowDrag, { once: true });
  window.addEventListener('mouseup', stopWindowDrag, { once: true });
  document.addEventListener('pointerup', stopWindowDrag, { once: true });
  document.addEventListener('mouseup', stopWindowDrag, { once: true });
}

function startWindowDragFromDocument(event) {
  if (!activeWindow.value) return;
  if (!event.target?.closest?.('.floating-data-window .floating-window-head')) return;
  startWindowDrag(event);
}

function onWindowDrag(event) {
  if (!dragStart) return;
  windowPosition.value = {
    x: dragStart.originX + event.clientX - dragStart.startX,
    y: dragStart.originY + event.clientY - dragStart.startY,
  };
}

function stopWindowDrag() {
  dragStart = null;
  window.removeEventListener('pointermove', onWindowDrag);
  window.removeEventListener('mousemove', onWindowDrag);
  document.removeEventListener('pointermove', onWindowDrag);
  document.removeEventListener('mousemove', onWindowDrag);
}

async function toggleKillSwitch() {
  toggling.value = true;
  try {
    const path = killSwitchEngaged.value ? '/settings/kill-switch/release' : '/settings/kill-switch/engage';
    await api.post(path, { reason: 'toggled from dashboard' });
    await refreshDashboardWidgets();
  } finally {
    toggling.value = false;
  }
}

function openConfirm(options) {
  confirmDialog.value = {
    open: true,
    error: '',
    ...options,
  };
}

function closeConfirm() {
  if (savingSetting.value) return;
  confirmDialog.value.open = false;
  confirmDialog.value.error = '';
}

function requestTradingToggle() {
  const next = !tradingEnabled.value;
  openConfirm({
    title: next ? 'Enable live trading' : 'Pause live trading',
    subtitle: 'Execution authority change',
    message: next
      ? 'The engine will be allowed to place broker-backed trades when all live-readiness checks pass.'
      : 'The engine will stop live order execution and continue producing research/simulation decisions only.',
    current: tradingEnabled.value ? 'live enabled' : 'paused',
    next: next ? 'live enabled' : 'paused',
    ramification: next
      ? 'Use this only when credentials, schedule, market hours, and risk limits are ready. Simulation may still override live execution when enabled.'
      : 'Open positions are not automatically sold. New live order placement is halted until trading is enabled again.',
    confirmLabel: next ? 'Enable trading' : 'Pause trading',
    danger: next,
    patch: { tradingEnabled: next },
  });
}

function requestSimulationToggle() {
  const next = !simulationEnabled.value;
  openConfirm({
    title: next ? 'Enable simulation mode' : 'Disable simulation mode',
    subtitle: 'Decision-mode change',
    message: next
      ? 'The system will treat decisions as simulated trades and update simulated balances, P&L, ledgers, and reports.'
      : 'The system will stop forcing simulation mode, allowing live trading when trading is enabled and broker checks pass.',
    current: simulationEnabled.value ? 'simulation on' : 'simulation off',
    next: next ? 'simulation on' : 'simulation off',
    ramification: next
      ? 'This is the safer evaluation mode. The dashboard and GL will continue to reflect simulated activity as if it were real for review.'
      : 'Live execution can resume if trading is enabled, within configured trading hours and broker readiness checks.',
    confirmLabel: next ? 'Enable simulation' : 'Disable simulation',
    danger: !next && tradingEnabled.value,
    patch: { simulationModeEnabled: next },
  });
}

function requestTradeCap(nextCap) {
  const next = Math.max(1, Math.min(10, Number(nextCap || tradeCap.value)));
  if (next === tradeCap.value) return;
  openConfirm({
    title: next > tradeCap.value ? 'Increase trade cap' : 'Decrease trade cap',
    subtitle: 'Per-symbol risk limit',
    message: `The per-symbol 24-hour trade cap will change from ${tradeCap.value} to ${next}.`,
    current: `${tradeCap.value}/symbol`,
    next: `${next}/symbol`,
    ramification: next > tradeCap.value
      ? 'The engine can place more orders for a single symbol during a 24-hour window, increasing responsiveness and exposure risk.'
      : 'The engine will be more restrictive for repeated symbol trades, lowering churn but possibly missing fast-moving opportunities.',
    confirmLabel: 'Apply trade cap',
    danger: next > tradeCap.value,
    patch: { maxTradesPerSymbolPer24h: next },
  });
}

async function confirmSettingChange() {
  if (!confirmDialog.value.patch) return;
  savingSetting.value = true;
  confirmDialog.value.error = '';
  try {
    await api.patch('/settings', confirmDialog.value.patch);
    confirmDialog.value.open = false;
    await refreshDashboardWidgets();
  } catch (err) {
    confirmDialog.value.error = err.response?.data?.error || err.message || 'Unable to update setting.';
  } finally {
    savingSetting.value = false;
  }
}

onMounted(() => {
  document.addEventListener('pointerdown', startWindowDragFromDocument);
  document.addEventListener('mousedown', startWindowDragFromDocument);
  load();
  refreshTimer = setInterval(refreshDashboardWidgets, 60000);
});
onBeforeUnmount(() => {
  clearTimeout(saveTimer);
  if (refreshTimer) clearInterval(refreshTimer);
  document.removeEventListener('pointerdown', startWindowDragFromDocument);
  document.removeEventListener('mousedown', startWindowDragFromDocument);
  window.removeEventListener('pointermove', onWindowDrag);
  window.removeEventListener('mousemove', onWindowDrag);
  document.removeEventListener('pointermove', onWindowDrag);
  document.removeEventListener('mousemove', onWindowDrag);
});
</script>
