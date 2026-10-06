/**
 * The county outline layers a map draws on top of the choropleth (P6-10).
 *
 * Five line layers, all on the `counties` source, all created hidden and
 * driven afterwards by `setFilter` / `visibility`:
 *
 *  - the hover outline, which `MapCanvas` owns (it is part of the choropleth's
 *    hover feedback);
 *  - the set and active outlines and the inspect halo and outline, which the
 *    public map's walkthrough and inspect rail drive (`Map.vue`).
 *
 * They live here rather than in either component because the layers are map
 * plumbing with no state of their own, and because a canvas and the chrome
 * wrapped around it must agree on their ids and their paint without one
 * importing the other.
 *
 * Extracted verbatim from `Map.vue`'s `addWalkthroughOverlayLayers`.
 */

/** The little of a `mapboxgl.Map` this needs — also what makes it testable. */
export interface OverlayMapLike {
  getLayer: (id: string) => unknown
  addLayer: (layer: any) => void
}

export const SET_OUTLINE_LAYER = "walkthrough-set-outline";
export const ACTIVE_OUTLINE_LAYER = "walkthrough-active-outline";
export const HOVER_OUTLINE_LAYER = "county-hover-outline";
// Inspect mode (single county selected via click): a soft halo, a crisp
// green outline, and a fill-opacity drop inside the polygon so the
// underlying Mapbox basemap detail (roads, towns, water) shows through.
export const INSPECT_HALO_LAYER = "inspect-halo";
export const INSPECT_OUTLINE_LAYER = "inspect-outline";

/** Created once per style. Filters update reactively via watchers. */
export function addCountyOverlayLayers(map: OverlayMapLike): void {
  if (map.getLayer(SET_OUTLINE_LAYER)) return;

  // Set outline — all top-N counties get a medium ink-soft border.
  map.addLayer({
    id: SET_OUTLINE_LAYER,
    type: "line",
    source: "counties",
    paint: {
      "line-color": "#2a2a2a",
      "line-width": 1.2,
      "line-opacity": 0.85,
    },
    filter: ["==", ["get", "GEOID"], "__none__"],
    layout: { visibility: "none" },
  });

  // Active outline — single current county gets a heavy ink border on top.
  map.addLayer({
    id: ACTIVE_OUTLINE_LAYER,
    type: "line",
    source: "counties",
    paint: {
      "line-color": "#111111",
      "line-width": 2.8,
      "line-opacity": 1.0,
    },
    filter: ["==", ["get", "GEOID"], "__none__"],
    layout: { visibility: "none" },
  });

  // Phase 4f: hover outline — thin ink line on the county under the cursor.
  // Sits on top of fill but below the heavier active/set outlines.
  map.addLayer({
    id: HOVER_OUTLINE_LAYER,
    type: "line",
    source: "counties",
    paint: {
      "line-color": "#111111",
      "line-width": 1.5,
      "line-opacity": 0.6,
    },
    filter: ["==", ["get", "GEOID"], "__none__"],
    layout: { visibility: "none" },
  });

  // Inspect halo — wide, soft green glow that gives the selected county
  // presence even when the user has zoomed out or is scanning the map.
  map.addLayer({
    id: INSPECT_HALO_LAYER,
    type: "line",
    source: "counties",
    paint: {
      "line-color": "#1f7a2e",
      "line-width": 10,
      "line-opacity": 0.22,
      "line-blur": 4,
    },
    filter: ["==", ["get", "GEOID"], "__none__"],
    layout: { visibility: "none" },
  });

  // Inspect outline — crisp BLO-green border on the selected county.
  // Sits on top of every other line layer so it's never occluded.
  map.addLayer({
    id: INSPECT_OUTLINE_LAYER,
    type: "line",
    source: "counties",
    paint: {
      "line-color": "#1f7a2e",
      "line-width": 3,
      "line-opacity": 1,
    },
    filter: ["==", ["get", "GEOID"], "__none__"],
    layout: { visibility: "none" },
  });
}
