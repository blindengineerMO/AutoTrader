<template>
  <div class="app-backdrop" aria-hidden="true">
    <div class="app-backdrop-image" :style="imageStyle" />
    <canvas ref="canvasEl" class="app-backdrop-canvas"></canvas>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';
import backgroundArt from '../assets/background.png';

// Darkening/tint overlay sits on top of the art so glass panels keep contrast
// regardless of the source image's own brightness/color balance.
const imageStyle = {
  backgroundImage: `linear-gradient(160deg, rgba(9,15,25,0.48), rgba(11,17,28,0.52) 58%, rgba(8,14,23,0.66)),
    radial-gradient(circle at 20% 20%, rgba(39,215,255,0.12), transparent 45%),
    radial-gradient(circle at 82% 78%, rgba(138,92,255,0.12), transparent 50%),
    url(${backgroundArt})`,
};

const canvasEl = ref(null);
let rafId = null;
let ctx = null;
const blobs = [
  { x: 0.2, y: 0.3, r: 260, hue: [39, 215, 255], dx: 0.00011, dy: 0.00008, t: 0 },
  { x: 0.78, y: 0.65, r: 320, hue: [138, 92, 255], dx: -0.00009, dy: 0.00012, t: 800 },
  { x: 0.55, y: 0.15, r: 200, hue: [255, 61, 129], dx: 0.00007, dy: -0.0001, t: 1600 },
];

const prefersReducedMotion = typeof window !== 'undefined'
  && window.matchMedia
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function resize() {
  if (!canvasEl.value) return;
  canvasEl.value.width = window.innerWidth;
  canvasEl.value.height = window.innerHeight;
}

function draw(time) {
  if (!ctx || !canvasEl.value) return;
  const { width, height } = canvasEl.value;
  ctx.clearRect(0, 0, width, height);
  for (const blob of blobs) {
    const cx = (blob.x + Math.sin(time * blob.dx + blob.t) * 0.06) * width;
    const cy = (blob.y + Math.cos(time * blob.dy + blob.t) * 0.06) * height;
    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, blob.r);
    gradient.addColorStop(0, `rgba(${blob.hue[0]}, ${blob.hue[1]}, ${blob.hue[2]}, 0.10)`);
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(cx - blob.r, cy - blob.r, blob.r * 2, blob.r * 2);
  }
  rafId = requestAnimationFrame(draw);
}

onMounted(() => {
  if (!canvasEl.value) return;
  ctx = canvasEl.value.getContext('2d');
  resize();
  window.addEventListener('resize', resize);
  if (prefersReducedMotion) {
    draw(0);
  } else {
    rafId = requestAnimationFrame(draw);
  }
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', resize);
  if (rafId) cancelAnimationFrame(rafId);
});
</script>
