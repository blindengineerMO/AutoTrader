<template>
  <div class="hud-ring-wrap">
    <canvas ref="canvasEl" aria-label="Allocation ring chart"></canvas>
    <div class="hud-ring-center">
      <span>{{ centerValue }}</span>
      <small>{{ centerLabel }}</small>
    </div>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ArcElement, Chart, DoughnutController, Tooltip } from 'chart.js';

Chart.register(DoughnutController, ArcElement, Tooltip);

const props = defineProps({
  values: { type: Array, default: () => [42, 26, 18, 14] },
  labels: { type: Array, default: () => ['Cash', 'Positions', 'Risk', 'Reserve'] },
  centerValue: { type: String, default: 'SIM' },
  centerLabel: { type: String, default: 'mode' },
});

const canvasEl = ref(null);
let chart;

function renderChart() {
  if (!canvasEl.value) return;
  if (chart) chart.destroy();
  chart = new Chart(canvasEl.value, {
    type: 'doughnut',
    data: {
      labels: props.labels,
      datasets: [
        {
          data: props.values,
          backgroundColor: ['#1ed6ff', '#7c5cff', '#ff3d81', 'rgba(223, 248, 255, 0.22)'],
          borderColor: 'rgba(7, 18, 32, 0.92)',
          borderWidth: 4,
          hoverOffset: 6,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '72%',
      animation: { duration: 650, easing: 'easeOutQuart' },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(6, 14, 25, 0.92)',
          borderColor: 'rgba(30, 214, 255, 0.42)',
          borderWidth: 1,
          titleColor: '#dff8ff',
          bodyColor: '#dff8ff',
        },
      },
    },
  });
}

onMounted(renderChart);
watch(() => [props.values, props.labels], renderChart, { deep: true });
onBeforeUnmount(() => chart?.destroy());
</script>
