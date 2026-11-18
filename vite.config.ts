import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
export default defineConfig({
  plugins: [vue()],
  build: { outDir: 'dist/client' },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000' },
      '/socket.io': { target: 'http://127.0.0.1:3000', ws: true },
    },
  },
});
