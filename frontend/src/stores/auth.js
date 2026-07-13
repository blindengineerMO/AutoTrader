import { defineStore } from 'pinia';
import api from '../api/client';

export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: localStorage.getItem('autotrader_token') || null,
    user: JSON.parse(localStorage.getItem('autotrader_user') || 'null'),
    profileLoaded: false,
  }),
  getters: {
    isAuthenticated: (state) => Boolean(state.token),
    isAdmin: (state) => state.user?.isAdmin || state.user?.role === 'admin',
  },
  actions: {
    async login(email, password) {
      const { data } = await api.post('/auth/login', { email, password });
      this.setSession(data);
    },
    async register(email, password) {
      const { data } = await api.post('/auth/register', { email, password });
      this.setSession(data);
    },
    async fetchMe() {
      if (!this.token) return null;
      const { data } = await api.get('/auth/me');
      this.user = data.user;
      this.profileLoaded = true;
      localStorage.setItem('autotrader_user', JSON.stringify(data.user));
      return data.user;
    },
    async ensureFreshUser() {
      if (!this.token) return null;
      if (this.profileLoaded && this.user?.role) return this.user;
      return this.fetchMe();
    },
    setSession({ token, user }) {
      this.token = token;
      this.user = user;
      this.profileLoaded = true;
      localStorage.setItem('autotrader_token', token);
      localStorage.setItem('autotrader_user', JSON.stringify(user));
    },
    logout() {
      this.token = null;
      this.user = null;
      this.profileLoaded = false;
      localStorage.removeItem('autotrader_token');
      localStorage.removeItem('autotrader_user');
    },
  },
});
