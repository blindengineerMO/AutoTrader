<template>
  <button
    class="glass-button rounded-xl px-5 py-2.5 font-bold text-sm"
    :class="[
      danger ? 'danger' : '',
      variant === 'ghost' ? 'ghost' : '',
      disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer',
    ]"
    :type="type"
    :disabled="disabled"
    @click="$emit('click', $event)"
  >
    <slot />
  </button>
</template>

<script setup>
defineProps({
  danger: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  type: { type: String, default: 'button' },
  variant: { type: String, default: 'primary' },
});
defineEmits(['click']);
</script>
