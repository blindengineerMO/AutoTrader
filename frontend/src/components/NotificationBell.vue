<template>
  <div class="notification-bell">
    <button ref="triggerRef" class="bell-trigger" type="button" @click="toggleOpen" aria-label="Notifications">
      <v-icon icon="mdi-bell-outline" size="19" />
      <span v-if="unseenCount > 0" class="bell-badge">{{ unseenCount > 9 ? '9+' : unseenCount }}</span>
    </button>
    <Teleport to="body">
      <div v-if="open" class="bell-dropdown floating-notification-panel glass-panel p-4" :style="dropdownStyle" @click.stop>
        <div class="flex items-center justify-between mb-3">
          <h3 class="font-headline text-xs uppercase text-white/60">Notifications</h3>
          <button class="text-[10px] uppercase text-white/40 hover:text-white/70" type="button" @click="markAllSeen">
            Mark all read
          </button>
        </div>
        <div v-if="loading" class="text-xs text-white/40 py-4 text-center">Loading...</div>
        <div v-else-if="!filteredItems.length" class="text-xs text-white/40 py-4 text-center">No recent activity.</div>
        <ul v-else class="bell-list">
          <li v-for="item in filteredItems" :key="item.id" class="bell-item" :class="{ unseen: !seenIds.has(item.id) }">
            <v-icon :icon="item.icon" size="16" />
            <div class="min-w-0 flex-1">
              <div class="text-xs text-white/80 truncate">{{ item.message }}</div>
              <div class="text-[10px] text-white/35">{{ relativeTime(item.at) }}</div>
            </div>
          </li>
        </ul>

        <div class="bell-prefs">
          <button class="bell-prefs-toggle" type="button" @click="prefsOpen = !prefsOpen">
            <v-icon :icon="prefsOpen ? 'mdi-chevron-up' : 'mdi-tune-variant'" size="14" />
            Notification preferences
          </button>
          <div v-if="prefsOpen" class="bell-prefs-list">
            <label v-for="cat in categories" :key="cat.key" class="bell-pref-row">
              <input type="checkbox" v-model="prefs[cat.key]" @change="persistPrefs" />
              <span>{{ cat.label }}</span>
            </label>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { computed, defineEmits, defineExpose, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import api from '../api/client';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const emit = defineEmits(['open']);
const open = ref(false);
const prefsOpen = ref(false);
const loading = ref(true);
const items = ref([]);
const seenIds = ref(new Set());
const triggerRef = ref(null);
const dropdownStyle = ref({});

const categories = [
  { key: 'killSwitch', label: 'Kill switch alerts' },
  { key: 'research', label: 'Research run completions' },
  { key: 'council', label: 'Agent council consensus' },
];
const prefs = ref({ killSwitch: true, research: true, council: true });

const storageKey = computed(() => `autotrader.notifications.seen.${auth.user?.id || 'anon'}`);
const prefsStorageKey = computed(() => `autotrader.notifications.prefs.${auth.user?.id || 'anon'}`);

const filteredItems = computed(() => items.value.filter((item) => prefs.value[item.category] !== false));
const unseenCount = computed(() => filteredItems.value.filter((item) => !seenIds.value.has(item.id)).length);

function loadSeen() {
  try {
    const raw = localStorage.getItem(storageKey.value);
    seenIds.value = new Set(raw ? JSON.parse(raw) : []);
  } catch {
    seenIds.value = new Set();
  }
}

function persistSeen() {
  localStorage.setItem(storageKey.value, JSON.stringify([...seenIds.value]));
}

function loadPrefs() {
  try {
    const raw = localStorage.getItem(prefsStorageKey.value);
    if (raw) prefs.value = { ...prefs.value, ...JSON.parse(raw) };
  } catch {
    // ignore malformed prefs, keep defaults
  }
}

function persistPrefs() {
  localStorage.setItem(prefsStorageKey.value, JSON.stringify(prefs.value));
}

function toggleOpen() {
  open.value = !open.value;
  if (open.value) {
    emit('open');
    nextTick(updateDropdownPosition);
  }
}

function closePanel() {
  open.value = false;
}

function markAllSeen() {
  for (const item of items.value) seenIds.value.add(item.id);
  persistSeen();
}

function relativeTime(iso) {
  if (!iso) return '';
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

async function refresh() {
  try {
    const [settingsRes, researchRunsRes, councilRunsRes] = await Promise.all([
      api.get('/settings'),
      api.get('/research/runs?limit=5'),
      api.get('/agents/council/runs?limit=5').catch(() => ({ data: [] })),
    ]);

    const feed = [];
    const settings = settingsRes.data;
    if (settings?.kill_switch_engaged) {
      feed.push({
        id: `kill-switch-${settings.updated_at}`,
        icon: 'mdi-alert-octagon-outline',
        message: 'Kill switch is engaged — trading is halted.',
        at: settings.updated_at,
        category: 'killSwitch',
      });
    }

    for (const run of researchRunsRes.data || []) {
      if (run.status !== 'complete' && run.status !== 'failed') continue;
      feed.push({
        id: `research-run-${run.id}`,
        icon: run.status === 'failed' ? 'mdi-alert-circle-outline' : 'mdi-radar',
        message: run.status === 'failed' ? 'Research run failed.' : 'Research run completed.',
        at: run.completedAt || run.completed_at,
        category: 'research',
      });
    }

    for (const run of councilRunsRes.data || []) {
      feed.push({
        id: `council-run-${run.id}`,
        icon: 'mdi-account-group-outline',
        message: 'Agent council reached a new consensus.',
        at: run.created_at || run.createdAt,
        category: 'council',
      });
    }

    feed.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
    items.value = feed.slice(0, 12);
  } catch {
    // Notifications are best-effort; silently keep the previous feed on failure.
  } finally {
    loading.value = false;
  }
}

let intervalId = null;

function updateDropdownPosition() {
  const rect = triggerRef.value?.getBoundingClientRect();
  if (!rect) return;
  const viewportPad = 14;
  const width = Math.min(340, window.innerWidth - viewportPad * 2);
  const left = Math.min(Math.max(rect.left, viewportPad), window.innerWidth - width - viewportPad);
  const spaceAbove = Math.max(0, rect.top - viewportPad - 10);
  const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - viewportPad - 10);
  const opensAbove = spaceAbove >= 220 || spaceAbove >= spaceBelow;
  const maxHeight = Math.max(180, Math.min(520, opensAbove ? spaceAbove : spaceBelow));
  const top = opensAbove
    ? Math.max(viewportPad, rect.top - maxHeight - 10)
    : Math.min(window.innerHeight - viewportPad - 180, rect.bottom + 10);
  dropdownStyle.value = {
    left: `${left}px`,
    top: `${top}px`,
    width: `${width}px`,
    maxHeight: `${maxHeight}px`,
  };
}

function handleViewportChange() {
  if (open.value) updateDropdownPosition();
}

onMounted(() => {
  loadSeen();
  loadPrefs();
  refresh();
  intervalId = setInterval(refresh, 60000);
  document.addEventListener('click', handleOutsideClick);
  window.addEventListener('resize', handleViewportChange);
  window.addEventListener('scroll', handleViewportChange, true);
  window.addEventListener('autotrader:close-notifications', closePanel);
});

function handleOutsideClick(event) {
  if (!open.value) return;
  if (!event.target.closest('.notification-bell') && !event.target.closest('.bell-dropdown')) open.value = false;
}

onBeforeUnmount(() => {
  if (intervalId) clearInterval(intervalId);
  document.removeEventListener('click', handleOutsideClick);
  window.removeEventListener('resize', handleViewportChange);
  window.removeEventListener('scroll', handleViewportChange, true);
  window.removeEventListener('autotrader:close-notifications', closePanel);
});

defineExpose({ close: closePanel });
</script>
