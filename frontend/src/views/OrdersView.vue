<template>
  <div class="page-shell">
    <div class="mb-10">
      <p class="page-kicker mb-3">Every order this account has submitted</p>
      <h1 class="page-title">Trade Log</h1>
    </div>

    <div class="bento-grid stagger">
      <GlassCard title="Orders" class="bento-span-7">
        <v-table v-if="orders.length" density="comfortable" class="bg-transparent">
          <thead>
            <tr>
              <th>Time</th>
              <th>Symbol</th>
              <th>Side</th>
              <th>Qty</th>
              <th>Fill</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="o in orders" :key="o.id">
              <td class="text-xs text-white/40">{{ o.submitted_at }}</td>
              <td class="font-medium">{{ o.symbol }}</td>
              <td :class="o.side === 'buy' ? 'text-accent' : 'text-danger'">{{ o.side }}</td>
              <td>{{ o.quantity }}</td>
              <td>{{ o.fill_price ? '$' + o.fill_price : '—' }}</td>
              <td>{{ o.status }}</td>
            </tr>
          </tbody>
        </v-table>
        <div v-else class="text-white/40 text-sm">No orders yet.</div>
      </GlassCard>

      <GlassCard title="P&L ledger" class="bento-span-5 lg:mt-14">
        <v-table v-if="pnl.length" density="comfortable" class="bg-transparent">
          <thead>
            <tr>
              <th>Time</th>
              <th>Realized</th>
              <th>Balance after</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in pnl" :key="p.id">
              <td class="text-xs text-white/40">{{ p.created_at }}</td>
              <td :class="p.realized_pnl_usd < 0 ? 'text-danger' : 'text-accent'">
                {{ p.realized_pnl_usd >= 0 ? '+' : '' }}${{ p.realized_pnl_usd.toFixed(2) }}
              </td>
              <td>${{ p.balance_after_usd?.toFixed(2) }}</td>
              <td class="text-xs text-white/40 max-w-xs truncate">{{ p.note }}</td>
            </tr>
          </tbody>
        </v-table>
        <div v-else class="text-white/40 text-sm">No P&amp;L entries yet.</div>
      </GlassCard>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import api from '../api/client';
import GlassCard from '../components/GlassCard.vue';

const orders = ref([]);
const pnl = ref([]);

onMounted(async () => {
  const [oRes, pRes] = await Promise.all([api.get('/orders'), api.get('/orders/pnl-history')]);
  orders.value = oRes.data;
  pnl.value = pRes.data;
});
</script>
