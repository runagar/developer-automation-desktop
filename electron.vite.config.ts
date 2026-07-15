import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['nanoid'] })],
    build: {
      sourcemap: true,
      rollupOptions: {
        external: ['better-sqlite3', 'node-pty'],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['nanoid'] })],
    build: {
      sourcemap: true,
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      sourcemap: true,
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
    plugins: [react()],
  },
});
