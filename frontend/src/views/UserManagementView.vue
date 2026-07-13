<template>
  <div class="page-shell">
    <div class="mb-10">
      <p class="page-kicker mb-3">Admin workspace</p>
      <h1 class="page-title">User Management</h1>
      <p class="page-copy max-w-3xl mt-4">
        User accounts own their own broker accounts, purchases, simulations, ledgers, reports, settings, and credentials.
      </p>
    </div>

    <div class="bento-grid stagger">
      <GlassCard class="bento-span-4" title="Create user">
        <form class="flex flex-col gap-4" @submit.prevent="createUser">
          <v-text-field v-model="draft.email" label="Email" type="email" variant="outlined" density="comfortable" hide-details required />
          <v-text-field v-model="draft.password" label="Password" type="password" variant="outlined" density="comfortable" hide-details required />
          <div class="grid grid-cols-2 gap-4">
            <v-select v-model="draft.role" :items="roleItems" label="Role" variant="outlined" density="comfortable" hide-details />
            <v-select v-model="draft.status" :items="statusItems" label="Status" variant="outlined" density="comfortable" hide-details />
          </div>
          <div v-if="error" class="text-danger text-sm">{{ error }}</div>
          <GlassButton type="submit" :disabled="saving">
            {{ saving ? 'Creating...' : 'Create user' }}
          </GlassButton>
        </form>
      </GlassCard>

      <GlassCard class="bento-span-8" title="Users">
        <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div class="text-xs text-white/45">{{ users.length }} accounts</div>
          <GlassButton variant="ghost" :disabled="loading" @click="loadUsers">
            {{ loading ? 'Refreshing...' : 'Refresh' }}
          </GlassButton>
        </div>

        <div class="user-table">
          <div class="user-row user-head">
            <div>Email</div>
            <div>Role</div>
            <div>Status</div>
            <div>Last login</div>
            <div>Actions</div>
          </div>

          <div v-for="user in users" :key="user.id" class="user-row">
            <div class="min-w-0">
              <div class="font-medium truncate">{{ user.email }}</div>
              <div class="text-[11px] text-white/35">ID {{ user.id }} · created {{ formatStamp(user.createdAt) }}</div>
            </div>
            <v-select
              v-model="user.role"
              :items="roleItems"
              variant="outlined"
              density="compact"
              hide-details
              @update:model-value="updateUser(user, { role: user.role })"
            />
            <v-select
              v-model="user.status"
              :items="statusItems"
              variant="outlined"
              density="compact"
              hide-details
              @update:model-value="updateUser(user, { status: user.status })"
            />
            <div class="text-xs text-white/50">{{ formatStamp(user.lastLoginAt) }}</div>
            <div class="flex flex-wrap gap-2">
              <GlassButton variant="ghost" class="!py-2 !px-3 !text-xs" @click="openPassword(user)">
                Reset password
              </GlassButton>
            </div>
          </div>
        </div>
      </GlassCard>
    </div>

    <div v-if="passwordDialog.open" class="modal-backdrop">
      <div class="glass-panel modal-card p-6">
        <div class="font-display text-2xl mb-1">Reset password</div>
        <div class="text-sm text-white/50 mb-5">{{ passwordDialog.user?.email }}</div>
        <v-text-field
          v-model="passwordDialog.password"
          label="New password"
          type="password"
          variant="outlined"
          density="comfortable"
          hide-details
          @keyup.enter="resetPassword"
        />
        <div v-if="passwordDialog.error" class="text-danger text-sm mt-3">{{ passwordDialog.error }}</div>
        <div class="flex justify-end gap-3 mt-5">
          <GlassButton variant="ghost" @click="closePassword">Cancel</GlassButton>
          <GlassButton :disabled="passwordDialog.saving" @click="resetPassword">
            {{ passwordDialog.saving ? 'Saving...' : 'Save password' }}
          </GlassButton>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import api from '../api/client';
import GlassButton from '../components/GlassButton.vue';
import GlassCard from '../components/GlassCard.vue';

const roleItems = ['user', 'admin'];
const statusItems = ['active', 'disabled'];

const users = ref([]);
const loading = ref(false);
const saving = ref(false);
const error = ref('');
const draft = reactive({
  email: '',
  password: '',
  role: 'user',
  status: 'active',
});
const passwordDialog = reactive({
  open: false,
  user: null,
  password: '',
  error: '',
  saving: false,
});

onMounted(loadUsers);

async function loadUsers() {
  loading.value = true;
  error.value = '';
  try {
    const { data } = await api.get('/admin/users');
    users.value = data;
  } catch (err) {
    error.value = err.response?.data?.error || 'Unable to load users';
  } finally {
    loading.value = false;
  }
}

async function createUser() {
  saving.value = true;
  error.value = '';
  try {
    await api.post('/admin/users', draft);
    draft.email = '';
    draft.password = '';
    draft.role = 'user';
    draft.status = 'active';
    await loadUsers();
  } catch (err) {
    error.value = err.response?.data?.error || 'Unable to create user';
  } finally {
    saving.value = false;
  }
}

async function updateUser(user, patch) {
  const previous = users.value.find((item) => item.id === user.id);
  try {
    const { data } = await api.patch(`/admin/users/${user.id}`, patch);
    Object.assign(user, data);
  } catch (err) {
    if (previous) await loadUsers();
    error.value = err.response?.data?.error || 'Unable to update user';
  }
}

function openPassword(user) {
  passwordDialog.open = true;
  passwordDialog.user = user;
  passwordDialog.password = '';
  passwordDialog.error = '';
}

function closePassword() {
  passwordDialog.open = false;
  passwordDialog.user = null;
  passwordDialog.password = '';
  passwordDialog.error = '';
}

async function resetPassword() {
  if (!passwordDialog.user) return;
  passwordDialog.saving = true;
  passwordDialog.error = '';
  try {
    await api.post(`/admin/users/${passwordDialog.user.id}/password`, { password: passwordDialog.password });
    closePassword();
    await loadUsers();
  } catch (err) {
    passwordDialog.error = err.response?.data?.error || 'Unable to reset password';
  } finally {
    passwordDialog.saving = false;
  }
}

function formatStamp(value) {
  if (!value) return 'never';
  return new Date(value).toLocaleString();
}
</script>

<style scoped>
.user-table {
  display: grid;
  gap: 0.75rem;
}

.user-row {
  display: grid;
  grid-template-columns: minmax(180px, 1.4fr) 120px 130px minmax(120px, 0.8fr) minmax(130px, 0.8fr);
  gap: 0.85rem;
  align-items: center;
  padding: 0.9rem;
  border: 1px solid rgba(110, 231, 255, 0.14);
  background: rgba(6, 14, 24, 0.48);
  border-radius: 14px;
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.28);
}

.user-head {
  padding: 0 0.9rem;
  border-color: transparent;
  background: transparent;
  box-shadow: none;
  color: rgba(255, 255, 255, 0.42);
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: grid;
  place-items: center;
  padding: 1rem;
  background: rgba(0, 0, 0, 0.42);
  backdrop-filter: blur(12px);
}

.modal-card {
  width: min(440px, 100%);
}

@media (max-width: 900px) {
  .user-row {
    grid-template-columns: 1fr;
  }

  .user-head {
    display: none;
  }
}
</style>
