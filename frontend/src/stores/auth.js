import { defineStore } from 'pinia';
import api from '../api/client';

export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: localStorage.getItem('autotrader_token') || null,
    user: JSON.parse(localStorage.getItem('autotrader_user') || 'null'),
  }),
  getters: {
    isAuthenticated: (state) => Boolean(state.token),
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
    setSession({ token, user }) {
      this.token = token;
      this.user = user;
      localStorage.setItem('autotrader_token', token);
      localStorage.setItem('autotrader_user', JSON.stringify(user));
    },
    logout() {
      this.token = null;
      this.user = null;
      localStorage.removeItem('autotrader_token');
      localStorage.removeItem('autotrader_user');
    },
  },
});
