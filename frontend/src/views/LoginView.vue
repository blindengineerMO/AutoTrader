<template>
  <div class="auth-page">
    <div class="auth-orbit auth-orbit-one"></div>
    <div class="auth-orbit auth-orbit-two"></div>

    <section class="auth-frame">
      <div class="auth-hero">
        <div class="auth-brand-row">
          <div class="auth-mark">
            <v-icon icon="mdi-hexagon-multiple-outline" size="24" />
          </div>
          <div>
            <p class="auth-kicker">Autonomous trading command layer</p>
            <div class="auth-brand">AUTOTRADER</div>
          </div>
        </div>

        <div class="auth-copy">
          <h1>Secure AI trading cockpit.</h1>
          <p>
            AI research signals, decision reports, account guardrails, and simulation controls are isolated per operator.
          </p>
        </div>

        <div class="auth-metrics">
          <div class="auth-metric">
            <span>24H</span>
            <strong>rule engine</strong>
          </div>
          <div class="auth-metric">
            <span>AI</span>
            <strong>research brain</strong>
          </div>
          <div class="auth-metric">
            <span>SIM</span>
            <strong>paper ledger</strong>
          </div>
        </div>
      </div>

      <aside class="auth-console">
        <div class="auth-console-header">
          <div>
            <p>Secure access</p>
            <h2>Sign in</h2>
          </div>
          <span class="auth-status">BMCL online</span>
        </div>

        <form @submit.prevent="submit" class="auth-form">
          <v-text-field
            v-model="email"
            class="auth-field"
            label="Email"
            type="email"
            variant="outlined"
            density="comfortable"
            prepend-inner-icon="mdi-email-outline"
            hide-details
            required
          />
          <v-text-field
            v-model="password"
            class="auth-field"
            label="Password"
            type="password"
            variant="outlined"
            density="comfortable"
            prepend-inner-icon="mdi-lock-outline"
            hide-details
            required
          />

          <div v-if="error" class="auth-error">{{ error }}</div>

          <GlassButton type="submit" :disabled="loading" class="auth-submit">
            <v-icon icon="mdi-login" size="18" />
            <span>{{ loading ? 'Working...' : 'Sign in' }}</span>
          </GlassButton>
        </form>

        <router-link class="auth-mode-toggle" to="/">View platform overview</router-link>
      </aside>
    </section>
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

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

async function submit() {
  error.value = '';
  loading.value = true;
  try {
    await auth.login(email.value, password.value);
    router.push(route.query.redirect || { name: 'dashboard' });
  } catch (err) {
    error.value = err.response?.data?.error || 'Something went wrong';
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.auth-page {
  position: relative;
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: clamp(1rem, 3vw, 2.5rem);
  overflow: hidden;
}

.auth-page::before {
  content: '';
  position: absolute;
  inset: 8vh 5vw;
  pointer-events: none;
  background:
    linear-gradient(rgba(39, 215, 255, 0.06) 1px, transparent 1px),
    linear-gradient(90deg, rgba(39, 215, 255, 0.045) 1px, transparent 1px),
    linear-gradient(112deg, transparent 0 48%, rgba(39, 215, 255, 0.13) 48.2% 48.8%, transparent 49%),
    radial-gradient(circle at 24% 24%, rgba(39, 215, 255, 0.18), transparent 34%),
    radial-gradient(circle at 82% 76%, rgba(124, 92, 255, 0.14), transparent 28%);
  background-size: 42px 42px, 42px 42px, auto, auto, auto;
  border: 1px solid rgba(109, 225, 255, 0.16);
  opacity: 0.7;
  clip-path: polygon(0 28px, 28px 0, 100% 0, 100% calc(100% - 28px), calc(100% - 28px) 100%, 0 100%);
}

.auth-orbit {
  position: absolute;
  pointer-events: none;
  border-radius: 999px;
  filter: blur(28px);
}

.auth-orbit-one {
  width: min(520px, 52vw);
  height: min(520px, 52vw);
  left: 8vw;
  top: 10vh;
  background: rgba(39, 215, 255, 0.11);
}

.auth-orbit-two {
  width: min(420px, 42vw);
  height: min(420px, 42vw);
  right: 10vw;
  bottom: 10vh;
  background: rgba(124, 92, 255, 0.12);
}

.auth-frame {
  position: relative;
  z-index: 1;
  width: min(1120px, 100%);
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(360px, 420px);
  gap: clamp(1.25rem, 3vw, 2.25rem);
  align-items: stretch;
  padding: clamp(1rem, 2.4vw, 1.5rem);
  background:
    linear-gradient(135deg, rgba(20, 31, 47, 0.84), rgba(8, 15, 25, 0.72)),
    rgba(12, 20, 33, 0.76);
  border: 1px solid rgba(109, 225, 255, 0.24);
  clip-path: polygon(0 30px, 30px 0, 100% 0, 100% calc(100% - 30px), calc(100% - 30px) 100%, 0 100%);
  box-shadow:
    0 34px 110px rgba(0, 0, 0, 0.54),
    0 0 54px rgba(39, 215, 255, 0.13),
    inset 0 1px 0 rgba(255, 255, 255, 0.10);
  backdrop-filter: blur(22px) saturate(145%);
}

.auth-hero {
  min-height: 460px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  min-width: 0;
  padding: clamp(1rem, 2.8vw, 2rem);
}

.auth-brand-row {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.auth-mark {
  width: 48px;
  height: 48px;
  display: grid;
  place-items: center;
  color: #dff8ff;
  border: 1px solid rgba(109, 225, 255, 0.32);
  background: linear-gradient(135deg, rgba(39, 215, 255, 0.18), rgba(124, 92, 255, 0.10));
  box-shadow: 0 0 30px rgba(39, 215, 255, 0.18);
  clip-path: polygon(0 10px, 10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%);
}

.auth-kicker {
  margin: 0 0 0.2rem;
  color: rgba(237, 247, 255, 0.48);
  font-size: 0.72rem;
  font-weight: 800;
  letter-spacing: 0.13em;
  text-transform: uppercase;
}

.auth-brand {
  font-family: 'Space Mono', monospace;
  font-size: 1rem;
  font-weight: 700;
  color: #f4fbff;
  letter-spacing: 0.08em;
  text-shadow: 0 0 22px rgba(39, 215, 255, 0.42);
}

.auth-copy {
  max-width: 680px;
  margin-block: clamp(2rem, 6vh, 4rem);
}

.auth-copy h1 {
  margin: 0;
  max-width: 620px;
  font-family: 'Space Mono', monospace;
  font-size: clamp(2.05rem, 4.2vw, 3.85rem);
  line-height: 1.02;
  letter-spacing: 0;
  color: #edf8ff;
  text-shadow: 0 0 28px rgba(39, 215, 255, 0.18);
}

.auth-copy p {
  max-width: 600px;
  margin: 1.35rem 0 0;
  color: rgba(237, 247, 255, 0.58);
  font-size: 1rem;
  line-height: 1.7;
}

.auth-metrics {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.85rem;
}

.auth-metric {
  min-width: 0;
  padding: 1rem;
  border: 1px solid rgba(109, 225, 255, 0.16);
  background: linear-gradient(135deg, rgba(6, 14, 24, 0.70), rgba(15, 25, 39, 0.46));
  clip-path: polygon(0 12px, 12px 0, 100% 0, 100% calc(100% - 12px), calc(100% - 12px) 100%, 0 100%);
}

.auth-metric span {
  display: block;
  font-family: 'Space Mono', monospace;
  color: #6de1ff;
  font-size: 1.2rem;
  font-weight: 700;
}

.auth-metric strong {
  display: block;
  margin-top: 0.2rem;
  color: rgba(237, 247, 255, 0.44);
  font-size: 0.75rem;
  font-weight: 600;
}

.auth-console {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-width: 0;
  padding: clamp(1.25rem, 2.8vw, 2rem);
  border: 1px solid rgba(109, 225, 255, 0.20);
  background:
    linear-gradient(180deg, rgba(18, 27, 42, 0.88), rgba(7, 13, 22, 0.84)),
    rgba(8, 14, 24, 0.82);
  box-shadow:
    0 28px 80px rgba(0, 0, 0, 0.42),
    0 0 40px rgba(39, 215, 255, 0.11),
    inset 0 1px 0 rgba(255, 255, 255, 0.11);
  clip-path: polygon(0 22px, 22px 0, 100% 0, 100% calc(100% - 22px), calc(100% - 22px) 100%, 0 100%);
}

.auth-console-header {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  align-items: flex-start;
  margin-bottom: 1.5rem;
}

.auth-console-header p {
  margin: 0 0 0.35rem;
  color: rgba(237, 247, 255, 0.42);
  font-size: 0.76rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.auth-console-header h2 {
  margin: 0;
  color: #f8fcff;
  font-family: 'Playfair Display', serif;
  font-size: 2.35rem;
  line-height: 1;
}

.auth-status {
  flex-shrink: 0;
  padding: 0.38rem 0.58rem;
  color: #6de1ff;
  font-family: 'Space Mono', monospace;
  font-size: 0.62rem;
  border: 1px solid rgba(109, 225, 255, 0.24);
  background: rgba(39, 215, 255, 0.08);
  border-radius: 999px;
}

.auth-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.auth-field {
  width: 100%;
}

.auth-submit {
  width: 100%;
  display: inline-flex;
  justify-content: center;
  align-items: center;
  gap: 0.5rem;
  min-height: 48px;
  margin-top: 0.25rem;
}

.auth-error {
  padding: 0.8rem 0.9rem;
  color: #ff8aa6;
  font-size: 0.85rem;
  border: 1px solid rgba(255, 61, 129, 0.26);
  background: rgba(255, 61, 129, 0.08);
  border-radius: 10px;
}

.auth-mode-toggle {
  width: 100%;
  margin-top: 1rem;
  padding: 0.75rem;
  color: rgba(237, 247, 255, 0.64);
  font-size: 0.8rem;
  border: 1px solid rgba(109, 225, 255, 0.12);
  background: rgba(255, 255, 255, 0.03);
  border-radius: 12px;
  transition: color 160ms ease, background 160ms ease, border-color 160ms ease;
}

.auth-mode-toggle:hover {
  color: #f8fcff;
  border-color: rgba(109, 225, 255, 0.28);
  background: rgba(39, 215, 255, 0.08);
}

:deep(.auth-field .v-field) {
  min-height: 52px;
  background: rgba(6, 14, 24, 0.62) !important;
  border-radius: 14px;
}

:deep(.auth-field .v-label) {
  color: rgba(237, 247, 255, 0.62) !important;
}

:deep(.auth-field input) {
  color: #f8fcff !important;
}

@media (max-width: 920px) {
  .auth-frame {
    grid-template-columns: 1fr;
  }

  .auth-hero {
    min-height: auto;
  }

  .auth-copy {
    margin-block: 2rem;
  }
}

@media (max-width: 620px) {
  .auth-page {
    place-items: start center;
    padding: 1rem;
  }

  .auth-frame {
    clip-path: polygon(0 20px, 20px 0, 100% 0, 100% calc(100% - 20px), calc(100% - 20px) 100%, 0 100%);
  }

  .auth-metrics {
    grid-template-columns: 1fr;
  }

  .auth-copy h1 {
    font-size: 2rem;
  }

  .auth-console-header {
    flex-direction: column;
  }
}
</style>
