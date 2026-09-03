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
    server: {
      // The renderer's origin in dev is this dev-server URL, and Chromium
      // partitions localStorage per origin. Vite's default behaviour is to
      // fall back to the next free port when 5173 is taken, which silently
      // moves the app to a different origin — it then boots against an empty
      // store and every localStorage-backed preference (theme, CRT toggles,
      // zoom, panel layout) reads as its default, looking like the settings
      // were wiped. Refusing to start is the safer outcome: a busy port means
      // a dev instance is already running, and two instances would also
      // contend for the same SQLite database and tmux sessions.
      port: 5173,
      strictPort: true,
    },
    build: {
      sourcemap: true,
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
    plugins: [react()],
  },
});
