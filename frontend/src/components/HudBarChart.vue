<template>
  <div class="hud-chart-wrap">
    <canvas ref="canvasEl" :aria-label="ariaLabel"></canvas>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { BarController, BarElement, CategoryScale, Chart, LinearScale, Tooltip } from 'chart.js';

Chart.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip);

const props = defineProps({
  labels: { type: Array, default: () => [] },
  values: { type: Array, default: () => [] },
  colors: { type: Array, default: () => [] },
  datasetLabel: { type: String, default: 'Value' },
  valueSuffix: { type: String, default: '' },
  ariaLabel: { type: String, default: 'Bar chart' },
});

const canvasEl = ref(null);
let chart;

function renderChart() {
  if (!canvasEl.value) return;
  if (chart) chart.destroy();
  const palette = ['#1ed6ff', '#7c5cff', '#ff3d81', '#38e6b5', '#ffb84d'];
  chart = new Chart(canvasEl.value, {
    type: 'bar',
    data: {
      labels: props.labels,
      datasets: [
        {
          label: props.datasetLabel,
          data: props.values,
          backgroundColor: props.labels.map((_, i) => props.colors[i] || palette[i % palette.length]),
          borderRadius: 6,
          maxBarThickness: 36,
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
            label: (item) => `${props.datasetLabel}: ${Number(item.parsed.y || 0).toFixed(1)}${props.valueSuffix}`,
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: 'rgba(223, 248, 255, 0.55)', font: { family: 'DM Sans', size: 11 } },
        },
        y: {
          grid: { color: 'rgba(30, 214, 255, 0.08)', drawBorder: false },
          beginAtZero: true,
          ticks: {
            color: 'rgba(223, 248, 255, 0.45)',
            font: { family: 'DM Sans', size: 11 },
            callback: (value) => `${Number(value).toFixed(0)}${props.valueSuffix}`,
          },
        },
      },
    },
  });
}

onMounted(renderChart);
watch(() => [props.labels, props.values, props.colors], renderChart, { deep: true });
onBeforeUnmount(() => chart?.destroy());
</script>
