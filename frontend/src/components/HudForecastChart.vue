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
  labels: { type: Array, default: () => [] },
  p10: { type: Array, default: () => [] },
  p50: { type: Array, default: () => [] },
  p90: { type: Array, default: () => [] },
  ariaLabel: { type: String, default: 'Forecast fan chart' },
});

const canvasEl = ref(null);
let chart;

function renderChart() {
  if (!canvasEl.value) return;
  if (chart) chart.destroy();

  chart = new Chart(canvasEl.value, {
    type: 'line',
    data: {
      labels: props.labels,
      datasets: [
        {
          label: 'p10',
          data: props.p10,
          borderWidth: 0,
          pointRadius: 0,
          fill: false,
          tension: 0.3,
        },
        {
          label: 'p10-p90 range',
          data: props.p90,
          borderWidth: 0,
          pointRadius: 0,
          fill: '-1',
          backgroundColor: 'rgba(124, 92, 255, 0.16)',
          tension: 0.3,
        },
        {
          label: 'Median',
          data: props.p50,
          borderColor: '#1ed6ff',
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          fill: false,
          tension: 0.3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 620, easing: 'easeOutQuart' },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          displayColors: false,
          backgroundColor: 'rgba(6, 14, 25, 0.92)',
          borderColor: 'rgba(30, 214, 255, 0.42)',
          borderWidth: 1,
          titleColor: '#dff8ff',
          bodyColor: '#dff8ff',
          filter: (item) => item.dataset.label === 'Median',
          callbacks: {
            label: (item) => `Median: ${Number(item.parsed.y || 0).toFixed(2)}`,
          },
        },
      },
      scales: {
        x: {
          grid: { color: 'rgba(30, 214, 255, 0.08)', drawBorder: false },
          ticks: { color: 'rgba(223, 248, 255, 0.55)', font: { family: 'DM Sans', size: 11 }, maxTicksLimit: 10 },
        },
        y: {
          grid: { color: 'rgba(30, 214, 255, 0.08)', drawBorder: false },
          ticks: {
            color: 'rgba(223, 248, 255, 0.45)',
            font: { family: 'DM Sans', size: 11 },
            callback: (value) => `$${Number(value).toFixed(0)}`,
          },
        },
      },
    },
  });
}

onMounted(renderChart);
watch(() => [props.labels, props.p10, props.p50, props.p90], renderChart, { deep: true });
onBeforeUnmount(() => chart?.destroy());
</script>
