import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// In development the Vite dev server proxies API calls to the Node server
// (npm run dev --prefix server, listening on port 3000).
export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/healthz': 'http://127.0.0.1:3000',
    },
  },
});
