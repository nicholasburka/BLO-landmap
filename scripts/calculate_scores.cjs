const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');

// Function to load JSON data
const loadJSONData = (filePath) => {
  return new Promise((resolve, reject) => {
    fs.readFile(filePath, 'utf-8', (err, data) => {
      if (err) return reject(err);
      resolve(JSON.parse(data));
    });
  });
};

// Function to load CSV data
const loadCSVData = (filePath) => {
  return new Promise((resolve, reject) => {
    const results = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', () => resolve(results))
      .on('error', (error) => reject(error));
  });
};

// Function to calculate scores for each county
const calculateScores = (averages, countyData) => {
  const scores = {};

  for (const countyId in countyData) {
    const data = countyData[countyId];
    
    // Skip if essential data is missing
    if (!data.pct_nhBlack || !data.diversity_index || !data.lifeExpectancy) {
      continue;
    }

    const contaminationValue = parseFloat(data.total) || 0;
    const pctBlackValue = parseFloat(data.pct_nhBlack);
    const diversityIndexValue = parseFloat(data.diversity_index);
    const lifeExpectancyValue = parseFloat(data.lifeExpectancy);

    scores[countyId] = {
      rawValues: {
        contamination: contaminationValue,
        pctBlack: pctBlackValue,
        diversityIndex: diversityIndexValue,
        lifeExpectancy: lifeExpectancyValue
      },
      scores: {
        contaminationScore: getScore(contaminationValue, averages.contaminationStats.avgContamination, averages.contaminationStats.stdDevContamination),
        pctBlackScore: getScore(pctBlackValue, averages.demographicAverages.avgBlackPct, averages.demographicAverages.stdDevBlackPct),
        diversityIndexScore: getScore(diversityIndexValue, averages.demographicAverages.avgDiversityIndex, averages.demographicAverages.stdDevDiversityIndex),
        lifeExpectancyScore: getScore(lifeExpectancyValue, averages.demographicAverages.avgLifeExpectancy, 2.5) // Using approximate std dev for life expectancy
      }
    };
  }

  return scores;
};

// Function to determine the score based on the value and thresholds
const getScore = (value, avg, stdDev) => {
  if (isNaN(value) || isNaN(avg) || isNaN(stdDev)) return 0; // Default to average if any value is NaN

  const thresholds = {
    twoStdDevBelow: avg - 2 * stdDev,
    oneStdDevBelow: avg - stdDev,
    halfStdDevBelow: avg - .5*stdDev,
    average: avg,
    halfStdDevAbove: avg + .5*stdDev,
    oneStdDevAbove: avg + stdDev,
    twoStdDevAbove: avg + 2 * stdDev
  };

  if (value <= thresholds.oneStdDevBelow) return 1;
  if (value <= thresholds.halfStdDevBelow) return 2;
  if (value <= thresholds.oneStdDevAbove) return 3;
  if (value <= thresholds.oneStdDevAbove) return 4;
  return 5;
};

// Main function to execute the script
const main = async () => {
  try {
    const averages = await loadJSONData(path.join(__dirname, '../public/datasets/averages.json'));
    
    // Load all data sources
    const diversityData = await loadCSVData(path.join(__dirname, '../public/datasets/county_pctBlack_diversity_index_with_stats.csv'));
    const lifeExpectancyData = await loadCSVData(path.join(__dirname, '../public/datasets/lifeexpectancy-USA-county.csv'));
    const contaminationData = await loadJSONData(path.join(__dirname, '../public/datasets/new_contamination_counts.json'));

    // Combine county data
    const countyData = {};
    
    // Process diversity data
    diversityData.forEach(item => {
      const countyId = item.GEOID;
      countyData[countyId] = {
        pct_nhBlack: parseFloat(item.pct_nhBlack),
        diversity_index: parseFloat(item.diversity_index)
      };
    });

    // Process life expectancy data
    lifeExpectancyData.forEach(item => {
      const countyId = item.GEOID;
      if (countyData[countyId]) {
        countyData[countyId].lifeExpectancy = parseFloat(item['e(0)']);
      }
    });

    // Process contamination data
    Object.entries(contaminationData).forEach(([countyId, data]) => {
      if (countyData[countyId]) {
        countyData[countyId].total = data.total || 0;
      }
    });

    const scores = calculateScores(averages, countyData);

    // Save results
    fs.writeFileSync(
      path.join(__dirname, '../public/datasets/county_scores.json'), 
      JSON.stringify(scores, null, 2)
    );
    
    console.log('County scores calculated and saved successfully');
  } catch (error) {
    console.error('Error calculating scores:', error);
  }
};

main();