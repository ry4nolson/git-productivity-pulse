import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Project pages live under /<repo>/ on github.io; dev/preview stay at root.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/git-productivity-pulse/' : '/',
  plugins: [react(), tailwindcss()],
}));
