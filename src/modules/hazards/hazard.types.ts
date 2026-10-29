export type HazardLayer = "fire" | "air" | "flood";
export type HazardLayerStatus = "ready" | "stale" | "unavailable";

export type HazardGeometry =
  | { type: "Point"; coordinates: [number, number] }
  | { type: "Polygon"; coordinates: [number, number][][] }
  | { type: "MultiPolygon"; coordinates: [number, number][][][] };

export interface HazardProperties {
  label: string;
  observed_at: string | null;
  plot_ids: string[];
  aqi?: number | null;
  pm25?: number | null;
  detail?: string;
}

export interface HazardFeature {
  type: "Feature";
  id: string;
  geometry: HazardGeometry;
  properties: HazardProperties;
}

export interface HazardFeatureCollection {
  type: "FeatureCollection";
  features: HazardFeature[];
  source: string;
  source_url: string;
  status: HazardLayerStatus;
  fetched_at: string | null;
  checked_at: string | null;
  error: string | null;
}

export interface AirForecastCache {
  run: number;
  fetched_at: string;
  samples: {
    coordinates: [number, number];
    times: number[];
    aqi: (number | null)[];
    pm25: (number | null)[];
  }[];
}
