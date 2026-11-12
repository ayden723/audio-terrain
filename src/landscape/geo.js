// Web Mercator arithmetic. Kept free of imports so the sound worker can use it
// without pulling in the elevation readers.

const R_EARTH = 6378137;
export const DEG = Math.PI / 180;

export const mercToLon = (x) => (x / R_EARTH) / DEG;
export const mercToLat = (y) => Math.atan(Math.sinh(y / R_EARTH)) / DEG;
export const lonToMerc = (lon) => lon * DEG * R_EARTH;
export const latToMerc = (lat) => R_EARTH * Math.log(Math.tan(Math.PI / 4 + (lat * DEG) / 2));

/** Ground metres per grid cell on a given row (Mercator stretches by 1/cos(lat)). */
export function cellMetres(box, rows, y) {
  const ym = box.maxY - ((y + 0.5) / rows) * (box.maxY - box.minY);
  return ((box.maxY - box.minY) / rows) * Math.cos(mercToLat(ym) * DEG);
}
