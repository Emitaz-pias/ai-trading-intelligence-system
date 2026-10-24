import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('lightweight-charts')) return 'charts';
          if (id.includes('/@mui/') || id.includes('/@emotion/')) return 'ui';
          if (id.includes('/react-router-dom/') || id.includes('/react-dom/') || id.includes('/scheduler/') || id.includes('/react/')) return 'framework';
          return undefined;
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:4000',
      '/ws': { target: 'ws://localhost:4000', ws: true },
    },
  },
});
