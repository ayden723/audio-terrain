// The site is static files, plus one small proxy: the Copernicus GLO-30
// elevation tiles on AWS Open Data send no CORS headers, so the Landscape page
// can't read them directly. /api/cop/<tile>.tif passes a request straight
// through, Range header included (the page reads only the parts of each
// cloud-optimised GeoTIFF it needs). Only tile names are accepted, so this
// can't be used to fetch anything else.

const COP = /^\/api\/cop\/(Copernicus_DSM_COG_10_[NS]\d{2}_00_[EW]\d{3}_00_DEM)\.tif$/;
const UPSTREAM = 'https://copernicus-dem-30m.s3.amazonaws.com';
const PASS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(COP);
    if (!m) return env.ASSETS.fetch(request);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
    }

    const headers = {};
    const range = request.headers.get('range');
    if (range) headers.range = range;
    const up = await fetch(`${UPSTREAM}/${m[1]}/${m[1]}.tif`, { method: request.method, headers });

    // S3 says 403 for a key that doesn't exist; to the page that's just open ocean
    if (up.status === 403 || up.status === 404) return new Response(null, { status: 404 });

    const out = new Headers();
    for (const h of PASS) {
      const v = up.headers.get(h);
      if (v) out.set(h, v);
    }
    // the tiles never change
    out.set('cache-control', 'public, max-age=2592000, immutable');
    return new Response(up.body, { status: up.status, headers: out });
  },
};
