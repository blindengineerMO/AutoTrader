<template>
  <v-app>
    <div class="cyber-shell">
      <template v-if="auth.isAuthenticated">
        <AppBackdrop />
        <aside class="side-nav" :class="{ collapsed: navCollapsed, 'mobile-open': mobileNavOpen }">
          <div class="side-nav-brand">
            <router-link to="/" class="nav-brand-mark" @click="closeMobileNav">
              <v-icon icon="mdi-hexagon-multiple-outline" size="22" />
              <span class="nav-brand-text">AUTOTRADER</span>
            </router-link>
            <button class="nav-collapse-toggle" type="button" @click="toggleCollapse" :aria-label="navCollapsed ? 'Expand navigation' : 'Collapse navigation'">
              <v-icon :icon="navCollapsed ? 'mdi-chevron-right' : 'mdi-chevron-left'" size="18" />
            </button>
          </div>
          <nav class="side-nav-links">
            <router-link
              v-for="item in navItems"
              :key="item.to"
              :to="item.to"
              class="side-nav-link"
              active-class=""
              exact-active-class="router-link-active"
              @click="closeMobileNav"
            >
              <v-icon :icon="item.icon" size="19" />
              <span class="side-nav-label">{{ item.label }}</span>
            </router-link>
          </nav>
          <div class="side-nav-footer">
            <div class="side-nav-operator" v-if="!navCollapsed">
              <div class="text-[10px] uppercase text-white/35">operator</div>
              <div class="text-xs text-white/65 truncate">{{ auth.user?.email }}</div>
              <div v-if="auth.isAdmin" class="text-[10px] uppercase text-accent mt-1">admin</div>
            </div>
          </div>
        </aside>
        <div v-if="mobileNavOpen" class="side-nav-scrim" @click="closeMobileNav" />

        <div class="app-content" :class="{ 'nav-collapsed': navCollapsed }">
          <header class="top-bar">
            <div class="top-bar-left">
              <button class="nav-hamburger" type="button" @click="mobileNavOpen = !mobileNavOpen" aria-label="Toggle navigation">
                <v-icon icon="mdi-menu" size="20" />
              </button>
              <span class="top-bar-title">{{ currentPageLabel }}</span>
            </div>
            <div class="top-bar-right">
              <NotificationBell />
              <div class="profile-menu">
                <button class="profile-trigger" type="button" @click="profileOpen = !profileOpen">
                  <span class="profile-avatar">{{ initials }}</span>
                </button>
                <div v-if="profileOpen" class="profile-dropdown glass-panel p-4" @click.self="profileOpen = false">
                  <div class="text-[10px] uppercase text-white/35">operator</div>
                  <div class="text-xs text-white/75 truncate mb-3">{{ auth.user?.email }}</div>
                  <div v-if="auth.isAdmin" class="text-[10px] uppercase text-accent mb-3">admin workspace enabled</div>
                  <GlassButton variant="ghost" class="!w-full !py-2 !text-xs" @click="logout">Log out</GlassButton>
                </div>
              </div>
            </div>
          </header>
          <v-main>
            <router-view />
          </v-main>
        </div>
      </template>
      <template v-else>
        <v-main>
          <router-view />
        </v-main>
      </template>
    </div>
  </v-app>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from './stores/auth';
import GlassButton from './components/GlassButton.vue';
import AppBackdrop from './components/AppBackdrop.vue';
import NotificationBell from './components/NotificationBell.vue';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

onMounted(() => {
  if (auth.isAuthenticated) auth.fetchMe().catch(() => {});
});

const navItems = computed(() => [
  { to: '/', label: 'Dashboard', icon: 'mdi-view-dashboard' },
  { to: '/research', label: 'Research', icon: 'mdi-radar' },
  { to: '/agents', label: 'Agents', icon: 'mdi-account-group' },
  { to: '/watchers', label: 'Watchers', icon: 'mdi-eye-outline' },
  { to: '/workspace', label: 'Workspace', icon: 'mdi-briefcase-search' },
  { to: '/reports', label: 'Reports', icon: 'mdi-file-chart' },
  { to: '/orders', label: 'Trade Log', icon: 'mdi-swap-horizontal' },
  ...(auth.isAdmin ? [{ to: '/users', label: 'Users', icon: 'mdi-account-key' }] : []),
  { to: '/settings', label: 'Settings', icon: 'mdi-cog' },
]);

const navCollapsed = ref(localStorage.getItem('autotrader.navCollapsed') === '1');
const mobileNavOpen = ref(false);
const profileOpen = ref(false);

function toggleCollapse() {
  navCollapsed.value = !navCollapsed.value;
  localStorage.setItem('autotrader.navCollapsed', navCollapsed.value ? '1' : '0');
}

function closeMobileNav() {
  mobileNavOpen.value = false;
}

const currentPageLabel = computed(() => navItems.value.find((item) => item.to === route.path)?.label || 'Autotrader');

const initials = computed(() => {
  const email = auth.user?.email || '';
  const name = email.split('@')[0] || '';
  return (name.slice(0, 2) || 'AT').toUpperCase();
});

function logout() {
  profileOpen.value = false;
  auth.logout();
  router.push({ name: 'login' });
}
</script>
