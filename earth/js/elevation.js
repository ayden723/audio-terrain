/* ============================================================
   elevation.js — fetch real elevation for a map view
   ------------------------------------------------------------
   The AWS Open Data "terrarium" tiles are ordinary PNG map tiles
   where the COLOR of each pixel encodes the height of the ground:

     meters = (R * 256 + G + B / 256) - 32768

   Plan:
     1. Work out which tiles cover the map view (Web Mercator math).
     2. Fetch them and assemble onto one canvas.
     3. Read the pixels, decode every one to meters.
     4. Box-average down to a small grid (cols × rows) that the
        sonifier and the preview can use directly.
   ============================================================ */

const TILE_URL = z_x_y =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z_x_y}.png`;

const TILE = 256;          // terrarium tiles are 256×256
const MAX_TILES = 20;      // don't hammer the free service
const MAX_DATA_ZOOM = 14;  // finest useful terrarium level for regions

/* ---- Web Mercator: lon/lat → world pixel coords at zoom z ---- */
function lonToPx(lon, z) {
  return ((lon + 180) / 360) * TILE * Math.pow(2, z);
}
function latToPx(lat, z) {
  const clamped = Math.max(-85.0511, Math.min(85.0511, lat));
  const rad = (clamped * Math.PI) / 180;
  const merc = Math.log(Math.tan(rad) + 1 / Math.cos(rad));
  return ((1 - merc / Math.PI) / 2) * TILE * Math.pow(2, z);
}

/** Load one tile image (CORS-enabled). Failures resolve to null so a
    single missing tile doesn't sink the whole scan. */
function loadTile(z, x, y) {
  return new Promise(resolve => {
    const worldTiles = Math.pow(2, z);
    const wrappedX = ((x % worldTiles) + worldTiles) % worldTiles; // date line
    if (y < 0 || y >= worldTiles) { resolve(null); return; }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = TILE_URL(`${z}/${wrappedX}/${y}`);
  });
}

/**
 * Scan a Leaflet map's current view into an elevation grid.
 * @param {L.Map} map
 * @param {number} cols  time steps (west → east)
 * @param {number} rows  pitch steps (north → south)
 * @param {function} onProgress  optional status callback (string)
 * @returns {Promise<{grid: Float32Array, cols, rows, minElev, maxElev}>}
 *          grid[r * cols + c] = meters; row 0 is the NORTH edge.
 */
export async function scanView(map, cols, rows, onProgress = () => {}) {
  const bounds = map.getBounds();
  const west = bounds.getWest(), east = bounds.getEast();
  const north = bounds.getNorth(), south = bounds.getSouth();

  // Pick the finest data zoom that stays under the tile budget.
  let z = Math.min(Math.round(map.getZoom()), MAX_DATA_ZOOM);
  const tileSpan = zz => {
    const x0 = Math.floor(lonToPx(west, zz) / TILE);
    const x1 = Math.floor(lonToPx(east, zz) / TILE);
    const y0 = Math.floor(latToPx(north, zz) / TILE);
    const y1 = Math.floor(latToPx(south, zz) / TILE);
    return { x0, x1, y0, y1, count: (x1 - x0 + 1) * (y1 - y0 + 1) };
  };
  while (z > 0 && tileSpan(z).count > MAX_TILES) z--;
  const { x0, x1, y0, y1, count } = tileSpan(z);

  // Fetch all tiles in parallel and assemble them on one canvas.
  onProgress(`Fetching ${count} elevation tile${count > 1 ? 's' : ''}…`);
  const jobs = [];
  for (let ty = y0; ty <= y1; ty++)
    for (let tx = x0; tx <= x1; tx++)
      jobs.push(loadTile(z, tx, ty).then(img => ({ img, tx, ty })));
  const tiles = await Promise.all(jobs);

  const sheetW = (x1 - x0 + 1) * TILE;
  const sheetH = (y1 - y0 + 1) * TILE;
  const sheet = document.createElement('canvas');
  sheet.width = sheetW;
  sheet.height = sheetH;
  const sctx = sheet.getContext('2d', { willReadFrequently: true });
  // Sea level in terrarium encoding: R=128, G=0, B=0 → exactly 0 m.
  // Missing tiles (open ocean at high zoom) read as sea level.
  sctx.fillStyle = 'rgb(128,0,0)';
  sctx.fillRect(0, 0, sheetW, sheetH);
  for (const { img, tx, ty } of tiles) {
    if (img) sctx.drawImage(img, (tx - x0) * TILE, (ty - y0) * TILE);
  }

  // Crop to the exact pixel box of the visible map bounds.
  onProgress('Decoding heights…');
  const cropX = Math.round(lonToPx(west, z) - x0 * TILE);
  const cropY = Math.round(latToPx(north, z) - y0 * TILE);
  const cropW = Math.max(2, Math.round(lonToPx(east, z) - lonToPx(west, z)));
  const cropH = Math.max(2, Math.round(latToPx(south, z) - latToPx(north, z)));
  const px = sctx.getImageData(cropX, cropY, cropW, cropH).data;

  // Decode every pixel to meters.
  const meters = new Float32Array(cropW * cropH);
  for (let i = 0; i < meters.length; i++) {
    const p = i * 4;
    meters[i] = px[p] * 256 + px[p + 1] + px[p + 2] / 256 - 32768;
  }

  // Box-average down to the working grid. (Decode first, THEN average:
  // averaging the raw RGB would corrupt the encoding.)
  const grid = new Float32Array(cols * rows);
  let minElev = Infinity, maxElev = -Infinity;
  for (let r = 0; r < rows; r++) {
    const sy0 = Math.floor((r / rows) * cropH);
    const sy1 = Math.max(sy0 + 1, Math.floor(((r + 1) / rows) * cropH));
    for (let c = 0; c < cols; c++) {
      const sx0 = Math.floor((c / cols) * cropW);
      const sx1 = Math.max(sx0 + 1, Math.floor(((c + 1) / cols) * cropW));
      let sum = 0, n = 0;
      for (let y = sy0; y < sy1; y++)
        for (let x = sx0; x < sx1; x++) { sum += meters[y * cropW + x]; n++; }
      const v = sum / n;
      grid[r * cols + c] = v;
      if (v < minElev) minElev = v;
      if (v > maxElev) maxElev = v;
    }
  }

  return { grid, cols, rows, minElev, maxElev };
}
