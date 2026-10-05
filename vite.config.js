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

// The harness assigns a port via PORT; with none set Vite picks its own default
// and steps to the next free one if that is taken.
export default defineConfig({
  plugins: [hideTools],
  server: {
    port: process.env.PORT ? Number(process.env.PORT) : undefined,
    open: false,
  },
  preview: {
    port: process.env.PORT ? Number(process.env.PORT) : undefined,
  },
  build: {
    // The home page at /, and one page per tool beside it.
    rolldownOptions: {
      input: {
        home: 'index.html',
        terrain: 'terrain/index.html',
        ...(SHOW_RIPPLES ? { ripples: 'ripples/index.html' } : {}),
      },
    },
  },
  worker: { format: 'es' },
});
