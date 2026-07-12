import 'vuetify/styles';
import '@mdi/font/css/materialdesignicons.css';
import { createVuetify } from 'vuetify';

export default createVuetify({
  theme: {
    defaultTheme: 'autotraderDark',
    themes: {
      autotraderDark: {
        dark: true,
        colors: {
          background: '#0b111c',
          surface: '#121b2a',
          primary: '#27d7ff',
          secondary: '#8a5cff',
          error: '#ff3d81',
          warning: '#ffc857',
          success: '#2ee59d',
        },
      },
    },
  },
  defaults: {
    VCard: { rounded: 'xl' },
    VBtn: { rounded: 'lg' },
  },
});
