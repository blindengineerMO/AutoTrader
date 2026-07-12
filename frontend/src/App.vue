<template>
  <v-app>
    <div class="cyber-shell">
      <template v-if="auth.isAuthenticated">
        <header class="top-nav">
          <div class="flex flex-wrap items-center gap-3">
            <router-link to="/" class="nav-brand text-sm md:text-base no-underline px-3">
              AUTOTRADER
            </router-link>
            <nav class="flex flex-wrap items-center gap-1 flex-1 justify-center">
              <router-link
                v-for="item in navItems"
                :key="item.to"
                :to="item.to"
                class="nav-link text-xs md:text-sm"
                active-class=""
                exact-active-class="router-link-active"
              >
                <v-icon :icon="item.icon" size="18" />
                <span>{{ item.label }}</span>
              </router-link>
            </nav>
            <div class="hidden lg:block text-right px-2">
              <div class="text-[10px] uppercase text-white/35">operator</div>
              <div class="text-xs text-white/65 max-w-[190px] truncate">{{ auth.user?.email }}</div>
            </div>
            <GlassButton variant="ghost" class="!px-4 !py-2" @click="logout">Log out</GlassButton>
          </div>
        </header>
        <v-main>
          <router-view />
        </v-main>
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
import { useRouter } from 'vue-router';
import { useAuthStore } from './stores/auth';
import GlassButton from './components/GlassButton.vue';

const auth = useAuthStore();
const router = useRouter();

const navItems = [
  { to: '/', label: 'Dashboard', icon: 'mdi-view-dashboard' },
  { to: '/research', label: 'Research & Strategy', icon: 'mdi-radar' },
  { to: '/workspace', label: 'Workspace', icon: 'mdi-briefcase-search' },
  { to: '/reports', label: 'Reports', icon: 'mdi-file-chart' },
  { to: '/orders', label: 'Trade Log', icon: 'mdi-swap-horizontal' },
  { to: '/settings', label: 'Settings', icon: 'mdi-cog' },
];

function logout() {
  auth.logout();
  router.push({ name: 'login' });
}
</script>
