# BLO Livability Index - National Map

An interactive choropleth mapping tool built for the [Black Livability Observatory](https://blacklandownership.org/) that helps Black Americans identify favorable counties for living, working, and building wealth across the United States.

## Tech Stack

- **Vue 3** + TypeScript + Vite
- **Mapbox GL JS** for interactive map rendering
- **PapaParse** for CSV data loading
- Deployed on **Netlify**

## Data Layers

The map visualizes county-level data across seven categories:

| Category | Source(s) | Examples |
|----------|-----------|----------|
| Demographics | US Census, IHME | Diversity index, % Black population, life expectancy |
| Economic | Census, BLS | Median income by race, average weekly wages |
| Housing | Census | Median home value, property taxes |
| Equity | Census, Urban Institute, Brookings | Poverty by race, homeownership by race, Black Progress Index |
| Environment | EPA | Superfund sites, toxic releases, brownfields, air pollution |
| Transportation | BWDC | Commute times, transit mode share |
| Computed | BLO | Composite livability score (v2) |

See [DATA_SOURCES.md](DATA_SOURCES.md) for full attribution, file mappings, and data pipeline details.

## Development

```sh
npm install
npm run dev          # Start dev server
npm run build        # Production build
npm run type-check   # TypeScript validation
npm run lint         # ESLint
```

### Data Pipeline

Raw data lives in `source-data/` (gitignored). Preprocessing scripts in `scripts/` transform it into web-ready CSV/JSON in `public/datasets/`, keyed by 5-digit FIPS GEOID codes.

```
source-data/  -->  scripts/  -->  public/datasets/
```

### Project Structure

```
src/
  components/     Map.vue (main), LayerControls, ColorLegend, CountyModal
  composables/    useMapData, useColorCalculation, usePropertyListings
  config/         layerConfig, constants, datasetMetadata, stateFips
  types/          mapTypes.ts
  views/          HomeView, AboutView
```

## Deployment

Hosted on Netlify. Pushes to `main` trigger automatic builds via `npm run build` with `dist/` as the publish directory.
