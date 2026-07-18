<template>
  <div class="login-page" :style="{ '--login-hero-image': `url(${heroImage})` }">
    <div class="login-aurora" aria-hidden="true"></div>
    <div class="login-particles" aria-hidden="true">
      <span v-for="particle in particles" :key="particle" :style="{ '--i': particle }"></span>
    </div>

    <header class="login-nav liquid-glass">
      <router-link to="/" class="login-brand">
        <span class="login-brand-mark"><v-icon icon="mdi-hexagon-multiple-outline" size="22" /></span>
        <span>AUTOTRADER</span>
      </router-link>
      <router-link to="/" class="login-overview">Platform overview</router-link>
    </header>

    <main class="login-shell">
      <section class="login-story liquid-glass">
        <p class="login-kicker">Autonomous trading command layer</p>
        <h1>Return to the operator workspace.</h1>
        <p>
          Pick up research signals, simulated ledgers, agent council reports, and trade guardrails from the same
          liquid command layer.
        </p>

        <div class="login-signal-grid">
          <div v-for="item in signalCards" :key="item.label" class="login-signal">
            <v-icon :icon="item.icon" size="20" />
            <span>{{ item.label }}</span>
            <strong>{{ item.value }}</strong>
          </div>
        </div>
      </section>

      <aside class="login-card liquid-glass" aria-label="Sign in">
        <div class="login-card-header">
          <div>
            <p class="login-kicker">Secure access</p>
            <h2>Sign in</h2>
          </div>
          <span class="login-status">
            <span></span>
            BMCL online
          </span>
        </div>

        <form @submit.prevent="submit" class="login-form">
          <v-text-field
            v-model="email"
            class="login-field"
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
            class="login-field"
            label="Password"
            type="password"
            variant="outlined"
            density="comfortable"
            prepend-inner-icon="mdi-lock-outline"
            hide-details
            required
          />

          <div v-if="error" class="login-error">{{ error }}</div>

          <button type="submit" :disabled="loading" class="login-submit">
            <span>{{ loading ? 'Checking access' : 'Enter workspace' }}</span>
            <strong><v-icon :icon="loading ? 'mdi-loading' : 'mdi-arrow-right'" size="22" /></strong>
          </button>
        </form>

        <div class="login-footnote">
          <v-icon icon="mdi-shield-check-outline" size="18" />
          <span>Credentials unlock the private trading cockpit. Public overview stays outside the workspace.</span>
        </div>
      </aside>
    </main>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import heroImage from '../assets/home-ai-trading-hero.png';

const particles = Array.from({ length: 20 }, (_, index) => index + 1);
const email = ref('');
const password = ref('');
const error = ref('');
const loading = ref(false);

const signalCards = [
  { label: 'Research', value: 'autonomous', icon: 'mdi-radar' },
  { label: 'Simulation', value: 'paper P&L', icon: 'mdi-chart-timeline-variant' },
  { label: 'Council', value: 'agent review', icon: 'mdi-account-group' },
];

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
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght,SOFT,WONK@9..144,300..800,40..100,0..1&family=Inter:wght@400;500;600;700;800;900&display=swap');

.login-page {
  --display-font: 'Fraunces', 'Cormorant Garamond', Georgia, serif;
  --body-font: 'Inter', 'DM Sans', system-ui, sans-serif;
  --ink: #f7f8ff;
  --muted: rgba(247, 248, 255, 0.72);
  --line: rgba(255, 255, 255, 0.25);
  --glass: rgba(101, 119, 185, 0.34);
  position: relative;
  min-height: 100vh;
  overflow-x: hidden;
  color: var(--ink);
  font-family: var(--body-font);
  background:
    linear-gradient(180deg, rgba(74, 105, 166, 0.46), rgba(7, 11, 27, 0.90) 68%, #050914),
    linear-gradient(90deg, rgba(42, 62, 113, 0.80), rgba(119, 149, 214, 0.28) 48%, rgba(47, 38, 89, 0.68)),
    var(--login-hero-image) center / cover no-repeat fixed;
}

.login-page::before,
.login-page::after {
  content: '';
  position: fixed;
  inset: 0;
  pointer-events: none;
}

.login-page::before {
  z-index: 0;
  background:
    radial-gradient(circle at 20% 22%, rgba(255, 220, 189, 0.18), transparent 15%),
    radial-gradient(circle at 58% 8%, rgba(219, 205, 255, 0.22), transparent 20%),
    radial-gradient(circle at 88% 32%, rgba(135, 184, 255, 0.22), transparent 24%),
    linear-gradient(180deg, rgba(255, 255, 255, 0.09), transparent 20%);
  filter: blur(2px);
}

.login-page::after {
  z-index: 1;
  opacity: 0.32;
  background:
    radial-gradient(circle, rgba(255, 255, 255, 0.42) 0 1px, transparent 1.5px),
    linear-gradient(rgba(255, 255, 255, 0.035) 1px, transparent 1px);
  background-size: 38px 38px, 100% 6px;
  mix-blend-mode: screen;
}

.login-page > * {
  position: relative;
  z-index: 2;
}

.login-aurora {
  position: fixed;
  inset: -18% -10% auto;
  height: 52vh;
  z-index: 1;
  pointer-events: none;
  opacity: 0.72;
  background:
    radial-gradient(ellipse at 18% 60%, rgba(255, 204, 180, 0.22), transparent 34%),
    radial-gradient(ellipse at 54% 20%, rgba(222, 207, 255, 0.30), transparent 36%),
    radial-gradient(ellipse at 86% 72%, rgba(123, 181, 255, 0.26), transparent 35%);
  filter: blur(34px);
}

.login-particles {
  position: fixed;
  inset: 0;
  z-index: 2;
  pointer-events: none;
  overflow: hidden;
}

.login-particles span {
  position: absolute;
  left: calc((var(--i) * 73px) % 100vw);
  top: calc(12vh + ((var(--i) * 31px) % 52vh));
  width: calc(4px + (var(--i) % 3) * 2px);
  height: calc(4px + (var(--i) % 3) * 2px);
  border-radius: 999px;
  background: rgba(255, 230, 205, 0.72);
  box-shadow: 0 0 18px rgba(255, 231, 205, 0.54);
  animation: particleFloat calc(9s + (var(--i) * 0.35s)) ease-in-out infinite;
}

@keyframes particleFloat {
  0%, 100% { transform: translate3d(0, 0, 0); opacity: 0.12; }
  45% { transform: translate3d(24px, -72px, 0); opacity: 0.86; }
}

@keyframes loginReveal {
  from {
    opacity: 0;
    transform: translate3d(0, 18px, 0) scale(0.985);
    filter: blur(8px);
  }
  to {
    opacity: 1;
    transform: translate3d(0, 0, 0) scale(1);
    filter: blur(0);
  }
}

.liquid-glass {
  position: relative;
  border: 1px solid var(--line);
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.24), rgba(255, 255, 255, 0.07) 46%, rgba(120, 126, 195, 0.20)),
    var(--glass);
  backdrop-filter: blur(28px) saturate(145%);
  -webkit-backdrop-filter: blur(28px) saturate(145%);
  border-radius: 28px;
  box-shadow:
    inset 0 1px 1px rgba(255, 255, 255, 0.36),
    inset 0 -22px 52px rgba(28, 33, 75, 0.16),
    0 26px 90px rgba(13, 19, 48, 0.32);
  overflow: hidden;
}

.liquid-glass::before {
  content: '';
  position: absolute;
  inset: 1px;
  border-radius: inherit;
  pointer-events: none;
  background:
    linear-gradient(145deg, rgba(255, 255, 255, 0.24), transparent 28%),
    radial-gradient(circle at 82% 14%, rgba(255, 255, 255, 0.22), transparent 22%);
  opacity: 0.68;
}

.liquid-glass > * {
  position: relative;
  z-index: 1;
}

.login-nav {
  position: fixed;
  top: 18px;
  left: 48px;
  right: 48px;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  min-height: 58px;
  padding: 0 16px;
  border-radius: 22px;
  background:
    linear-gradient(135deg, rgba(108, 139, 202, 0.42), rgba(110, 136, 196, 0.18)),
    rgba(74, 98, 154, 0.28);
  animation: loginReveal 640ms ease both;
}

.login-brand,
.login-overview {
  color: inherit;
  text-decoration: none;
}

.login-brand {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  font-size: 1rem;
  font-weight: 900;
  letter-spacing: 0.06em;
}

.login-brand-mark {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  color: #5a70a8;
  background: rgba(255, 255, 255, 0.92);
  border-radius: 10px;
}

.login-overview {
  min-height: 42px;
  display: inline-flex;
  align-items: center;
  padding: 0 16px;
  color: #17142c;
  background: linear-gradient(135deg, #efe2ff, #c9bbff);
  border: 1px solid rgba(255, 255, 255, 0.58);
  border-radius: 10px;
  font-weight: 700;
  box-shadow: 0 12px 36px rgba(77, 56, 151, 0.22);
}

.login-shell {
  width: min(1180px, calc(100% - 40px));
  min-height: 100vh;
  margin: 0 auto;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(360px, 430px);
  gap: clamp(20px, 4vw, 44px);
  align-items: center;
  padding: 112px 0 54px;
}

.login-story,
.login-card {
  animation: loginReveal 720ms ease both;
}

.login-story {
  min-height: 530px;
  padding: clamp(28px, 5vw, 54px);
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}

.login-kicker {
  margin: 0 0 12px;
  color: rgba(234, 244, 255, 0.78);
  font-size: 0.76rem;
  font-weight: 900;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.login-story h1 {
  max-width: 720px;
  margin: 0;
  color: #ffffff;
  font-family: var(--display-font);
  font-size: clamp(2.35rem, 4.4vw, 4.35rem);
  font-weight: 580;
  font-variation-settings: 'SOFT' 82, 'WONK' 0.28;
  line-height: 1.02;
  letter-spacing: 0.004em;
  text-wrap: balance;
  text-shadow: 0 18px 54px rgba(30, 42, 91, 0.40);
}

.login-story > p:not(.login-kicker) {
  max-width: 660px;
  margin: 18px 0 0;
  color: var(--muted);
  font-size: 1.02rem;
  line-height: 1.65;
}

.login-signal-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
  margin-top: 42px;
}

.login-signal {
  min-width: 0;
  min-height: 118px;
  padding: 16px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 18px;
  background:
    radial-gradient(circle at 82% 18%, rgba(218, 200, 255, 0.18), transparent 34%),
    rgba(255, 255, 255, 0.08);
  box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.18);
}

.login-signal .v-icon {
  color: #ffffff;
  margin-bottom: 18px;
}

.login-signal span,
.login-signal strong {
  display: block;
  min-width: 0;
}

.login-signal span {
  color: rgba(255, 255, 255, 0.62);
  font-size: 0.76rem;
  font-weight: 900;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.login-signal strong {
  margin-top: 6px;
  color: #ffffff;
  font-size: 0.92rem;
  font-weight: 700;
}

.login-card {
  padding: clamp(24px, 4vw, 34px);
  background:
    radial-gradient(circle at 86% 14%, rgba(218, 200, 255, 0.24), transparent 28%),
    linear-gradient(135deg, rgba(255, 255, 255, 0.28), rgba(111, 128, 192, 0.18) 52%, rgba(55, 66, 127, 0.36)),
    rgba(68, 82, 151, 0.54);
}

.login-card-header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  margin-bottom: 28px;
}

.login-card h2 {
  margin: 0;
  color: #ffffff;
  font-family: var(--display-font);
  font-size: clamp(2rem, 4vw, 2.8rem);
  font-weight: 580;
  font-variation-settings: 'SOFT' 82, 'WONK' 0.22;
  line-height: 1;
}

.login-status {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 30px;
  padding: 0 11px;
  color: #ffffff;
  border: 1px solid rgba(255, 255, 255, 0.24);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.11);
  font-size: 0.68rem;
  font-weight: 900;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.login-status span {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: #87f5ff;
  box-shadow: 0 0 14px rgba(135, 245, 255, 0.72);
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.login-field {
  width: 100%;
}

:deep(.login-field .v-field) {
  min-height: 56px;
  color: #ffffff;
  border-radius: 17px;
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0.05)),
    rgba(12, 18, 44, 0.28) !important;
  backdrop-filter: blur(18px) saturate(140%);
  -webkit-backdrop-filter: blur(18px) saturate(140%);
  box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.13);
}

:deep(.login-field .v-field__outline) {
  color: rgba(255, 255, 255, 0.28);
}

:deep(.login-field .v-label),
:deep(.login-field .v-field__prepend-inner),
:deep(.login-field input) {
  color: rgba(255, 255, 255, 0.82) !important;
}

.login-submit {
  appearance: none;
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  width: 100%;
  min-height: 64px;
  margin-top: 4px;
  padding: 0 10px 0 22px;
  color: #ffffff;
  border: 3px solid rgba(43, 35, 95, 0.78);
  border-radius: 16px;
  background: #171433;
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.08),
    0 18px 48px rgba(28, 24, 76, 0.38);
  cursor: pointer;
  overflow: hidden;
  font: inherit;
  font-weight: 900;
}

.login-submit:disabled {
  cursor: progress;
  opacity: 0.76;
}

.login-submit strong {
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  border-radius: 13px;
  background:
    radial-gradient(circle at 26% 80%, rgba(255, 115, 177, 0.84), transparent 34%),
    linear-gradient(135deg, #9e70ff, #5a71f0);
  box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.34), 0 8px 22px rgba(94, 93, 245, 0.42);
}

.login-error {
  padding: 0.82rem 0.92rem;
  color: #ffd5df;
  font-size: 0.86rem;
  border: 1px solid rgba(255, 127, 171, 0.34);
  background: rgba(105, 33, 73, 0.28);
  border-radius: 14px;
}

.login-footnote {
  display: flex;
  gap: 10px;
  margin-top: 22px;
  color: rgba(255, 255, 255, 0.62);
  font-size: 0.82rem;
  line-height: 1.45;
}

.login-footnote .v-icon {
  flex: 0 0 auto;
  margin-top: 1px;
  color: rgba(255, 255, 255, 0.82);
}

@media (max-width: 920px) {
  .login-nav {
    left: 20px;
    right: 20px;
  }

  .login-shell {
    grid-template-columns: 1fr;
    width: min(760px, calc(100% - 40px));
  }

  .login-story {
    min-height: auto;
  }

  .login-card {
    order: -1;
  }
}

@media (max-width: 620px) {
  .login-page {
    background-attachment: scroll;
  }

  .login-nav {
    left: 10px;
    right: 10px;
    min-height: 54px;
    padding: 0 10px;
  }

  .login-brand {
    font-size: 0.86rem;
  }

  .login-overview {
    min-height: 38px;
    padding: 0 12px;
    font-size: 0.86rem;
  }

  .login-shell {
    width: calc(100% - 24px);
    padding: 88px 0 34px;
    gap: 16px;
  }

  .login-story,
  .login-card {
    padding: 22px;
  }

  .login-story h1 {
    font-size: clamp(2.1rem, 12vw, 3.15rem);
  }

  .login-signal-grid {
    grid-template-columns: 1fr;
    margin-top: 28px;
  }

  .login-card-header {
    flex-direction: column;
  }
}
</style>
