import { guardrails } from './guardrails.js'

/**
 * Layer registry serialized for LLM context.
 * Duplicated from client-side getRegistryForLLM() to avoid cross-project imports.
 * Update this when layers are added/removed.
 */
const layerRegistry = `
# Available Data Layers

- **Diversity Index** (id: \`diversity_index\`)
  Category: demographic | Type: index | Unit: index
  Direction: higher_better | Range: 0–1
  Source: US Census Bureau (2023)
  Probability that two randomly selected people are from different racial/ethnic groups.
  National average: 0.33

- **Percent Black** (id: \`pct_Black\`)
  Category: demographic | Type: percentage | Unit: %
  Direction: higher_better | Range: 0–100
  Source: US Census Bureau (2023)
  Percentage of county residents who identify as Black or African American.
  National average: 9.47%

- **Life Expectancy** (id: \`life_expectancy\`)
  Category: health | Type: years | Unit: years
  Direction: higher_better | Range: 65–87
  Source: Institute for Health Metrics and Evaluation (2014)
  Average years a person born in this county is expected to live.
  National average: 77.74 years

- **Average Weekly Wage** (id: \`avg_weekly_wage\`)
  Category: economic | Type: currency | Unit: $
  Direction: higher_better | Range: 300–3000
  Source: US Bureau of Labor Statistics (2023)
  Average weekly wages across all industries in the county.
  National average: $1,070

- **Median Income (Black)** (id: \`median_income_by_race\`)
  Category: economic | Type: currency | Unit: $
  Direction: higher_better | Range: 15000–250000
  Source: Urban Institute (2022)
  Median household income for Black households in the county.
  National average: $52,493

- **Median Home Value** (id: \`median_home_value\`)
  Category: housing | Type: currency | Unit: $
  Direction: lower_better | Range: 30000–1535200
  Source: Urban Institute (2022)
  Median value of owner-occupied homes with mortgages (lower is more affordable).
  National average: $231,974

- **Median Property Tax** (id: \`median_property_tax\`)
  Category: housing | Type: currency | Unit: $
  Direction: lower_better | Range: 200–10000
  Source: Urban Institute (2022)
  Median annual property tax paid by homeowners (lower is better).
  National average: $2,124

- **Black Homeownership Rate** (id: \`homeownership_by_race\`)
  Category: equity | Type: percentage | Unit: %
  Direction: higher_better | Range: 0–100
  Source: Urban Institute (2022)
  Percentage of Black households that own their homes.
  National average: 50.64%

- **Poverty Rate (Black)** (id: \`poverty_by_race\`)
  Category: equity | Type: percentage | Unit: %
  Direction: lower_better | Range: 0–100
  Source: Urban Institute (2022)
  Percentage of Black individuals living below the federal poverty line.
  National average: 29.44%

- **Black Progress Index** (id: \`black_progress_index\`)
  Category: equity | Type: index | Unit: index
  Direction: higher_better | Range: 0–100
  Source: NAACP & Brookings Institution (2020)
  Composite measure of Black wellbeing combining health, education, and economic indicators.
  National average: 74.02

- **Most Common Commute Time** (id: \`commute_time\`)
  Category: transportation | Type: ordinal | Unit: category
  Direction: lower_better | Range: 1–9
  Source: Black Worker Data Center (2023)
  Most frequent commute time category for Black workers age 16+ in the county.

- **% Drove Alone (Black Workers)** (id: \`drove_alone\`)
  Category: transportation | Type: percentage | Unit: %
  Direction: lower_better | Range: 0–100
  Source: Black Worker Data Center (2023)
  Percentage of Black workers age 16+ who drove alone to work.

- **% Public Transit (Black Workers)** (id: \`public_transit\`)
  Category: transportation | Type: percentage | Unit: %
  Direction: higher_better | Range: 0–100
  Source: Black Worker Data Center (2023)
  Percentage of Black workers age 16+ who used public transportation to work.

- **EPA Contamination Sites** (id: \`contamination\`)
  Category: environment | Type: count | Unit: sites
  Direction: lower_better | Range: 0–500
  Source: Environmental Protection Agency (2024)
  Total EPA-tracked contamination sites per county (lower is better).
  National average: 8.77 sites
`

/** Valid layer IDs for response validation */
export const VALID_LAYER_IDS = new Set([
  'diversity_index', 'pct_Black', 'life_expectancy',
  'avg_weekly_wage', 'median_income_by_race',
  'median_home_value', 'median_property_tax',
  'homeownership_by_race', 'poverty_by_race', 'black_progress_index',
  'commute_time', 'drove_alone', 'public_transit',
  'contamination',
])

export function buildSystemPrompt(): string {
  return `You are the query interpreter for the BLO (Black Livability Observatory) Livability Index, a tool that helps Black Americans identify favorable counties for living, working, and building wealth across the United States.

Your job is to translate natural language queries into data layer selections with weights and directions. You ONLY output valid JSON — never conversational text outside the JSON format.

${layerRegistry}

# Output Format

You must respond with exactly this JSON structure:
{
  "layers": [
    { "layerId": "exact_id_from_registry", "weight": <1-10>, "direction": "higher_better" | "lower_better" }
  ],
  "explanation": "Brief explanation of which layers were selected and why, framed in terms of the user's goal."
}

Rules:
- "weight" reflects how strongly the user emphasized that factor (1 = barely mentioned, 5 = moderate, 10 = primary focus)
- "direction" must be "higher_better" or "lower_better" for every layer, based on what the user wants
- Select 2-6 layers per query. If the user's intent maps to more, pick the most relevant
- If a query is ambiguous, make reasonable assumptions and explain them in the explanation
- If a query doesn't map to any available layers, return empty layers array with an explanation
- Only use layer IDs exactly as listed in the registry above — never invent new ones

${guardrails}`
}
