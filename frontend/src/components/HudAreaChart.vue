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
  series: {
    type: Array,
    default: () => [],
    // [{ label, values, color }]
  },
  valueSuffix: { type: String, default: '' },
  ariaLabel: { type: String, default: 'Area chart' },
});

const canvasEl = ref(null);
let chart;

function renderChart() {
  if (!canvasEl.value) return;
  if (chart) chart.destroy();
  const ctx = canvasEl.value.getContext('2d');
  const datasets = props.series.map((s) => {
    const gradient = ctx.createLinearGradient(0, 0, 0, 240);
    gradient.addColorStop(0, hexToRgba(s.color || '#1ed6ff', 0.32));
    gradient.addColorStop(1, hexToRgba(s.color || '#1ed6ff', 0.02));
    return {
      label: s.label,
      data: s.values,
      borderColor: s.color || '#1ed6ff',
      borderWidth: 2,
      backgroundColor: gradient,
      fill: true,
      tension: 0.35,
      pointRadius: 2,
      pointHoverRadius: 4,
      pointBackgroundColor: '#dff8ff',
      pointBorderColor: s.color || '#1ed6ff',
    };
  });

  chart = new Chart(ctx, {
    type: 'line',
    data: { labels: props.labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 620, easing: 'easeOutQuart' },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: datasets.length > 1,
          labels: { color: 'rgba(223, 248, 255, 0.6)', font: { family: 'DM Sans', size: 11 }, boxWidth: 10 },
        },
        tooltip: {
          displayColors: false,
          backgroundColor: 'rgba(6, 14, 25, 0.92)',
          borderColor: 'rgba(30, 214, 255, 0.42)',
          borderWidth: 1,
          titleColor: '#dff8ff',
          bodyColor: '#dff8ff',
          callbacks: {
            label: (item) => `${item.dataset.label}: ${Number(item.parsed.y || 0).toFixed(2)}${props.valueSuffix}`,
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

function hexToRgba(hex, alpha) {
  const clean = hex.replace('#', '');
  const bigint = parseInt(clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

onMounted(renderChart);
watch(() => [props.labels, props.series], renderChart, { deep: true });
onBeforeUnmount(() => chart?.destroy());
</script>
