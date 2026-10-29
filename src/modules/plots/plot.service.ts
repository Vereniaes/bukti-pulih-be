// Todo:
// -> Filter restoration plots and format their GeoJSON and detail responses.

// --- Plot queries ---
import mongoose from "mongoose";
import { PlotModel } from "./plot.model.js";

interface GetPlotsQuery {
  region?: string;
  status?: string;
  bbox?: string;
}

// Purpose: Apply plot filters and format matching records as GeoJSON.
// Input: Region, status, and optional west/south/east/north bounds.
// Output: Feature collection.
export const getPlotsGeoJsonService = async (query: GetPlotsQuery) => {
  const filter: Record<string, unknown> = {};

  if (query.region && query.region !== "all") {
    filter.region = { $regex: query.region, $options: "i" };
  }

  if (query.status && query.status !== "all") {
    filter.latest_status = query.status;
  }

  if (query.bbox) {
    const coords = query.bbox.split(",").map(Number);
    if (coords.length === 4 && !coords.some(isNaN)) {
      const [minLng, minLat, maxLng, maxLat] = coords;
      filter.location = {
        $geoWithin: {
          $box: [
            [minLng, minLat],
            [maxLng, maxLat],
          ],
        },
      };
    }
  }

  const plots = await PlotModel.find(filter).sort({ survival_rate: -1 });

  const features = plots.map((p) => ({
    type: "Feature",
    id: p._id.toString(),
    geometry: {
      type: "Point",
      coordinates: p.location.coordinates,
    },
    properties: {
      plot_code: p.plot_code,
      name: p.name,
      region: p.region,
      ecosystem_type: p.ecosystem_type,
      community_name: p.community_name,
      coordinator_name: p.coordinator_name,
      total_planted: p.total_planted,
      current_alive: p.current_alive,
      survival_rate: p.survival_rate,
      latest_status: p.latest_status,
      last_monitored_at: p.last_monitored_at.toISOString(),
      cover_image_url: p.cover_image_url,
    },
  }));

  return {
    type: "FeatureCollection",
    features,
  };
};

export const getPlotSummaryService = async (id: string) => {
  const isObjectId = mongoose.isValidObjectId(id);
  const plot = isObjectId
    ? await PlotModel.findById(id)
    : await PlotModel.findOne({ plot_code: id });

  if (!plot) return null;

  return {
    id: plot._id.toString(),
    plot_code: plot.plot_code,
    name: plot.name,
    region: plot.region,
    ecosystem_type: plot.ecosystem_type,
    area_hectares: plot.area_hectares,
    community_name: plot.community_name,
    coordinator: {
      name: plot.coordinator_name,
      phone_contact: plot.coordinator_phone || "0812-xxxx-xxxx",
      is_verified: true,
    },
    planting_timeline: {
      initial_planting_date: plot.initial_planting_date.toISOString(),
      last_monitored_at: plot.last_monitored_at.toISOString(),
    },
    tree_metrics: {
      total_planted: plot.total_planted,
      current_alive: plot.current_alive,
      dead_count: Math.max(0, plot.total_planted - plot.current_alive),
      survival_rate: plot.survival_rate,
      status: plot.latest_status,
    },
  };
};
// --- end of Plot queries ---
