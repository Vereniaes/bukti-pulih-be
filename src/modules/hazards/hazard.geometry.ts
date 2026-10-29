// Match plot coordinates to reported areas; no impact radius is invented.
import type { HazardFeature, HazardGeometry } from "./hazard.types.js";
type Coordinate = [number, number];
export interface PlotCoordinate { plot_code: string; location: { coordinates: number[] }; }

function inRing([x, y]: Coordinate, ring: Coordinate[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    const cross = (x - xi) * (yj - yi) - (y - yi) * (xj - xi);
    if (Math.abs(cross) < 1e-10 && x >= Math.min(xi, xj) && x <= Math.max(xi, xj) && y >= Math.min(yi, yj) && y <= Math.max(yi, yj)) return true;
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function containsCoordinate(geometry: HazardGeometry, coordinate: Coordinate): boolean {
  if (geometry.type === "Point") return geometry.coordinates.every((v, i) => Math.abs(v - coordinate[i]) < 1e-8);
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons.some(rings => inRing(coordinate, rings[0]) && !rings.slice(1).some(hole => inRing(coordinate, hole)));
}
export function matchPlots(features: HazardFeature[], plots: PlotCoordinate[]): HazardFeature[] {
  return features.map(feature => ({ ...feature, properties: { ...feature.properties,
    plot_ids: plots.filter(plot => plot.location.coordinates.length === 2 && containsCoordinate(feature.geometry, plot.location.coordinates as Coordinate)).map(plot => plot.plot_code),
  } }));
}
