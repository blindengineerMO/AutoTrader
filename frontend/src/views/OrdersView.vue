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

      <GlassCard title="Official GL ledger" class="bento-span-7">
        <v-table v-if="glEntries.length" density="comfortable" class="bg-transparent gl-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Account</th>
              <th>Symbol</th>
              <th>Debit</th>
              <th>Credit</th>
              <th>Source</th>
              <th>Memo</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in glEntries" :key="entry.id">
              <td class="text-xs text-white/40">{{ entry.created_at }}</td>
              <td>
                <strong>{{ entry.account_code }}</strong>
                <small class="block text-white/38">{{ entry.account_name }}</small>
              </td>
              <td class="font-medium">{{ entry.symbol }}</td>
              <td class="text-accent">{{ entry.debit ? '$' + money(entry.debit) : '—' }}</td>
              <td class="text-danger">{{ entry.credit ? '$' + money(entry.credit) : '—' }}</td>
              <td><span class="hud-chip">{{ entry.source_type }}</span></td>
              <td class="text-xs text-white/42 max-w-xs truncate">{{ entry.memo }}</td>
            </tr>
          </tbody>
        </v-table>
        <div v-else class="text-white/40 text-sm">No GL entries yet.</div>
      </GlassCard>

      <GlassCard title="Company GL" class="bento-span-5 lg:mt-14">
        <div v-if="!glCompanies.length" class="text-white/40 text-sm">No company ledgers yet.</div>
        <div v-else>
          <div class="company-ledger-tabs mb-4">
            <button
              v-for="company in glCompanies"
              :key="company.symbol"
              class="hud-window-toggle"
              :class="{ active: selectedCompany === company.symbol }"
              @click="selectCompany(company.symbol)"
            >
              {{ company.symbol }}
            </button>
          </div>
          <v-table v-if="companyEntries.length" density="compact" class="bg-transparent">
            <thead>
              <tr>
                <th>Time</th>
                <th>Account</th>
                <th>Dr</th>
                <th>Cr</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="entry in companyEntries" :key="entry.id">
                <td class="text-xs text-white/40">{{ entry.created_at }}</td>
                <td>
                  <strong>{{ entry.account_code }}</strong>
                  <small class="block text-white/38">{{ entry.source_type }}</small>
                </td>
                <td class="text-accent">{{ entry.debit ? money(entry.debit) : '—' }}</td>
                <td class="text-danger">{{ entry.credit ? money(entry.credit) : '—' }}</td>
              </tr>
            </tbody>
          </v-table>
        </div>
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
const glEntries = ref([]);
const glCompanies = ref([]);
const companyEntries = ref([]);
const selectedCompany = ref('');

onMounted(async () => {
  const [oRes, pRes, glRes, companiesRes] = await Promise.all([
    api.get('/orders'),
    api.get('/orders/pnl-history'),
    api.get('/orders/gl-ledger'),
    api.get('/orders/gl-ledger/companies'),
  ]);
  orders.value = oRes.data;
  pnl.value = pRes.data;
  glEntries.value = glRes.data;
  glCompanies.value = companiesRes.data;
  if (glCompanies.value[0]?.symbol) await selectCompany(glCompanies.value[0].symbol);
});

async function selectCompany(symbol) {
  selectedCompany.value = symbol;
  const { data } = await api.get(`/orders/gl-ledger/${encodeURIComponent(symbol)}`);
  companyEntries.value = data;
}

function money(value) {
  return Number(value || 0).toFixed(2);
}
</script>
