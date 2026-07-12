<template>
  <div class="min-h-screen flex items-center justify-center p-6 relative">
    <div class="absolute inset-x-[8%] top-[18%] h-64 -skew-y-6 rounded-[42px] bg-accent/10 blur-3xl"></div>
    <div class="glass-panel w-full max-w-[980px] p-6 md:p-10 grid grid-cols-1 lg:grid-cols-[1.2fr_0.8fr] gap-8 items-center">
      <div class="min-h-[360px] flex flex-col justify-between">
        <div>
          <p class="page-kicker mb-4">Autonomous trading command layer</p>
          <div class="page-title !text-[clamp(3rem,9vw,7rem)]">AUTOTRADER</div>
          <p class="page-copy max-w-xl mt-6">
            Research signals, simulated decision reports, and live-trading guardrails in one encrypted cockpit.
          </p>
        </div>
        <div class="grid grid-cols-3 gap-3 mt-8">
          <div class="mini-glass p-4">
            <div class="font-headline text-accent text-xl">24H</div>
            <div class="text-xs text-white/40">rule engine</div>
          </div>
          <div class="mini-glass p-4">
            <div class="font-headline text-accent text-xl">AI</div>
            <div class="text-xs text-white/40">fallbacks</div>
          </div>
          <div class="mini-glass p-4">
            <div class="font-headline text-accent text-xl">SIM</div>
            <div class="text-xs text-white/40">reports</div>
          </div>
        </div>
      </div>

      <div class="mini-glass p-6 md:p-7">
        <div class="font-display text-3xl glow-text text-white mb-1">{{ mode === 'login' ? 'Access' : 'Register' }}</div>
        <div class="text-white/50 text-sm mb-6">{{ mode === 'login' ? 'Sign in to your portal' : 'Create your account' }}</div>

        <form @submit.prevent="submit" class="flex flex-col gap-4">
          <v-text-field v-model="email" label="Email" type="email" variant="outlined" density="comfortable" required />
          <v-text-field v-model="password" label="Password" type="password" variant="outlined" density="comfortable" required />

          <div v-if="error" class="text-danger text-sm">{{ error }}</div>

          <GlassButton type="submit" :disabled="loading" class="mt-2">
            {{ loading ? 'Working...' : mode === 'login' ? 'Sign in' : 'Create account' }}
          </GlassButton>
        </form>

        <button class="text-xs text-white/50 mt-5 underline" @click="mode = mode === 'login' ? 'register' : 'login'">
          {{ mode === 'login' ? "Need an account? Register" : 'Already have an account? Sign in' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import GlassButton from '../components/GlassButton.vue';

const email = ref('');
const password = ref('');
const error = ref('');
const loading = ref(false);
const mode = ref('login');

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

async function submit() {
  error.value = '';
  loading.value = true;
  try {
    if (mode.value === 'login') {
      await auth.login(email.value, password.value);
    } else {
      await auth.register(email.value, password.value);
    }
    router.push(route.query.redirect || { name: 'dashboard' });
  } catch (err) {
    error.value = err.response?.data?.error || 'Something went wrong';
  } finally {
    loading.value = false;
  }
}
</script>
