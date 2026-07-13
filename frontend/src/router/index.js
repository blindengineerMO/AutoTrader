import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const routes = [
  { path: '/login', name: 'login', component: () => import('../views/LoginView.vue'), meta: { public: true } },
  { path: '/', name: 'dashboard', component: () => import('../views/DashboardView.vue') },
  { path: '/research', name: 'research', component: () => import('../views/ResearchView.vue') },
  { path: '/agents', name: 'agents', component: () => import('../views/AgentsView.vue') },
  { path: '/watchers', name: 'watchers', component: () => import('../views/WatcherAgentsView.vue') },
  { path: '/workspace', name: 'workspace', component: () => import('../views/CompanyWorkspaceView.vue') },
  { path: '/reports', name: 'reports', component: () => import('../views/ReportsView.vue') },
  { path: '/orders', name: 'orders', component: () => import('../views/OrdersView.vue') },
  { path: '/settings', name: 'settings', component: () => import('../views/SettingsView.vue') },
  { path: '/users', name: 'users', component: () => import('../views/UserManagementView.vue'), meta: { admin: true } },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  if (!to.meta.public && !auth.isAuthenticated) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }
  if (auth.isAuthenticated) {
    try {
      await auth.ensureFreshUser();
    } catch (err) {
      auth.logout();
      if (!to.meta.public) return { name: 'login', query: { redirect: to.fullPath } };
    }
  }
  if (to.meta.admin && !auth.isAdmin) {
    return { name: 'dashboard' };
  }
  if (to.name === 'login' && auth.isAuthenticated) {
    return { name: 'dashboard' };
  }
  return true;
});

export default router;
