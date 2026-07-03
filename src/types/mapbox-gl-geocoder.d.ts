/**
 * Minimal ambient declaration for @mapbox/mapbox-gl-geocoder, which ships no
 * types of its own. The DefinitelyTyped package
 * (@types/mapbox__mapbox-gl-geocoder) pins the legacy @types/mapbox-gl (v1/v2)
 * typings, which conflict with the types bundled in mapbox-gl v3 — so we
 * declare the module locally instead. Declared as a loosely-typed class so it
 * works both as a value (`new MapboxGeocoder(...)`) and as a type annotation.
 */
declare module '@mapbox/mapbox-gl-geocoder' {
  class MapboxGeocoder {
    constructor(options?: any)
    [key: string]: any
  }
  export default MapboxGeocoder
}
