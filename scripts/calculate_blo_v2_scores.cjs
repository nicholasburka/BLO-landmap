#!/usr/bin/env node

/**
 * BLO v2.0 Scoring Engine
 * Combines existing + new datasets into comprehensive liveability scores
 */

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

console.log('=========================================');
console.log('BLO v2.0 Scoring Engine');
console.log('=========================================\n');

// Weights configuration (must sum to 1.0)
const WEIGHTS = {
  // Existing metrics (35%)
  diversityIndex: 0.10,
  pctBlack: 0.10,
  lifeExpectancy: 0.10,
  contamination: 0.05,

  // New economic metrics (20%)
  avgWeeklyWage: 0.10,
  medianIncomeBlack: 0.10,

  // New housing/affordability metrics (20%)
  medianHomeValue: 0.10,      // Lower is better for affordability
  medianPropertyTax: 0.05,    // Lower is better for affordability
  homeownershipBlack: 0.05,

  // New equity metrics (15%)
  povertyRateBlack: 0.10,     // Lower is better
  blackProgressIndex: 0.15,   // Comprehensive progress measure
};

// Verify weights sum to 1.0
const totalWeight = Object.values(WEIGHTS).reduce((sum, w) => sum + w, 0);
if (Math.abs(totalWeight - 1.0) > 0.001) {
  console.error(`ERROR: Weights sum to ${totalWeight}, must equal 1.0`);
  process.exit(1);
}

// Load CSV file helper
function loadCSV(filePath) {
  if (!fs.existsSync(filePath)) {
    console.warn(`⚠ Warning: File not found: ${filePath}`);
    return [];
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  return parse(content, { columns: true });
}

// Normalize value to 0-1 range
function normalize(value, min, max) {
  if (max === min) return 0.5;
  return (value - min) / (max - min);
}

// Calculate min/max for normalization
function getMinMax(records, field) {
  const values = records
    .map(r => parseFloat(r[field]))
    .filter(v => !isNaN(v) && v !== null);

  return {
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

// Main scoring function
async function calculateScores() {
  console.log('Loading datasets...\n');

  // Load existing datasets
  const diversityData = loadCSV('public/datasets/demographics/county_pctBlack_diversity_index_with_stats.csv');
  const lifeExpectancyData = loadCSV('public/datasets/demographics/lifeexpectancy-USA-county.csv');
  const contaminationData = JSON.parse(
    fs.readFileSync('public/datasets/epa-contamination/contamination_counts.json', 'utf-8')
  );

  // Load new datasets
  const avgWagesData = loadCSV('public/datasets/economic/avg_weekly_wages.csv');
  const medianIncomeData = loadCSV('public/datasets/economic/median_income_by_race.csv');
  const homeValueData = loadCSV('public/datasets/housing/median_home_value.csv');
  const propertyTaxData = loadCSV('public/datasets/housing/median_property_tax.csv');
  const homeownershipData = loadCSV('public/datasets/equity/homeownership_by_race.csv');
  const povertyData = loadCSV('public/datasets/equity/poverty_by_race.csv');
  const blackProgressData = loadCSV('public/datasets/equity/black_progress_index.csv');

  console.log(`✓ Loaded ${diversityData.length} diversity records`);
  console.log(`✓ Loaded ${lifeExpectancyData.length} life expectancy records`);
  console.log(`✓ Loaded ${Object.keys(contaminationData).length} contamination records`);
  console.log(`✓ Loaded ${avgWagesData.length} wage records`);
  console.log(`✓ Loaded ${medianIncomeData.length} median income records`);
  console.log(`✓ Loaded ${homeValueData.length} home value records`);
  console.log(`✓ Loaded ${propertyTaxData.length} property tax records`);
  console.log(`✓ Loaded ${homeownershipData.length} homeownership records`);
  console.log(`✓ Loaded ${povertyData.length} poverty records`);
  console.log(`✓ Loaded ${blackProgressData.length} Black Progress Index records\n`);

  // Index data by FIPS code for fast lookup
  const diversityByFips = {};
  const lifeExpByFips = {};
  const wagesByFips = {};
  const incomeByFips = {};
  const homeValueByFips = {};
  const propertyTaxByFips = {};
  const homeownershipByFips = {};
  const povertyByFips = {};
  const blackProgressByFips = {};

  diversityData.forEach(r => { diversityByFips[r.GEOID] = r; });
  lifeExpectancyData.forEach(r => { lifeExpByFips[r.GEOID] = r; });
  avgWagesData.forEach(r => { wagesByFips[r.GEOID] = r; });
  medianIncomeData.forEach(r => { incomeByFips[r.GEOID] = r; });
  homeValueData.forEach(r => { homeValueByFips[r.GEOID] = r; });
  propertyTaxData.forEach(r => { propertyTaxByFips[r.GEOID] = r; });
  homeownershipData.forEach(r => { homeownershipByFips[r.GEOID] = r; });
  povertyData.forEach(r => { povertyByFips[r.GEOID] = r; });
  blackProgressData.forEach(r => { blackProgressByFips[r.GEOID] = r; });

  console.log('Merging datasets by FIPS code...\n');

  // Merge all data by FIPS
  const mergedData = {};

  diversityData.forEach(county => {
    const fips = county.GEOID;
    const lifeExp = lifeExpByFips[fips];
    const contamination = contaminationData[fips];
    const wages = wagesByFips[fips];
    const income = incomeByFips[fips];
    const homeValue = homeValueByFips[fips];
    const propertyTax = propertyTaxByFips[fips];
    const homeownership = homeownershipByFips[fips];
    const poverty = povertyByFips[fips];
    const blackProgress = blackProgressByFips[fips];

    mergedData[fips] = {
      fips,
      county_name: county.CTYNAME,
      state_name: county.STNAME,

      // Existing metrics
      diversityIndex: parseFloat(county.diversity_index) || 0,
      pctBlack: parseFloat(county.pct_Black) || 0,
      lifeExpectancy: lifeExp ? parseFloat(lifeExp['e(0)']) : null,
      contamination: contamination ? contamination.total : 0,

      // New economic metrics
      avgWeeklyWage: wages ? parseFloat(wages.avg_weekly_wage) : null,

      // New equity metrics
      medianIncomeBlack: income ? parseFloat(income.median_income_black) || null : null,
      medianHomeValue: homeValue ? parseFloat(homeValue.median_home_value_with_mortgage) || null : null,
      medianPropertyTax: propertyTax ? parseFloat(propertyTax.median_property_tax_with_mortgage) || null : null,
      homeownershipBlack: homeownership ? parseFloat(homeownership.homeownership_rate_black) || null : null,
      povertyRateBlack: poverty ? parseFloat(poverty.poverty_rate_black) || null : null,

      // Black Progress Index
      blackProgressIndex: blackProgress ? parseFloat(blackProgress.black_progress_index) || null : null,
    };
  });

  const countyCount = Object.keys(mergedData).length;
  console.log(`✓ Merged data for ${countyCount} counties\n`);

  // Calculate min/max for normalization
  console.log('Calculating normalization ranges...\n');

  const allCounties = Object.values(mergedData);

  const ranges = {
    diversityIndex: { min: 0, max: 1 }, // Already 0-1
    pctBlack: { min: 0, max: 100 },
    lifeExpectancy: getMinMax(allCounties.filter(c => c.lifeExpectancy !== null), 'lifeExpectancy'),
    contamination: getMinMax(allCounties, 'contamination'),
    avgWeeklyWage: getMinMax(allCounties.filter(c => c.avgWeeklyWage !== null), 'avgWeeklyWage'),
    medianIncomeBlack: getMinMax(allCounties.filter(c => c.medianIncomeBlack !== null), 'medianIncomeBlack'),
    medianHomeValue: getMinMax(allCounties.filter(c => c.medianHomeValue !== null), 'medianHomeValue'),
    medianPropertyTax: getMinMax(allCounties.filter(c => c.medianPropertyTax !== null), 'medianPropertyTax'),
    homeownershipBlack: { min: 0, max: 100 },
    povertyRateBlack: { min: 0, max: 100 },
    blackProgressIndex: { min: 0, max: 100 },
  };

  console.log('Normalization ranges:');
  Object.entries(ranges).forEach(([key, range]) => {
    console.log(`  ${key}: ${range.min.toFixed(2)} - ${range.max.toFixed(2)}`);
  });
  console.log('');

  // Calculate BLO v2.0 scores
  console.log('Calculating BLO v2.0 scores...\n');

  const scoredCounties = {};
  let countWithScore = 0;
  let countMissingData = 0;

  Object.entries(mergedData).forEach(([fips, county]) => {
    // Track missing data
    const missingFields = [];
    if (county.lifeExpectancy === null) missingFields.push('lifeExpectancy');
    if (county.avgWeeklyWage === null) missingFields.push('avgWeeklyWage');
    if (county.medianIncomeBlack === null) missingFields.push('medianIncomeBlack');
    if (county.medianHomeValue === null) missingFields.push('medianHomeValue');
    if (county.medianPropertyTax === null) missingFields.push('medianPropertyTax');
    if (county.homeownershipBlack === null) missingFields.push('homeownershipBlack');
    if (county.povertyRateBlack === null) missingFields.push('povertyRateBlack');
    if (county.blackProgressIndex === null) missingFields.push('blackProgressIndex');

    // Calculate normalized values only for available data
    const normalized = {
      diversityIndex: county.diversityIndex, // Already 0-1
      pctBlack: normalize(county.pctBlack, ranges.pctBlack.min, ranges.pctBlack.max),
      lifeExpectancy: county.lifeExpectancy !== null
        ? normalize(county.lifeExpectancy, ranges.lifeExpectancy.min, ranges.lifeExpectancy.max)
        : null,
      contamination: normalize(county.contamination, ranges.contamination.min, ranges.contamination.max),
      avgWeeklyWage: county.avgWeeklyWage !== null
        ? normalize(county.avgWeeklyWage, ranges.avgWeeklyWage.min, ranges.avgWeeklyWage.max)
        : null,
      medianIncomeBlack: county.medianIncomeBlack !== null
        ? normalize(county.medianIncomeBlack, ranges.medianIncomeBlack.min, ranges.medianIncomeBlack.max)
        : null,
      medianHomeValue: county.medianHomeValue !== null
        ? normalize(county.medianHomeValue, ranges.medianHomeValue.min, ranges.medianHomeValue.max)
        : null,
      medianPropertyTax: county.medianPropertyTax !== null
        ? normalize(county.medianPropertyTax, ranges.medianPropertyTax.min, ranges.medianPropertyTax.max)
        : null,
      homeownershipBlack: county.homeownershipBlack !== null
        ? normalize(county.homeownershipBlack, ranges.homeownershipBlack.min, ranges.homeownershipBlack.max)
        : null,
      povertyRateBlack: county.povertyRateBlack !== null
        ? normalize(county.povertyRateBlack, ranges.povertyRateBlack.min, ranges.povertyRateBlack.max)
        : null,
      blackProgressIndex: county.blackProgressIndex !== null
        ? normalize(county.blackProgressIndex, ranges.blackProgressIndex.min, ranges.blackProgressIndex.max)
        : null,
    };

    // Calculate weighted score using only available metrics
    let weightedSum = 0;
    let availableWeight = 0;

    // Add each metric's contribution if data is available
    if (normalized.diversityIndex !== null) {
      weightedSum += normalized.diversityIndex * WEIGHTS.diversityIndex;
      availableWeight += WEIGHTS.diversityIndex;
    }
    if (normalized.pctBlack !== null) {
      weightedSum += normalized.pctBlack * WEIGHTS.pctBlack;
      availableWeight += WEIGHTS.pctBlack;
    }
    if (normalized.lifeExpectancy !== null) {
      weightedSum += normalized.lifeExpectancy * WEIGHTS.lifeExpectancy;
      availableWeight += WEIGHTS.lifeExpectancy;
    }
    if (normalized.contamination !== null) {
      weightedSum += (1 - normalized.contamination) * WEIGHTS.contamination;
      availableWeight += WEIGHTS.contamination;
    }
    if (normalized.avgWeeklyWage !== null) {
      weightedSum += normalized.avgWeeklyWage * WEIGHTS.avgWeeklyWage;
      availableWeight += WEIGHTS.avgWeeklyWage;
    }
    if (normalized.medianIncomeBlack !== null) {
      weightedSum += normalized.medianIncomeBlack * WEIGHTS.medianIncomeBlack;
      availableWeight += WEIGHTS.medianIncomeBlack;
    }
    if (normalized.medianHomeValue !== null) {
      weightedSum += (1 - normalized.medianHomeValue) * WEIGHTS.medianHomeValue;
      availableWeight += WEIGHTS.medianHomeValue;
    }
    if (normalized.medianPropertyTax !== null) {
      weightedSum += (1 - normalized.medianPropertyTax) * WEIGHTS.medianPropertyTax;
      availableWeight += WEIGHTS.medianPropertyTax;
    }
    if (normalized.homeownershipBlack !== null) {
      weightedSum += normalized.homeownershipBlack * WEIGHTS.homeownershipBlack;
      availableWeight += WEIGHTS.homeownershipBlack;
    }
    if (normalized.povertyRateBlack !== null) {
      weightedSum += (1 - normalized.povertyRateBlack) * WEIGHTS.povertyRateBlack;
      availableWeight += WEIGHTS.povertyRateBlack;
    }
    if (normalized.blackProgressIndex !== null) {
      weightedSum += normalized.blackProgressIndex * WEIGHTS.blackProgressIndex;
      availableWeight += WEIGHTS.blackProgressIndex;
    }

    // Normalize by available weight to get 0-1 score, then scale to 0-5
    const bloScore = availableWeight > 0
      ? (weightedSum / availableWeight) * 5.0
      : 0;

    scoredCounties[fips] = {
      fips,
      county_name: county.county_name,
      state_name: county.state_name,
      blo_score_v2: parseFloat(bloScore.toFixed(4)),

      // Component scores for transparency (only include available data)
      components: {
        diversity: normalized.diversityIndex,
        pct_black: normalized.pctBlack,
        life_expectancy: normalized.lifeExpectancy !== null ? normalized.lifeExpectancy : null,
        contamination: normalized.contamination !== null ? 1 - normalized.contamination : null,
        avg_weekly_wage: normalized.avgWeeklyWage !== null ? normalized.avgWeeklyWage : null,
        median_income_black: normalized.medianIncomeBlack !== null ? normalized.medianIncomeBlack : null,
        median_home_value: normalized.medianHomeValue !== null ? 1 - normalized.medianHomeValue : null,
        median_property_tax: normalized.medianPropertyTax !== null ? 1 - normalized.medianPropertyTax : null,
        homeownership_black: normalized.homeownershipBlack !== null ? normalized.homeownershipBlack : null,
        poverty_rate_black: normalized.povertyRateBlack !== null ? 1 - normalized.povertyRateBlack : null,
        black_progress_index: normalized.blackProgressIndex !== null ? normalized.blackProgressIndex : null,
      },

      // Raw values for reference
      raw: {
        diversity_index: county.diversityIndex,
        pct_black: county.pctBlack,
        life_expectancy: county.lifeExpectancy,
        contamination_count: county.contamination,
        avg_weekly_wage: county.avgWeeklyWage,
        median_income_black: county.medianIncomeBlack,
        median_home_value: county.medianHomeValue,
        median_property_tax: county.medianPropertyTax,
        homeownership_rate_black: county.homeownershipBlack,
        poverty_rate_black: county.povertyRateBlack,
        black_progress_index: county.blackProgressIndex,
      },

      missing_data: missingFields,
    };

    if (missingFields.length > 0) {
      countMissingData++;
    } else {
      countWithScore++;
    }
  });

  console.log(`✓ Calculated scores for ${Object.keys(scoredCounties).length} counties`);
  console.log(`  - ${countWithScore} counties have complete data`);
  console.log(`  - ${countMissingData} counties have some missing data (using defaults)\n`);

  // Calculate national average (excluding NaN values)
  const allScores = Object.values(scoredCounties)
    .map(c => c.blo_score_v2)
    .filter(s => !isNaN(s) && s > 0); // Exclude NaN and 0 scores
  const nationalAverage = allScores.length > 0
    ? allScores.reduce((sum, s) => sum + s, 0) / allScores.length
    : 0;

  console.log(`National average BLO v2.0 score: ${nationalAverage.toFixed(4)} of 5\n`);

  // Save results
  const outputPath = 'public/datasets/precomputed/combined_scores_v2.json';
  fs.writeFileSync(outputPath, JSON.stringify(scoredCounties, null, 2));

  console.log('=========================================');
  console.log('✓ BLO v2.0 Scoring Complete!');
  console.log('=========================================');
  console.log(`Output: ${outputPath}`);
  console.log(`Total counties: ${Object.keys(scoredCounties).length}`);
  console.log(`Average score: ${nationalAverage.toFixed(4)} of 5`);
  console.log('');
}

// Run
calculateScores().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});
