import { defineConfig } from 'vite';

// Stands in for worker/index.js locally: Copernicus elevation tiles under
// /api/cop/<tile>.tif, fetched from AWS Open Data. S3 says 403 for a tile that
// doesn't exist (open ocean); the Worker turns that into 404, and so does this.
const copernicus = {
  '/api/cop': {
    target: 'https://copernicus-dem-30m.s3.amazonaws.com',
    changeOrigin: true,
    rewrite: (p) => p.replace(/^\/api\/cop\/(Copernicus_DSM_COG_10_\w+_DEM)\.tif$/, '/$1/$1.tif'),
    configure: (proxy) => {
      proxy.on('proxyRes', (res) => { if (res.statusCode === 403) res.statusCode = 404; });
    },
  },
};

// The harness assigns a port via PORT; with none set the dev server uses this
// project's own port rather than Vite's shared default.
export default defineConfig({
  server: {
    port: Number(process.env.PORT) || 5184,
    open: false,
    proxy: copernicus,
  },
  preview: {
    port: process.env.PORT ? Number(process.env.PORT) : undefined,
    proxy: copernicus,
  },
  build: {
    // The home page at /, and one page per tool beside it.
    rolldownOptions: {
      input: {
        home: 'index.html',
        terrain: 'terrain/index.html',
        landscape: 'landscape/index.html',
      },
    },
  },
  worker: { format: 'es' },
});
