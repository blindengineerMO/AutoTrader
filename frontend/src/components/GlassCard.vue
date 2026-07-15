<template>
  <div class="glass-panel app-card p-4" :class="tone === 'danger' ? 'ring-1 ring-danger/40' : ''">
    <div v-if="title" class="hud-title-row flex items-center justify-between mb-3">
      <h3 class="font-headline text-xs uppercase text-white/60">{{ title }}</h3>
      <slot name="actions" />
    </div>
    <slot />
  </div>
</template>

<script setup>
defineProps({
  title: { type: String, default: '' },
  tone: { type: String, default: 'default' },
});
</script>
