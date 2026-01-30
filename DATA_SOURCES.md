# BLO Livability Index - Data Sources Documentation

This document maps all source data files to their processed datasets, including data formats, years, and attribution information.

## Quick Reference: Citation Abbreviations

| Abbreviation | Full Name | URL |
|-------------|-----------|-----|
| **BLO** | Black Land Ownership (computed) | - |
| **Census** | US Census Bureau | census.gov |
| **IHME** | Institute for Health Metrics and Evaluation | healthdata.org |
| **EPA** | Environmental Protection Agency | epa.gov/enviro |
| **BLS** | Bureau of Labor Statistics | bls.gov/cew |
| **Urban Institute** | Urban Institute - Diversity Data Kids | diversitydatakids.org |
| **Brookings** | NAACP & Brookings Institution | brookings.edu |
| **BWDC** | Black Worker Data Center | blackworkers.org |

---

## Data Pipeline Overview

```
source-data/          -->  scripts/           -->  public/datasets/
(Raw data files)           (Processing)            (Web-ready data)
```

---

## Demographics

### Diversity Index & Percent Black Population

| Field | Value |
|-------|-------|
| **Source** | US Census Bureau |
| **Year** | 2023 |
| **Source File** | `source-data/census/countyCensus-est2023-alldata.csv` |
| **Processed File** | `public/datasets/demographics/county_diversity_index_with_stats.csv` |
| **Format** | CSV |
| **Records** | 3,145 counties |
| **Key Fields** | GEOID, diversity_index, pct_Black, total_population, CTYNAME, STNAME |
| **Citation** | (Census) |

### Life Expectancy

| Field | Value |
|-------|-------|
| **Source** | Institute for Health Metrics and Evaluation (IHME) |
| **Year** | 2014 |
| **Source File** | External download |
| **Processed File** | `public/datasets/demographics/lifeexpectancy-USA-county.csv` |
| **Format** | CSV |
| **Records** | 3,109 counties |
| **Key Fields** | GEOID, e(0) (life expectancy), se(e(0)) (standard error) |
| **Citation** | (IHME) |

---

## Economic

### Average Weekly Wage

| Field | Value |
|-------|-------|
| **Source** | US Bureau of Labor Statistics (BLS) via BWDC |
| **Year** | 2025 Q1 |
| **Source File** | `source-data/AVG WEEKLY WAGES/emp_09.csv` |
| **Processed File** | `public/datasets/economic/avg_weekly_wages.csv` |
| **Format** | CSV |
| **Records** | 3,135 counties |
| **Key Fields** | GEOID, county_name, state_name, year, avg_weekly_wage |
| **Documentation** | `source-data/AVG WEEKLY WAGES/Read_Me_BWDC.pdf` |
| **Citation** | (BLS) |

### Median Household Income (Black)

| Field | Value |
|-------|-------|
| **Source** | Urban Institute - Diversity Data Kids |
| **Year** | 2022 |
| **Source File** | `source-data/RACIAL PROGRESS/Median Income by Race_Ethnicity/emp_08.csv` |
| **Processed File** | `public/datasets/economic/median_income_by_race.csv` |
| **Format** | CSV |
| **Records** | 3,145 counties |
| **Key Fields** | GEOID, county_name, state_name, year, median_income_black |
| **Citation** | (Urban Institute) |

---

## Housing

### Median Home Value

| Field | Value |
|-------|-------|
| **Source** | Urban Institute - Diversity Data Kids |
| **Year** | 2022 |
| **Source File** | `source-data/MEDIAN VALUE of OWNER OCCUPIED MORTGAGES/hom_06.csv` |
| **Processed File** | `public/datasets/housing/median_home_value.csv` |
| **Format** | CSV |
| **Records** | 3,145 counties |
| **Key Fields** | GEOID, county_name, state_name, year, median_home_value_with_mortgage |
| **Documentation** | `source-data/MEDIAN VALUE of OWNER OCCUPIED MORTGAGES/data-dictionary.xlsx` |
| **Citation** | (Urban Institute) |

### Median Property Tax

| Field | Value |
|-------|-------|
| **Source** | Urban Institute - Diversity Data Kids |
| **Year** | 2022 |
| **Source File** | `source-data/MEDIAN REAL ESTATE TAXES OF OWNER - OCCUPIED MORTGAGES/hom_08.csv` |
| **Processed File** | `public/datasets/housing/median_property_tax.csv` |
| **Format** | CSV |
| **Records** | 3,145 counties |
| **Key Fields** | GEOID, county_name, state_name, year, median_property_tax_with_mortgage |
| **Documentation** | `source-data/MEDIAN REAL ESTATE TAXES OF OWNER - OCCUPIED MORTGAGES/data-dictionary.xlsx` |
| **Citation** | (Urban Institute) |

---

## Equity

### Black Homeownership Rate

| Field | Value |
|-------|-------|
| **Source** | Urban Institute - Diversity Data Kids via BWDC |
| **Year** | 2023 |
| **Source File** | `source-data/RACIAL PROGRESS/Homeownership Rate by Race_Ethnicity/adt_06.csv` |
| **Processed File** | `public/datasets/equity/homeownership_by_race.csv` |
| **Format** | CSV |
| **Records** | 3,145 counties |
| **Key Fields** | GEOID, county_name, state_name, year, homeownership_rate_black |
| **Note** | Only includes counties with 50+ Black residents for statistical reliability |
| **Citation** | (Urban Institute) |

### Poverty Rate (Black)

| Field | Value |
|-------|-------|
| **Source** | Urban Institute - Diversity Data Kids via BWDC |
| **Year** | 2023 |
| **Source File** | `source-data/RACIAL PROGRESS/Percent Poverty (by Race_Ethnicity)/adt_04.csv` |
| **Processed File** | `public/datasets/equity/poverty_by_race.csv` |
| **Format** | CSV |
| **Records** | 3,145 counties |
| **Key Fields** | GEOID, county_name, state_name, year, poverty_rate_black |
| **Citation** | (Urban Institute) |

### Black Progress Index

| Field | Value |
|-------|-------|
| **Source** | NAACP & Brookings Institution |
| **Year** | 2020 |
| **Source File** | `source-data/RACIAL PROGRESS/The Black Progress Index (NAACPxBrookings)/County_Level_Black_Progress_Index.csv` |
| **Processed File** | `public/datasets/equity/black_progress_index.csv` |
| **Format** | CSV |
| **Records** | 1,678 counties (limited to counties with sufficient Black population) |
| **Key Fields** | GEOID, county_name, state, black_progress_index |
| **Methodology** | Combines 8 indicators: life expectancy, low birth weight, math proficiency, bachelor's degree, homeownership, business ownership, median income, Black population % |
| **Citation** | (Brookings) |

---

## Environment

### EPA Contamination Sites

| Field | Value |
|-------|-------|
| **Source** | Environmental Protection Agency (EPA) Envirofacts |
| **Year** | 2024 |
| **Source Files** | Downloaded from EPA Envirofacts API |
| **Processed Files** | `public/datasets/epa-contamination/*.geojson`, `contamination_counts.json` |
| **Format** | GeoJSON (point data), JSON (counts) |
| **Categories** | Superfund (NPL), Hazardous Waste (RCRA), Toxic Release Inventory (TRI), Brownfields, Air Pollution Sources |
| **Total Size** | ~47 MB |
| **Citation** | (EPA) |

#### Individual Layer Files:
- `acres_brownfields.geojson` (5.3 MB)
- `air_pollution_sources.geojson` (5.2 MB)
- `hazardous_waste_sites.geojson` (5.2 MB)
- `superfund_sites.geojson` (1.9 MB)
- `toxic_release_inventory.geojson` (5.3 MB)
- `contamination_counts.json` (aggregated county counts)

---

## Transportation

### Commute Times & Transportation Mode

| Field | Value |
|-------|-------|
| **Source** | Black Worker Data Center (BWDC) |
| **Year** | 2023 |
| **Source File** | `source-data/commute-times/emp_06.csv` |
| **Processed File** | `public/datasets/transportation/commute_times.csv` |
| **Processing Script** | `scripts/preprocess_commute_times.py` |
| **Format** | CSV |
| **Records** | 3,130 counties (99.5% match rate) |
| **Key Fields** | GEOID, county_name, state_name, year, most_frequent_commute_time, commute_time_ordinal, pct_drove_alone, pct_carpooled, pct_public_transit, pct_black |
| **Documentation** | `source-data/commute-times/Read_Me_BWDC.pdf`, `data-dictionary.xlsx` |
| **Citation** | (BWDC) |

#### Commute Time Categories (ordinal 1-9):
1. Less than 10 minutes
2. 10 to 14 minutes
3. 15 to 19 minutes
4. 20 to 24 minutes
5. 25 to 29 minutes
6. 30 to 34 minutes
7. 35 to 44 minutes
8. 45 to 59 minutes
9. 60 or more minutes

---

## Computed / Derived Data

### BLO Livability Index v2.0

| Field | Value |
|-------|-------|
| **Source** | BLO (computed from all other datasets) |
| **Year** | 2024 |
| **Processed File** | `public/datasets/precomputed/combined_scores_v2.json` |
| **Format** | JSON |
| **Records** | 3,144 counties |
| **Key Fields** | GEOID, blo_score_v2, component scores for each metric |
| **Score Range** | 1.15 - 3.28 (0-5 scale) |
| **National Average** | 2.42 |
| **Citation** | (BLO) |

### National Averages

| Field | Value |
|-------|-------|
| **File** | `public/datasets/precomputed/national_averages.json` |
| **Purpose** | Comparison benchmarks for county modal display |

---

## Geographic Data

### County Boundaries

| Field | Value |
|-------|-------|
| **Source** | US Census Bureau / Natural Earth |
| **File** | `public/datasets/geographic/counties.geojson` |
| **Format** | GeoJSON |
| **Size** | 2.8 MB |
| **Key Fields** | GEOID (5-digit FIPS), NAME, STATE |

---

## Data Dictionary Reference

Most BWDC source data includes documentation:
- `Read_Me_BWDC.pdf` - General data description
- `data-dictionary.xlsx` - Field definitions and value codes

---

## Adding New Data Sources

When adding a new data source:

1. **Source Data**: Place raw files in `source-data/<category>/`
2. **Processing**: Create script in `scripts/` if transformation needed
3. **Output**: Save processed data to `public/datasets/<category>/`
4. **Metadata**: Add entry to `src/config/datasetMetadata.ts`
5. **Layer Config**: Add layer to `src/config/layerConfig.ts` with citation in tooltip
6. **Types**: Add TypeScript types to `src/types/mapTypes.ts`
7. **Constants**: Add data path to `src/config/constants.ts`
8. **Loader**: Add loading function to `src/composables/useMapData.ts`
9. **Map Integration**: Add to Map.vue (colors, choropleth, tooltip)
10. **UI**: Update LayerControls.vue, ColorLegend.vue, CountyModal.vue
11. **About Page**: Update `src/views/AboutView.vue` with source attribution
12. **This File**: Update DATA_SOURCES.md with complete documentation

---

## Data Quality Notes

- **GEOID Format**: All county identifiers use 5-digit FIPS codes (2-digit state + 3-digit county), zero-padded
- **Missing Data**: Counties with missing data for specific metrics receive redistributed weights in composite scoring
- **Statistical Reliability**: Some race-specific metrics only include counties with 50+ Black residents
- **Temporal Consistency**: Data years range from 2014 (life expectancy) to 2025 (wages); noted in each section
- **Unmatched Counties**: ~15 counties (0.5%) unmatched in commute data due to Connecticut planning regions and Alaska special areas
