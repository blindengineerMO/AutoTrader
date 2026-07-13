<template>
  <div class="hud-chart-wrap">
    <canvas ref="canvasEl" :aria-label="ariaLabel"></canvas>
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
  datasetLabel: { type: String, default: 'Value' },
  valuePrefix: { type: String, default: '' },
  ariaLabel: { type: String, default: 'Line chart' },
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
          label: props.datasetLabel,
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
          callbacks: {
            label: (item) => `${props.datasetLabel}: ${props.valuePrefix}${formatValue(item.parsed.y)}`,
          },
        },
      },
      scales: {
        x: {
          grid: { color: 'rgba(30, 214, 255, 0.08)', drawBorder: false },
          ticks: { color: 'rgba(223, 248, 255, 0.55)', font: { family: 'DM Sans', size: 11 } },
        },
        y: {
          grid: { color: 'rgba(30, 214, 255, 0.08)', drawBorder: false },
          beginAtZero: true,
          ticks: {
            color: 'rgba(223, 248, 255, 0.45)',
            font: { family: 'DM Sans', size: 11 },
            callback: (value) => `${props.valuePrefix}${formatValue(value)}`,
          },
        },
      },
    },
  });
}

onMounted(renderChart);
watch(() => [props.labels, props.values, props.datasetLabel, props.valuePrefix], renderChart, { deep: true });
onBeforeUnmount(() => chart?.destroy());

function formatValue(value) {
  return Number(value || 0).toFixed(2);
}
</script>
