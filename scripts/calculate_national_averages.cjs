#!/usr/bin/env node

/**
 * Calculate National Averages for All BLO v2.0 Metrics
 * Used for county modal comparison displays
 */

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

console.log('=========================================');
console.log('National Averages Calculation');
console.log('=========================================\n');

// Helper to load CSV
function loadCSV(filePath) {
  if (!fs.existsSync(filePath)) {
    console.warn(`⚠ Warning: File not found: ${filePath}`);
    return [];
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  return parse(content, { columns: true });
}

// Helper to calculate average of non-null values
function calculateAverage(values) {
  const validValues = values.filter(v => v != null && !isNaN(v) && v !== 0);
  if (validValues.length === 0) return null;
  return validValues.reduce((sum, v) => sum + v, 0) / validValues.length;
}

async function main() {
  console.log('Loading datasets...\n');

  // Load all datasets
  const diversityData = loadCSV('public/datasets/demographics/county_pctBlack_diversity_index_with_stats.csv');
  const lifeExpectancyData = loadCSV('public/datasets/demographics/lifeexpectancy-USA-county.csv');
  const contaminationData = JSON.parse(
    fs.readFileSync('public/datasets/epa-contamination/contamination_counts.json', 'utf-8')
  );
  const avgWagesData = loadCSV('public/datasets/economic/avg_weekly_wages.csv');
  const medianIncomeData = loadCSV('public/datasets/economic/median_income_by_race.csv');
  const homeValueData = loadCSV('public/datasets/housing/median_home_value.csv');
  const propertyTaxData = loadCSV('public/datasets/housing/median_property_tax.csv');
  const homeownershipData = loadCSV('public/datasets/equity/homeownership_by_race.csv');
  const povertyData = loadCSV('public/datasets/equity/poverty_by_race.csv');
  const blackProgressData = loadCSV('public/datasets/equity/black_progress_index.csv');
  const combinedScoresV2 = JSON.parse(
    fs.readFileSync('public/datasets/precomputed/combined_scores_v2.json', 'utf-8')
  );

  console.log('Calculating national averages...\n');

  // Calculate BLO v2.0 average
  const bloScores = Object.values(combinedScoresV2)
    .map(c => c.blo_score_v2)
    .filter(s => s != null && !isNaN(s) && s > 0);
  const avgBLOScore = calculateAverage(bloScores);

  // Calculate demographic averages
  const totalPopulations = diversityData.map(r => parseFloat(r.total_population)).filter(v => !isNaN(v));
  const avgTotalPopulation = calculateAverage(totalPopulations);

  const pctBlackValues = diversityData.map(r => parseFloat(r.pct_Black)).filter(v => !isNaN(v));
  const avgPctBlack = calculateAverage(pctBlackValues);

  const diversityIndexValues = diversityData.map(r => parseFloat(r.diversity_index)).filter(v => !isNaN(v));
  const avgDiversityIndex = calculateAverage(diversityIndexValues);

  // Calculate life expectancy average
  const lifeExpValues = lifeExpectancyData.map(r => parseFloat(r['e(0)'])).filter(v => !isNaN(v));
  const avgLifeExpectancy = calculateAverage(lifeExpValues);

  // Calculate contamination average
  const contaminationValues = Object.values(contaminationData).map(c => c.total);
  const avgContamination = calculateAverage(contaminationValues);

  // Calculate economic averages
  const avgWeeklyWageValues = avgWagesData.map(r => parseFloat(r.avg_weekly_wage)).filter(v => !isNaN(v) && v > 0);
  const avgWeeklyWage = calculateAverage(avgWeeklyWageValues);

  const medianIncomeBlackValues = medianIncomeData.map(r => parseFloat(r.median_income_black)).filter(v => !isNaN(v) && v > 0);
  const avgMedianIncomeBlack = calculateAverage(medianIncomeBlackValues);

  // Calculate housing averages
  const medianHomeValueValues = homeValueData.map(r => parseFloat(r.median_home_value_with_mortgage)).filter(v => !isNaN(v) && v > 0);
  const avgMedianHomeValue = calculateAverage(medianHomeValueValues);

  const medianPropertyTaxValues = propertyTaxData.map(r => parseFloat(r.median_property_tax_with_mortgage)).filter(v => !isNaN(v) && v > 0);
  const avgMedianPropertyTax = calculateAverage(medianPropertyTaxValues);

  const homeownershipBlackValues = homeownershipData.map(r => parseFloat(r.homeownership_rate_black)).filter(v => !isNaN(v) && v > 0);
  const avgHomeownershipBlack = calculateAverage(homeownershipBlackValues);

  // Calculate equity averages
  const povertyRateBlackValues = povertyData.map(r => parseFloat(r.poverty_rate_black)).filter(v => !isNaN(v) && v > 0);
  const avgPovertyRateBlack = calculateAverage(povertyRateBlackValues);

  const blackProgressIndexValues = blackProgressData.map(r => parseFloat(r.black_progress_index)).filter(v => !isNaN(v));
  const avgBlackProgressIndex = calculateAverage(blackProgressIndexValues);

  // Compile results
  const nationalAverages = {
    blo_score_v2: avgBLOScore,
    total_population: avgTotalPopulation,
    pct_black: avgPctBlack,
    diversity_index: avgDiversityIndex,
    life_expectancy: avgLifeExpectancy,
    contamination: avgContamination,
    avg_weekly_wage: avgWeeklyWage,
    median_income_black: avgMedianIncomeBlack,
    median_home_value: avgMedianHomeValue,
    median_property_tax: avgMedianPropertyTax,
    homeownership_rate_black: avgHomeownershipBlack,
    poverty_rate_black: avgPovertyRateBlack,
    black_progress_index: avgBlackProgressIndex,
  };

  // Display results
  console.log('=========================================');
  console.log('National Averages');
  console.log('=========================================\n');
  console.log(`BLO Liveability Index: ${avgBLOScore?.toFixed(2)} of 5.0`);
  console.log(`Total Population: ${avgTotalPopulation?.toLocaleString()}`);
  console.log(`Percent Black: ${avgPctBlack?.toFixed(2)}%`);
  console.log(`Diversity Index: ${avgDiversityIndex?.toFixed(4)} of 1`);
  console.log(`Life Expectancy: ${avgLifeExpectancy?.toFixed(2)} years`);
  console.log(`EPA Contamination Sites: ${avgContamination?.toFixed(2)}`);
  console.log(`\nEconomic Indicators:`);
  console.log(`  Avg Weekly Wage: $${avgWeeklyWage?.toFixed(2)}`);
  console.log(`  Median Income (Black): $${avgMedianIncomeBlack?.toLocaleString()}`);
  console.log(`\nHousing & Affordability:`);
  console.log(`  Median Home Value: $${avgMedianHomeValue?.toLocaleString()}`);
  console.log(`  Median Property Tax: $${avgMedianPropertyTax?.toLocaleString()}`);
  console.log(`  Black Homeownership Rate: ${avgHomeownershipBlack?.toFixed(2)}%`);
  console.log(`\nEquity Indicators:`);
  console.log(`  Poverty Rate (Black): ${avgPovertyRateBlack?.toFixed(2)}%`);
  console.log(`  Black Progress Index: ${avgBlackProgressIndex?.toFixed(2)}`);
  console.log('');

  // Save to file
  const outputPath = 'public/datasets/precomputed/national_averages.json';
  fs.writeFileSync(outputPath, JSON.stringify(nationalAverages, null, 2));

  console.log('=========================================');
  console.log(`✓ Saved to ${outputPath}`);
  console.log('=========================================\n');
}

main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});
