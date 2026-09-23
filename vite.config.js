import { defineConfig } from 'vite';

// The harness assigns a port via PORT; with none set Vite picks its own default
// and steps to the next free one if that is taken.
export default defineConfig({
  server: {
    port: process.env.PORT ? Number(process.env.PORT) : undefined,
    open: false,
  },
  preview: {
    port: process.env.PORT ? Number(process.env.PORT) : undefined,
  },
  build: {
    // The home page at /, the spectrogram at /terrain/ and test pages beside them.
    rolldownOptions: {
      input: {
        home: 'index.html',
        terrain: 'terrain/index.html',
        caustics: 'caustics/index.html', // test page, not linked from home yet
      },
    },
  },
  worker: { format: 'es' },
});
