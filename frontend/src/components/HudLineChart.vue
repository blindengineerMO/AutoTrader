<template>
  <div class="hud-chart-wrap">
    <canvas ref="canvasEl" aria-label="Telemetry line chart"></canvas>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  CategoryScale,
  Chart,
  Filler,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
} from 'chart.js';

Chart.register(CategoryScale, LinearScale, LineController, LineElement, PointElement, Filler, Tooltip);

const props = defineProps({
  labels: { type: Array, default: () => ['09', '10', '11', '12', '13', '14', '15'] },
  values: { type: Array, default: () => [22, 35, 31, 48, 43, 58, 64] },
});

const canvasEl = ref(null);
let chart;

function renderChart() {
  if (!canvasEl.value) return;
  if (chart) chart.destroy();
  const ctx = canvasEl.value.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, 220);
  gradient.addColorStop(0, 'rgba(30, 214, 255, 0.36)');
  gradient.addColorStop(1, 'rgba(30, 214, 255, 0.02)');
  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: props.labels,
      datasets: [
        {
          data: props.values,
          borderColor: '#1ed6ff',
          borderWidth: 2,
          backgroundColor: gradient,
          fill: true,
          tension: 0.38,
          pointRadius: 3,
          pointHoverRadius: 5,
          pointBackgroundColor: '#dff8ff',
          pointBorderColor: '#1ed6ff',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 620, easing: 'easeOutQuart' },
      plugins: {
        legend: { display: false },
        tooltip: {
          displayColors: false,
          backgroundColor: 'rgba(6, 14, 25, 0.92)',
          borderColor: 'rgba(30, 214, 255, 0.42)',
          borderWidth: 1,
          titleColor: '#dff8ff',
          bodyColor: '#dff8ff',
        },
      },
      scales: {
        x: {
          grid: { color: 'rgba(30, 214, 255, 0.08)', drawBorder: false },
          ticks: { color: 'rgba(223, 248, 255, 0.55)', font: { family: 'DM Sans', size: 11 } },
        },
        y: {
          grid: { color: 'rgba(30, 214, 255, 0.08)', drawBorder: false },
          ticks: { color: 'rgba(223, 248, 255, 0.45)', font: { family: 'DM Sans', size: 11 } },
        },
      },
    },
  });
}

onMounted(renderChart);
watch(() => [props.labels, props.values], renderChart, { deep: true });
onBeforeUnmount(() => chart?.destroy());
</script>
