<template>
  <div class="page-shell">
    <div class="ops-command-bar user-command-bar mb-6">
      <div>
        <p class="page-kicker mb-3">Admin workspace</p>
        <h1 class="page-title">User Management</h1>
        <p class="page-copy max-w-3xl mt-4">
          User accounts own broker accounts, purchases, simulations, ledgers, reports, settings, and credentials.
        </p>
      </div>
      <div class="user-command">
        <GlassButton class="user-add-button" @click="openCreate">
          <v-icon size="18">mdi-account-plus</v-icon>
          Add user
        </GlassButton>
      </div>
    </div>

    <div class="bento-grid stagger">
      <GlassCard class="bento-span-12" title="Users">
        <div class="user-toolbar mini-glass">
          <v-text-field
            v-model="query.search"
            label="Search users"
            prepend-inner-icon="mdi-magnify"
            variant="outlined"
            density="compact"
            hide-details
            @keyup.enter="applyQuery"
          />
          <v-select
            v-model="query.role"
            :items="roleFilterItems"
            label="Role"
            variant="outlined"
            density="compact"
            hide-details
            @update:model-value="applyQuery"
          />
          <v-select
            v-model="query.status"
            :items="statusFilterItems"
            label="Status"
            variant="outlined"
            density="compact"
            hide-details
            @update:model-value="applyQuery"
          />
          <v-select
            v-model="query.sortBy"
            :items="sortItems"
            label="Sort"
            variant="outlined"
            density="compact"
            hide-details
            @update:model-value="loadUsers"
          />
          <button class="hud-chip hud-chip-button user-sort-toggle" @click="toggleSort">
            <v-icon size="15">{{ query.sortDir === 'asc' ? 'mdi-sort-ascending' : 'mdi-sort-descending' }}</v-icon>
            {{ query.sortDir }}
          </button>
          <GlassButton variant="ghost" :disabled="loading" @click="applyQuery">
            {{ loading ? 'Loading...' : 'Search' }}
          </GlassButton>
        </div>

        <div v-if="error" class="text-danger text-sm mt-4">{{ error }}</div>

        <div class="user-table-meta">
          <span>{{ pager.total }} accounts</span>
          <span>page {{ pager.page }} / {{ pager.totalPages }}</span>
        </div>

        <div class="user-table">
          <div class="user-row user-head">
            <button @click="setSort('email')">Email <v-icon size="13">{{ sortIcon('email') }}</v-icon></button>
            <button @click="setSort('role')">Role <v-icon size="13">{{ sortIcon('role') }}</v-icon></button>
            <button @click="setSort('status')">Status <v-icon size="13">{{ sortIcon('status') }}</v-icon></button>
            <button @click="setSort('last_login_at')">Last login <v-icon size="13">{{ sortIcon('last_login_at') }}</v-icon></button>
            <button @click="setSort('created_at')">Created <v-icon size="13">{{ sortIcon('created_at') }}</v-icon></button>
            <div>Actions</div>
          </div>

          <div v-if="!users.length" class="mini-glass p-4 text-white/42 text-sm">
            No users match the current filters.
          </div>

          <div v-for="user in users" :key="user.id" class="user-row">
            <div class="min-w-0">
              <div class="font-medium truncate">{{ user.email }}</div>
              <div class="text-[11px] text-white/35">ID {{ user.id }} · password {{ formatStamp(user.passwordChangedAt) }}</div>
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
            <div class="text-xs text-white/50">{{ formatStamp(user.createdAt) }}</div>
            <div class="user-actions">
              <GlassButton variant="ghost" class="!py-2 !px-3 !text-xs" @click="openPassword(user)">
                <v-icon size="14">mdi-lock-reset</v-icon>
                Reset
              </GlassButton>
              <GlassButton variant="ghost" class="!py-2 !px-3 !text-xs" danger @click="openDelete(user)">
                <v-icon size="14">mdi-delete</v-icon>
                Delete
              </GlassButton>
            </div>
          </div>
        </div>

        <div class="user-pagination">
          <v-select
            v-model="query.pageSize"
            :items="[10, 25, 50, 100]"
            label="Rows"
            variant="outlined"
            density="compact"
            hide-details
            class="user-page-size"
            @update:model-value="applyQuery"
          />
          <button class="hud-chip hud-chip-button" :disabled="pager.page <= 1" @click="changePage(-1)">
            <v-icon size="15">mdi-chevron-left</v-icon>
            Previous
          </button>
          <button class="hud-chip hud-chip-button" :disabled="pager.page >= pager.totalPages" @click="changePage(1)">
            Next
            <v-icon size="15">mdi-chevron-right</v-icon>
          </button>
          <GlassButton variant="ghost" :disabled="loading" @click="loadUsers">
            <v-icon size="15">mdi-refresh</v-icon>
            Refresh
          </GlassButton>
        </div>
      </GlassCard>
    </div>

    <div v-if="createDialog.open" class="modal-backdrop">
      <div class="glass-panel modal-card user-create-modal p-6">
        <div class="modal-heading">
          <div>
            <div class="font-display text-2xl mb-1">Create user</div>
            <div class="text-sm text-white/50">Provision an isolated operator account.</div>
          </div>
          <button class="hud-chip hud-chip-button" @click="closeCreate">
            <v-icon size="16">mdi-close</v-icon>
          </button>
        </div>
        <form class="flex flex-col gap-4 mt-5" @submit.prevent="createUser">
          <v-text-field v-model="draft.email" label="Email" type="email" variant="outlined" density="comfortable" hide-details required />
          <v-text-field v-model="draft.password" label="Password" type="password" variant="outlined" density="comfortable" hide-details required />
          <div class="grid grid-cols-2 gap-4">
            <v-select v-model="draft.role" :items="roleItems" label="Role" variant="outlined" density="comfortable" hide-details />
            <v-select v-model="draft.status" :items="statusItems" label="Status" variant="outlined" density="comfortable" hide-details />
          </div>
          <div v-if="createDialog.error" class="text-danger text-sm">{{ createDialog.error }}</div>
          <div class="flex justify-end gap-3">
            <GlassButton variant="ghost" @click="closeCreate">Cancel</GlassButton>
            <GlassButton type="submit" :disabled="createDialog.saving">
              {{ createDialog.saving ? 'Creating...' : 'Create user' }}
            </GlassButton>
          </div>
        </form>
      </div>
    </div>

    <div v-if="passwordDialog.open" class="modal-backdrop">
      <div class="glass-panel modal-card p-6">
        <div class="modal-heading">
          <div>
            <div class="font-display text-2xl mb-1">Reset password</div>
            <div class="text-sm text-white/50">{{ passwordDialog.user?.email }}</div>
          </div>
          <button class="hud-chip hud-chip-button" @click="closePassword">
            <v-icon size="16">mdi-close</v-icon>
          </button>
        </div>
        <v-text-field
          v-model="passwordDialog.password"
          class="mt-5"
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

    <div v-if="deleteDialog.open" class="modal-backdrop">
      <div class="glass-panel modal-card p-6">
        <div class="modal-heading">
          <div>
            <div class="font-display text-2xl mb-1 text-danger">Delete user</div>
            <div class="text-sm text-white/50">{{ deleteDialog.user?.email }}</div>
          </div>
          <button class="hud-chip hud-chip-button" @click="closeDelete">
            <v-icon size="16">mdi-close</v-icon>
          </button>
        </div>
        <p class="text-sm text-white/58 mt-5">
          This removes the account and its user-owned settings, credentials, simulations, reports, orders, positions, and ledger entries.
        </p>
        <div v-if="deleteDialog.error" class="text-danger text-sm mt-3">{{ deleteDialog.error }}</div>
        <div class="flex justify-end gap-3 mt-5">
          <GlassButton variant="ghost" @click="closeDelete">Cancel</GlassButton>
          <GlassButton danger :disabled="deleteDialog.saving" @click="deleteUser">
            {{ deleteDialog.saving ? 'Deleting...' : 'Delete user' }}
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

const roleItems = [
  { title: 'Subscriber', value: 'user' },
  { title: 'Admin', value: 'admin' },
];
const statusItems = ['active', 'disabled'];
const roleFilterItems = [
  { title: 'All roles', value: '' },
  { title: 'Subscriber', value: 'user' },
  { title: 'Admin', value: 'admin' },
];
const statusFilterItems = [
  { title: 'All statuses', value: '' },
  { title: 'Active', value: 'active' },
  { title: 'Disabled', value: 'disabled' },
];
const sortItems = [
  { title: 'Created', value: 'created_at' },
  { title: 'Email', value: 'email' },
  { title: 'Role', value: 'role' },
  { title: 'Status', value: 'status' },
  { title: 'Last login', value: 'last_login_at' },
  { title: 'Password changed', value: 'password_changed_at' },
];

const users = ref([]);
const loading = ref(false);
const error = ref('');
const pager = ref({ total: 0, page: 1, pageSize: 25, totalPages: 1 });
const query = reactive({
  page: 1,
  pageSize: 25,
  search: '',
  role: '',
  status: '',
  sortBy: 'created_at',
  sortDir: 'desc',
});
const draft = reactive({
  email: '',
  password: '',
  role: 'user',
  status: 'active',
});
const createDialog = reactive({
  open: false,
  error: '',
  saving: false,
});
const passwordDialog = reactive({
  open: false,
  user: null,
  password: '',
  error: '',
  saving: false,
});
const deleteDialog = reactive({
  open: false,
  user: null,
  error: '',
  saving: false,
});

onMounted(loadUsers);

async function loadUsers() {
  loading.value = true;
  error.value = '';
  try {
    const { data } = await api.get('/admin/users', {
      params: {
        ...query,
        search: query.search || undefined,
        role: query.role || undefined,
        status: query.status || undefined,
      },
    });
    const result = Array.isArray(data)
      ? { items: data, total: data.length, page: 1, pageSize: data.length || query.pageSize, totalPages: 1 }
      : data;
    users.value = result.items || [];
    pager.value = {
      total: result.total || 0,
      page: result.page || 1,
      pageSize: result.pageSize || query.pageSize,
      totalPages: result.totalPages || 1,
    };
    query.page = pager.value.page;
    query.pageSize = pager.value.pageSize;
  } catch (err) {
    error.value = err.response?.data?.error || 'Unable to load users';
  } finally {
    loading.value = false;
  }
}

function applyQuery() {
  query.page = 1;
  loadUsers();
}

function changePage(delta) {
  const next = Math.min(pager.value.totalPages, Math.max(1, query.page + delta));
  if (next === query.page) return;
  query.page = next;
  loadUsers();
}

function toggleSort() {
  query.sortDir = query.sortDir === 'asc' ? 'desc' : 'asc';
  loadUsers();
}

function setSort(sortBy) {
  if (query.sortBy === sortBy) {
    toggleSort();
    return;
  }
  query.sortBy = sortBy;
  query.sortDir = sortBy === 'email' ? 'asc' : 'desc';
  loadUsers();
}

function sortIcon(sortBy) {
  if (query.sortBy !== sortBy) return 'mdi-unfold-more-horizontal';
  return query.sortDir === 'asc' ? 'mdi-chevron-up' : 'mdi-chevron-down';
}

function openCreate() {
  createDialog.open = true;
  createDialog.error = '';
}

function closeCreate() {
  createDialog.open = false;
  createDialog.error = '';
}

async function createUser() {
  createDialog.saving = true;
  createDialog.error = '';
  try {
    await api.post('/admin/users', draft);
    draft.email = '';
    draft.password = '';
    draft.role = 'user';
    draft.status = 'active';
    closeCreate();
    query.page = 1;
    await loadUsers();
  } catch (err) {
    createDialog.error = err.response?.data?.error || 'Unable to create user';
  } finally {
    createDialog.saving = false;
  }
}

async function updateUser(user, patch) {
  try {
    const { data } = await api.patch(`/admin/users/${user.id}`, patch);
    Object.assign(user, data);
  } catch (err) {
    error.value = err.response?.data?.error || 'Unable to update user';
    await loadUsers();
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

function openDelete(user) {
  deleteDialog.open = true;
  deleteDialog.user = user;
  deleteDialog.error = '';
}

function closeDelete() {
  deleteDialog.open = false;
  deleteDialog.user = null;
  deleteDialog.error = '';
}

async function deleteUser() {
  if (!deleteDialog.user) return;
  deleteDialog.saving = true;
  deleteDialog.error = '';
  try {
    await api.delete(`/admin/users/${deleteDialog.user.id}`);
    closeDelete();
    await loadUsers();
    if (!users.value.length && query.page > 1) {
      query.page -= 1;
      await loadUsers();
    }
  } catch (err) {
    deleteDialog.error = err.response?.data?.error || 'Unable to delete user';
  } finally {
    deleteDialog.saving = false;
  }
}

function formatStamp(value) {
  if (!value) return 'never';
  return new Date(value).toLocaleString();
}
</script>

<style scoped>
.user-command {
  display: flex;
  justify-content: flex-end;
}

.user-add-button {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  white-space: nowrap;
}

.user-toolbar {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) minmax(110px, 0.36fr) minmax(130px, 0.4fr) minmax(150px, 0.44fr) auto auto;
  gap: 0.65rem;
  align-items: center;
  min-width: 0;
  padding: 0.8rem;
}

.user-sort-toggle {
  min-height: 34px;
  justify-content: center;
}

.user-table-meta {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  margin: 0.85rem 0 0.55rem;
  color: rgba(255, 255, 255, 0.44);
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.user-table {
  display: grid;
  gap: 0.55rem;
  min-width: 0;
}

.user-row {
  display: grid;
  grid-template-columns:
    minmax(190px, 1.5fr)
    minmax(96px, 0.42fr)
    minmax(108px, 0.46fr)
    minmax(120px, 0.58fr)
    minmax(120px, 0.58fr)
    minmax(190px, 0.76fr);
  gap: 0.55rem;
  align-items: center;
  min-width: 0;
  padding: 0.66rem 0.72rem;
  border: 1px solid rgba(110, 231, 255, 0.14);
  background: rgba(6, 14, 24, 0.42);
  border-radius: 14px;
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.24);
}

.user-row > * {
  min-width: 0;
}

.user-head {
  padding: 0.15rem 0.72rem;
  border-color: transparent;
  background: transparent;
  box-shadow: none;
  color: rgba(255, 255, 255, 0.42);
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.user-head button {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  color: inherit;
  text-align: left;
  text-transform: inherit;
}

.user-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.4rem;
  min-width: 0;
}

.user-actions :deep(.glass-button) {
  justify-content: center;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
}

.user-row :deep(.v-field) {
  min-width: 0;
}

.user-pagination {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 0.65rem;
  margin-top: 0.9rem;
}

.user-page-size {
  max-width: 110px;
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
  width: min(520px, calc(100vw - 28px));
}

.user-create-modal {
  width: min(560px, calc(100vw - 28px));
}

.modal-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}

@media (max-width: 1200px) {
  .user-toolbar {
    grid-template-columns: minmax(220px, 1fr) repeat(2, minmax(120px, 0.5fr));
  }

  .user-row {
    grid-template-columns: minmax(190px, 1.4fr) minmax(96px, 0.5fr) minmax(108px, 0.5fr) minmax(120px, 0.7fr) minmax(170px, 0.8fr);
  }

  .user-row > :nth-child(5),
  .user-head > :nth-child(5) {
    display: none;
  }
}

@media (max-width: 820px) {
  .user-toolbar {
    grid-template-columns: 1fr;
  }

  .user-command {
    justify-content: flex-start;
  }

  .user-row {
    grid-template-columns: 1fr;
  }

  .user-head {
    display: none;
  }

  .user-actions {
    grid-template-columns: 1fr 1fr;
  }

  .user-table-meta,
  .user-pagination {
    justify-content: flex-start;
  }
}
</style>
