// Elevation in metres for a Web Mercator box, as a rows x cols Float32Array
// (row 0 = north). The grid is square in Mercator, the same projection the map
// is drawn in, so it lines up with the map frame cell for cell.
//
// Sources:
// - USGS 3DEP: 1 m lidar to 10 m, US only. Read straight from the USGS image
//   service as 32-bit floats. Outside its coverage it returns 0, not no-data.
// - Copernicus GLO-30: 30 m, worldwide. Cloud-optimised GeoTIFFs, 1 x 1 degree,
//   on AWS Open Data. They send no CORS headers, so they come through our own
//   Worker (worker/index.js; the Vite dev server proxies the same path).

import { fromArrayBuffer, fromUrl } from 'geotiff';

const R_EARTH = 6378137;
const DEG = Math.PI / 180;

export const mercToLon = (x) => (x / R_EARTH) / DEG;
export const mercToLat = (y) => Math.atan(Math.sinh(y / R_EARTH)) / DEG;
export const lonToMerc = (lon) => lon * DEG * R_EARTH;
export const latToMerc = (lat) => R_EARTH * Math.log(Math.tan(Math.PI / 4 + (lat * DEG) / 2));

/** Ground metres per grid cell on a given row (Mercator stretches by 1/cos(lat)). */
export function cellMetres(box, rows, y) {
  const ym = box.maxY - ((y + 0.5) / rows) * (box.maxY - box.minY);
  return ((box.maxY - box.minY) / rows) * Math.cos(mercToLat(ym) * DEG);
}

// Rough boxes around 3DEP coverage: CONUS, Alaska, Hawaii, Puerto Rico.
const US = [
  [-125.0, 24.4, -66.9, 49.4],
  [-170.0, 51.0, -129.9, 71.5],
  [-160.6, 18.8, -154.7, 22.3],
  [-67.3, 17.8, -65.2, 18.6],
];
export function inUS(lon, lat) {
  return US.some(([a, b, c, d]) => lon >= a && lon <= c && lat >= b && lat <= d);
}

/* ------------------------------------------------------------- 3DEP --- */

const TDEP = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage';

async function fetch3dep(box, rows, cols, signal) {
  const q = new URLSearchParams({
    bbox: [box.minX, box.minY, box.maxX, box.maxY].join(','),
    bboxSR: '3857',
    imageSR: '3857',
    size: `${cols},${rows}`,
    format: 'tiff',
    pixelType: 'F32',
    interpolation: 'RSP_BilinearInterpolation',
    f: 'image',
  });
  const res = await fetch(`${TDEP}?${q}`, { signal });
  if (!res.ok) throw new Error(`USGS 3DEP answered ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (!type.includes('tiff')) throw new Error('USGS 3DEP did not return elevation data');
  const tiff = await fromArrayBuffer(await res.arrayBuffer());
  const img = await tiff.getImage();
  if (img.getWidth() !== cols || img.getHeight() !== rows) {
    throw new Error(`USGS 3DEP returned ${img.getWidth()}x${img.getHeight()}, expected ${cols}x${rows}`);
  }
  const [band] = await img.readRasters();
  const out = new Float32Array(rows * cols);
  for (let i = 0; i < out.length; i++) out[i] = Number.isFinite(band[i]) && band[i] > -1e4 ? band[i] : 0;
  return out;
}

/* -------------------------------------------------------- Copernicus --- */

const copName = (lat, lon) => {
  const ns = lat < 0 ? 'S' : 'N';
  const ew = lon < 0 ? 'W' : 'E';
  const la = String(Math.abs(lat)).padStart(2, '0');
  const lo = String(Math.abs(lon)).padStart(3, '0');
  return `Copernicus_DSM_COG_10_${ns}${la}_00_${ew}${lo}_00_DEM`;
};

/**
 * One tile, read at the coarsest overview that is still at least as fine as
 * the grid, and only the window the box needs.
 */
async function copTile(lat, lon, box, cellDeg, signal) {
  const url = `/api/cop/${copName(lat, lon)}.tif`;
  // geotiff's own errors don't say why, so ask first: no tile means open ocean
  const head = await fetch(url, { method: 'HEAD', signal });
  if (head.status === 404) return null;
  if (!head.ok) throw new Error(`Copernicus tile ${copName(lat, lon)} answered ${head.status}`);
  const tiff = await fromUrl(url, { signal });
  const count = await tiff.getImageCount();
  const full = await tiff.getImage(0);
  const fullRes = 1 / full.getHeight();
  let img = full;
  // cells are sampled 2x2, so read at least twice as fine as the grid
  for (let i = 1; i < count; i++) {
    const o = await tiff.getImage(i);
    if (fullRes * (full.getHeight() / o.getHeight()) <= cellDeg / 2) img = o;
  }
  const w = img.getWidth();
  const h = img.getHeight();
  // Copernicus is point-registered: full-resolution pixel (0,0) is centred on
  // the tile's north-west corner and the tile stops one pixel short of its
  // south and east edges (those belong to the next tile). An overview pixel
  // covers s x s of those, so its centre sits (s - 1) / 2 of them further in.
  const point = full.getGeoKeys().GTRasterTypeGeoKey === 2;
  const dx = 1 / w;
  const dy = 1 / h;
  const off = point ? 0.5 - 0.5 * (w / full.getWidth()) : 0.5;
  const west = mercToLon(box.minX);
  const east = mercToLon(box.maxX);
  const south = mercToLat(box.minY);
  const north = mercToLat(box.maxY);
  const x0 = Math.max(0, Math.floor((west - lon) / dx - off) - 1);
  const x1 = Math.min(w, Math.ceil((east - lon) / dx - off) + 2);
  const y0 = Math.max(0, Math.floor((lat + 1 - north) / dy - off) - 1);
  const y1 = Math.min(h, Math.ceil((lat + 1 - south) / dy - off) + 2);
  if (x1 <= x0 || y1 <= y0) return null;
  const [data] = await img.readRasters({ window: [x0, y0, x1, y1], signal });
  return { lat, lon, dx, dy, off, x0, y0, ww: x1 - x0, wh: y1 - y0, data };
}

// Catmull-Rom weights for the four samples around fraction u.
function cubic(u, w) {
  const u2 = u * u;
  const u3 = u2 * u;
  w[0] = -0.5 * u3 + u2 - 0.5 * u;
  w[1] = 1.5 * u3 - 2.5 * u2 + 1;
  w[2] = -1.5 * u3 + 2 * u2 + 0.5 * u;
  w[3] = 0.5 * u3 - 0.5 * u2;
}
const wx = new Float64Array(4);
const wy = new Float64Array(4);

/**
 * Smooth (bicubic) interpolation between source pixels, so a grid finer than
 * the data doesn't show the facets straight-line interpolation leaves in the
 * hillshading. Clamped to the four nearest samples: it never invents a peak
 * or a pit the data doesn't have.
 */
function sampleTile(t, lat, lon) {
  const fx = Math.min(t.ww - 1, Math.max(0, (lon - t.lon) / t.dx - t.off - t.x0));
  const fy = Math.min(t.wh - 1, Math.max(0, (t.lat + 1 - lat) / t.dy - t.off - t.y0));
  const ix = Math.min(t.ww - 2, Math.floor(fx));
  const iy = Math.min(t.wh - 2, Math.floor(fy));
  if (ix < 0 || iy < 0) return t.data[0];
  const d = t.data;
  const at = (x, y) => d[Math.min(t.wh - 1, Math.max(0, y)) * t.ww + Math.min(t.ww - 1, Math.max(0, x))];
  cubic(fx - ix, wx);
  cubic(fy - iy, wy);
  let v = 0;
  for (let j = 0; j < 4; j++) {
    let row = 0;
    for (let i = 0; i < 4; i++) row += wx[i] * at(ix - 1 + i, iy - 1 + j);
    v += wy[j] * row;
  }
  const a = at(ix, iy);
  const b = at(ix + 1, iy);
  const c = at(ix, iy + 1);
  const e = at(ix + 1, iy + 1);
  return Math.min(Math.max(a, b, c, e), Math.max(Math.min(a, b, c, e), v));
}

async function fetchCopernicus(box, rows, cols, signal, onProgress) {
  const west = mercToLon(box.minX);
  const east = mercToLon(box.maxX);
  const south = mercToLat(box.minY);
  const north = mercToLat(box.maxY);
  // grid spacing in degrees of latitude at the middle of the box
  const cellDeg = (north - south) / rows;
  const jobs = [];
  for (let la = Math.floor(south); la <= Math.floor(north - 1e-12); la++) {
    for (let lo = Math.floor(west); lo <= Math.floor(east - 1e-12); lo++) jobs.push([la, lo]);
  }
  if (jobs.length > 16) throw new Error('Area too large for Copernicus (more than 16 one-degree tiles). Zoom in.');
  let done = 0;
  const tiles = await Promise.all(
    jobs.map(([la, lo]) =>
      copTile(la, lo, box, cellDeg, signal).then((t) => {
        onProgress?.(++done / jobs.length);
        return t;
      })
    )
  );
  const byKey = new Map();
  jobs.forEach(([la, lo], i) => byKey.set(`${la},${lo}`, tiles[i]));

  // 2x2 supersampling per cell keeps detail finer than the grid from aliasing
  const out = new Float32Array(rows * cols);
  const sx = (box.maxX - box.minX) / cols;
  const sy = (box.maxY - box.minY) / rows;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let sum = 0;
      for (let s = 0; s < 4; s++) {
        const mx = box.minX + (x + 0.25 + 0.5 * (s & 1)) * sx;
        const my = box.maxY - (y + 0.25 + 0.5 * (s >> 1)) * sy;
        const lat = mercToLat(my);
        const lon = mercToLon(mx);
        const t = byKey.get(`${Math.floor(lat)},${Math.floor(lon)}`);
        sum += t ? sampleTile(t, lat, lon) : 0;
      }
      out[y * cols + x] = sum / 4;
    }
  }
  return out;
}

/* ------------------------------------------------------------- entry --- */

/**
 * source: 'auto' | '3dep' | 'copernicus'. Returns { heights, source, label }.
 * Auto uses 3DEP inside the US and fills anything it leaves at exactly 0 (its
 * answer for "outside coverage") from Copernicus, so borders stay seamless.
 */
export async function loadDem(box, rows, cols, source, { signal, onStatus } = {}) {
  const lon = mercToLon((box.minX + box.maxX) / 2);
  const lat = mercToLat((box.minY + box.maxY) / 2);
  const use3dep = source === '3dep' || (source === 'auto' && inUS(lon, lat));

  if (!use3dep) {
    onStatus?.('Reading Copernicus GLO-30…');
    const heights = await fetchCopernicus(box, rows, cols, signal, (f) => onStatus?.(`Reading Copernicus GLO-30… ${Math.round(f * 100)}%`));
    return { heights, source: 'copernicus', label: 'Copernicus GLO-30 (30 m)' };
  }

  onStatus?.('Reading USGS 3DEP…');
  const heights = await fetch3dep(box, rows, cols, signal);
  if (source === '3dep') return { heights, source: '3dep', label: 'USGS 3DEP' };

  let zeros = 0;
  for (let i = 0; i < heights.length; i++) if (heights[i] === 0) zeros++;
  if (zeros / heights.length < 0.002) return { heights, source: '3dep', label: 'USGS 3DEP' };

  onStatus?.('Filling gaps from Copernicus GLO-30…');
  const cop = await fetchCopernicus(box, rows, cols, signal);
  let filled = 0;
  for (let i = 0; i < heights.length; i++) {
    if (heights[i] === 0 && Math.abs(cop[i]) > 0.5) {
      heights[i] = cop[i];
      filled++;
    }
  }
  const label = filled ? 'USGS 3DEP + Copernicus GLO-30' : 'USGS 3DEP';
  return { heights, source: filled ? 'mixed' : '3dep', label };
}
