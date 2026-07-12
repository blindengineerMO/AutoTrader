/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        void: '#0b111c',
        panel: '#121b2a',
        accent: {
          DEFAULT: '#27d7ff',
          dim: '#0c8dff',
        },
        danger: '#ff3d81',
        warn: '#ffc857',
      },
      fontFamily: {
        display: ['"Playfair Display"', 'serif'],
        headline: ['"Space Mono"', 'monospace'],
        body: ['"DM Sans"', '"Inter"', 'sans-serif'],
      },
      backdropBlur: {
        glass: '18px',
      },
      boxShadow: {
        glass: '0 24px 80px rgba(0, 0, 0, 0.52), 0 2px 18px rgba(0, 0, 0, 0.44), inset 0 1px 0 rgba(255,255,255,0.12)',
        glow: '0 0 34px rgba(39, 215, 255, 0.38)',
      },
    },
  },
  // Vuetify ships its own base/reset styles; Tailwind's preflight would
  // fight it (button/input resets, etc.), so we disable preflight and use
  // Tailwind purely as a utility layer on top of Vuetify components.
  corePlugins: {
    preflight: false,
  },
  plugins: [],
};
