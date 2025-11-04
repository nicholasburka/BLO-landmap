#!/usr/bin/env node

/**
 * BLO Data Integration - Dataset Standardization Script
 * This script standardizes all extracted datasets to a common format with FIPS codes
 */

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

console.log('=========================================');
console.log('BLO Dataset Standardization Script');
console.log('=========================================\n');

// Helper function to extract FIPS from county name
// Format: "County Name, State" -> FIPS code
const countyNameToFips = {};

// Load existing county data to build FIPS lookup
function buildFipsLookup() {
  console.log('Building FIPS lookup table...');

  const diversityFile = 'public/datasets/demographics/county_pctBlack_diversity_index_with_stats.csv';

  if (fs.existsSync(diversityFile)) {
    const content = fs.readFileSync(diversityFile, 'utf-8');
    const records = parse(content, { columns: true });

    records.forEach(record => {
      const key = `${record.CTYNAME}, ${record.STNAME}`.toLowerCase();
      countyNameToFips[key] = record.GEOID;
    });

    console.log(`✓ Loaded ${Object.keys(countyNameToFips).length} county FIPS codes\n`);
  } else {
    console.warn('⚠ Warning: Could not find existing county data for FIPS lookup\n');
  }
}

// Extract FIPS from geo_id format: "0500000US01001" -> "01001"
function extractFipsFromGeoId(geoId) {
  if (!geoId) return null;
  const match = geoId.match(/0500000US(\d{5})/);
  return match ? match[1] : null;
}

// Get FIPS from county name
function getFipsFromCountyName(geoName) {
  if (!geoName) return null;

  const key = geoName.toLowerCase().trim();
  return countyNameToFips[key] || null;
}

// Process Average Weekly Wages
function processWeeklyWages() {
  console.log('Processing: Average Weekly Wages');
  console.log('-----------------------------------');

  const input = 'source-data/AVG WEEKLY WAGES/explore_data_emp_09/emp_09.csv';
  const output = 'public/datasets/economic/avg_weekly_wages.csv';

  const content = fs.readFileSync(input, 'utf-8');
  const records = parse(content, { columns: true });

  const processed = records
    .map(r => {
      const fips = extractFipsFromGeoId(r.geo_id);
      if (!fips) return null; // Skip non-county records
      return {
        GEOID: fips,
        county_name: r.geo_name,
        state_name: r.state_name || '',
        year: r.year,
        avg_weekly_wage: parseFloat(r.avg_wkly_wage) || 0,
        quarterly_establishments: parseFloat(r.qrtly_estabs) || 0,
      };
    })
    .filter(r => r !== null && r.GEOID);

  fs.writeFileSync(output, stringify(processed, { header: true }));
  console.log(`✓ Processed ${processed.length} counties`);
  console.log(`✓ Output: ${output}\n`);

  return processed.length;
}

// Process Median Income by Race
function processMedianIncome() {
  console.log('Processing: Median Income by Race');
  console.log('-----------------------------------');

  const input = 'source-data/RACIAL PROGRESS/Median Income by Race_Ethnicity/explore_data_emp_08/emp_08.csv';
  const output = 'public/datasets/economic/median_income_by_race.csv';

  const content = fs.readFileSync(input, 'utf-8');
  const records = parse(content, { columns: true });

  const processed = records
    .filter(r => r.geo_level === 'county')
    .map(r => {
      const fips = getFipsFromCountyName(r.geo_name);
      const medianIncomeBlack = parseFloat(r.median_income_black_alone);
      return {
        GEOID: fips,
        county_name: r.geo_name,
        state_name: r.state_name,
        year: r.year,
        median_income: parseFloat(r.median_income) || 0,
        // Treat 0 as unknown since $0 median income doesn't make sense
        median_income_black: medianIncomeBlack > 0 ? medianIncomeBlack : null,
        median_income_white: parseFloat(r.median_income_white_alone) || 0,
        median_income_hispanic: parseFloat(r.median_income_hispanic) || 0,
        median_income_asian: parseFloat(r.median_income_asian_alone) || 0,
      };
    })
    .filter(r => r.GEOID);

  fs.writeFileSync(output, stringify(processed, { header: true }));
  console.log(`✓ Processed ${processed.length} counties`);
  console.log(`✓ Output: ${output}\n`);

  return processed.length;
}

// Process Median Home Value
function processHomeValue() {
  console.log('Processing: Median Home Value');
  console.log('-----------------------------------');

  const input = 'source-data/MEDIAN VALUE of OWNER OCCUPIED MORTGAGES/hom_06.csv';
  const output = 'public/datasets/housing/median_home_value.csv';

  const content = fs.readFileSync(input, 'utf-8');
  const records = parse(content, { columns: true });

  const processed = records
    .filter(r => r.geo_level === 'county')
    .map(r => {
      const fips = getFipsFromCountyName(r.geo_name);
      const homeValue = parseFloat(r.median_home_value_owner_occupied_houses_with_mortages);
      return {
        GEOID: fips,
        county_name: r.geo_name,
        state_name: r.state_name,
        year: r.year,
        // Treat 0 as unknown since $0 median home value doesn't make sense
        median_home_value_with_mortgage: homeValue > 0 ? homeValue : null,
        median_home_value_without_mortgage: parseFloat(r.median_home_value_owner_occupied_houses_without_mortages) || 0,
        pct_homeownership_black: parseFloat(r.pct_homeownership_black_alone) || 0,
      };
    })
    .filter(r => r.GEOID);

  fs.writeFileSync(output, stringify(processed, { header: true }));
  console.log(`✓ Processed ${processed.length} counties`);
  console.log(`✓ Output: ${output}\n`);

  return processed.length;
}

// Process Median Property Tax
function processPropertyTax() {
  console.log('Processing: Median Property Tax');
  console.log('-----------------------------------');

  const input = 'source-data/MEDIAN REAL ESTATE TAXES OF OWNER - OCCUPIED MORTGAGES/hom_08.csv';
  const output = 'public/datasets/housing/median_property_tax.csv';

  const content = fs.readFileSync(input, 'utf-8');
  const records = parse(content, { columns: true });

  const processed = records
    .filter(r => r.geo_level === 'county')
    .map(r => {
      const fips = getFipsFromCountyName(r.geo_name);
      return {
        GEOID: fips,
        county_name: r.geo_name,
        state_name: r.state_name,
        year: r.year,
        median_property_tax_with_mortgage: parseFloat(r.median_real_estate_taxes_owner_occupied_houses_with_mortages) || 0,
        median_property_tax_without_mortgage: parseFloat(r.median_real_estate_taxes_owner_occupied_houses_without_mortages) || 0,
      };
    })
    .filter(r => r.GEOID);

  fs.writeFileSync(output, stringify(processed, { header: true }));
  console.log(`✓ Processed ${processed.length} counties`);
  console.log(`✓ Output: ${output}\n`);

  return processed.length;
}

// Process Homeownership Rate
function processHomeownership() {
  console.log('Processing: Homeownership Rate by Race');
  console.log('-----------------------------------');

  const input = 'source-data/RACIAL PROGRESS/Homeownership Rate by Race_Ehtnicity/adt_06.csv';
  const output = 'public/datasets/equity/homeownership_by_race.csv';

  const content = fs.readFileSync(input, 'utf-8');
  const records = parse(content, { columns: true });

  const processed = records
    .filter(r => r.geo_level === 'county')
    .map(r => {
      const fips = getFipsFromCountyName(r.geo_name);
      const blackPop = parseFloat(r.pop_black_alone) || 0;

      // Only include Black homeownership rate if there's a meaningful Black population (>= 50 people)
      // and the rate is not 0 (0% doesn't make sense) to ensure statistical reliability
      const rawBlackHomeownership = parseFloat(r.pct_homeownership_black_alone);
      const blackHomeownership = blackPop >= 50 && rawBlackHomeownership && rawBlackHomeownership > 0
        ? rawBlackHomeownership
        : null;

      return {
        GEOID: fips,
        county_name: r.geo_name,
        state_name: r.state_name,
        year: r.year,
        black_population: blackPop,
        homeownership_rate: parseFloat(r.pct_homeownership) || 0,
        homeownership_rate_black: blackHomeownership,
        homeownership_rate_white: parseFloat(r.pct_homeownership_white_alone) || 0,
      };
    })
    .filter(r => r.GEOID);

  fs.writeFileSync(output, stringify(processed, { header: true }));
  console.log(`✓ Processed ${processed.length} counties`);
  console.log(`✓ Output: ${output}\n`);

  return processed.length;
}

// Process Poverty Rate
function processPovertyRate() {
  console.log('Processing: Poverty Rate by Race');
  console.log('-----------------------------------');

  const input = 'source-data/RACIAL PROGRESS/Percent Poverty (by Race_Ethnicity)/adt_04.csv';
  const output = 'public/datasets/equity/poverty_by_race.csv';

  const content = fs.readFileSync(input, 'utf-8');
  const records = parse(content, { columns: true });

  const processed = records
    .filter(r => r.geo_level === 'county')
    .map(r => {
      const fips = getFipsFromCountyName(r.geo_name);
      const povertyRateBlack = parseFloat(r.pct_below_poverty_black_alone);
      return {
        GEOID: fips,
        county_name: r.geo_name,
        state_name: r.state_name,
        year: r.year,
        poverty_rate: parseFloat(r.pct_below_poverty) || 0,
        // Treat 0 as unknown since 0% poverty rate is unrealistic
        poverty_rate_black: povertyRateBlack > 0 ? povertyRateBlack : null,
        poverty_rate_white: parseFloat(r.pct_below_poverty_white_alone) || 0,
      };
    })
    .filter(r => r.GEOID);

  fs.writeFileSync(output, stringify(processed, { header: true }));
  console.log(`✓ Processed ${processed.length} counties`);
  console.log(`✓ Output: ${output}\n`);

  return processed.length;
}

// Process Black Progress Index
function processBlackProgressIndex() {
  console.log('Processing: Black Progress Index');
  console.log('-----------------------------------');

  const input = 'source-data/RACIAL PROGRESS/The Black Progress Index (NAACPxBrookings)/County_Level_Black_Progress_Index.csv';
  const output = 'public/datasets/equity/black_progress_index.csv';

  const content = fs.readFileSync(input, 'utf-8');
  const records = parse(content, { columns: true });

  const processed = records.map(r => {
    // Pad FIPS code to 5 digits
    const fips = String(r.ctyfip).padStart(5, '0');

    // Helper to convert blank/invalid to null
    const parseOrNull = (val) => {
      const parsed = parseFloat(val);
      return isNaN(parsed) || val === '' ? null : parsed;
    };

    return {
      GEOID: fips,
      county_name: r.county_name,
      state: r.state,
      black_progress_index: parseOrNull(r.black_progress_index),
      black_progress_index_centile: parseOrNull(r.black_progress_index_centile),
      life_exp_black: parseOrNull(r.life_exp_bl),
      low_birth_black: parseOrNull(r.low_birth_bl),
      math_black: parseOrNull(r.math_black),
      education_ba_rate_black: parseOrNull(r.pop25_ba_higher_rate_black),
      homeowner_rate_black: parseOrNull(r.black_homeowner_rate),
      business_owner_rate: parseOrNull(r.business_owner_rate),
      median_hh_income_black_ln: parseOrNull(r.ln_b_medhh_inc),
      pct_black: parseOrNull(r.pblack),
    };
  });

  fs.writeFileSync(output, stringify(processed, { header: true }));
  console.log(`✓ Processed ${processed.length} counties`);
  console.log(`✓ Output: ${output}\n`);

  return processed.length;
}

// Main execution
async function main() {
  try {
    buildFipsLookup();

    let totalProcessed = 0;

    // Process all datasets
    totalProcessed += processWeeklyWages();
    totalProcessed += processMedianIncome();
    totalProcessed += processHomeValue();
    totalProcessed += processPropertyTax();
    totalProcessed += processHomeownership();
    totalProcessed += processPovertyRate();
    totalProcessed += processBlackProgressIndex();

    console.log('=========================================');
    console.log('✓ Standardization Complete!');
    console.log('=========================================');
    console.log(`Total records processed: ${totalProcessed}`);
    console.log('\nOutput files created in public/datasets/:');
    console.log('  - economic/avg_weekly_wages.csv');
    console.log('  - economic/median_income_by_race.csv');
    console.log('  - housing/median_home_value.csv');
    console.log('  - housing/median_property_tax.csv');
    console.log('  - equity/homeownership_by_race.csv');
    console.log('  - equity/poverty_by_race.csv');
    console.log('  - equity/black_progress_index.csv');
    console.log('\nNext steps:');
    console.log('1. Review the output files');
    console.log('2. Create the scoring engine: scripts/calculate_blo_v2_scores.cjs');
    console.log('3. Update the UI layer configuration');
    console.log('');

  } catch (error) {
    console.error('\nError during standardization:', error);
    process.exit(1);
  }
}

main();
