import { defineConfig } from 'vite';

// Ripples is hidden from the site for now. Its files are all still here;
// set this to true to bring back both its page (/ripples/) and its card on
// the home page.
const SHOW_RIPPLES = false;

// Drops whatever index.html marks as belonging to a hidden tool.
const hideTools = {
  name: 'hide-tools',
  transformIndexHtml(html) {
    if (SHOW_RIPPLES) return html;
    return html.replace(/\s*<!-- ripples:start -->[\s\S]*?<!-- ripples:end -->/g, '');
  },
};

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

// The harness assigns a port via PORT; with none set Vite picks its own default
// and steps to the next free one if that is taken.
export default defineConfig({
  plugins: [hideTools],
  server: {
    port: process.env.PORT ? Number(process.env.PORT) : undefined,
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
        ...(SHOW_RIPPLES ? { ripples: 'ripples/index.html' } : {}),
      },
    },
  },
  worker: { format: 'es' },
});
