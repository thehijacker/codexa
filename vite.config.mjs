import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir:     'public/js',
    emptyOutDir: false,
    sourcemap:   true,
    rollupOptions: {
      input: 'src/reader_v3/main.jsx',
      output: {
        entryFileNames: 'reader_v3.js',
        chunkFileNames: 'reader_v3_[hash].js',
        assetFileNames: 'reader_v3[extname]',
      },
    },
  },
});
