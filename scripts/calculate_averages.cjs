const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');

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

// Function to load JSON data
const loadJSONData = (filePath) => {
  return new Promise((resolve, reject) => {
    fs.readFile(filePath, 'utf-8', (err, data) => {
      if (err) {
        return reject(err);
      }
      resolve(JSON.parse(data));
    });
  });
};

// Load the necessary data files
const loadData = async () => {
  const diversityData = await loadCSVData(path.join(__dirname, '../public/datasets/demographics/county_pctBlack_diversity_index_with_stats.csv'));
  const lifeExpectancyData = await loadCSVData(path.join(__dirname, '../public/datasets/demographics/lifeexpectancy-USA-county.csv'));
  const contaminationCounts = await loadJSONData(path.join(__dirname, '../source-data/computed/new_contamination_counts.json'));

  return { diversityData, lifeExpectancyData, contaminationCounts };
};

const calculateAverages = (contaminationCounts) => {
  const contaminationAverages = {};
  const totalCounties = Object.keys(contaminationCounts).length;

  // Calculate average contamination sources
  for (const countyId in contaminationCounts) {
    const data = contaminationCounts[countyId];
    if (!contaminationAverages[data.id]) {
      contaminationAverages[data.id] = {
        total: 0,
        layers: {},
        count: 0
      };
    }
    contaminationAverages[data.id].total += data.total;
    contaminationAverages[data.id].count += 1;

    for (const layer in data.layers) {
      if (!contaminationAverages[data.id].layers[layer]) {
        contaminationAverages[data.id].layers[layer] = 0;
      }
      contaminationAverages[data.id].layers[layer] += data.layers[layer];
    }
  }

  // Calculate averages
  for (const countyId in contaminationAverages) {
    contaminationAverages[countyId].averageTotal = contaminationAverages[countyId].total / contaminationAverages[countyId].count;
    for (const layer in contaminationAverages[countyId].layers) {
      contaminationAverages[countyId].layers[layer] /= contaminationAverages[countyId].count;
    }
  }

  return contaminationAverages;
};

const calculateDemographicAverages = (diversityData, lifeExpectancyData) => {
  const demographicAverages = {
    avgBlackPct: 0,
    avgDiversityIndex: 0,
    avgLifeExpectancy: 0,
    totalCounties: 0
  };

  let totalBlackPct = 0;
  let totalDiversityIndex = 0;
  const blackPctValues = [];
  const diversityIndexValues = [];

  for (const data of diversityData) {
    if (data.pct_nhBlack !== null && data.pct_nhBlack !== undefined) {
      const blackPct = parseFloat(data.pct_nhBlack);
      totalBlackPct += blackPct;
      blackPctValues.push(blackPct);
    }
    if (data.diversity_index !== null && data.diversity_index !== undefined) {
      const diversityIndex = parseFloat(data.diversity_index);
      totalDiversityIndex += diversityIndex;
      diversityIndexValues.push(diversityIndex);
    }
    demographicAverages.totalCounties += 1;
  }

  if (demographicAverages.totalCounties > 0) {
    demographicAverages.avgBlackPct = totalBlackPct / demographicAverages.totalCounties;
    demographicAverages.avgDiversityIndex = totalDiversityIndex / demographicAverages.totalCounties;
  }

  for (const data of lifeExpectancyData) {
    demographicAverages.avgLifeExpectancy += parseFloat(data['e(0)']);
  }

  if (lifeExpectancyData.length > 0) {
    demographicAverages.avgLifeExpectancy /= lifeExpectancyData.length;
  }

  // Calculate standard deviations
  demographicAverages.stdDevBlackPct = calculateStandardDeviation(blackPctValues, demographicAverages.avgBlackPct);
  demographicAverages.stdDevDiversityIndex = calculateStandardDeviation(diversityIndexValues, demographicAverages.avgDiversityIndex);

  // Calculate thresholds for one and two standard deviations
  demographicAverages.blackPctThresholds = {
    oneStdDevAbove: demographicAverages.avgBlackPct + demographicAverages.stdDevBlackPct,
    twoStdDevAbove: demographicAverages.avgBlackPct + 2 * demographicAverages.stdDevBlackPct,
    oneStdDevBelow: demographicAverages.avgBlackPct - demographicAverages.stdDevBlackPct,
    twoStdDevBelow: demographicAverages.avgBlackPct - 2 * demographicAverages.stdDevBlackPct
  };

  demographicAverages.diversityIndexThresholds = {
    oneStdDevAbove: demographicAverages.avgDiversityIndex + demographicAverages.stdDevDiversityIndex,
    twoStdDevAbove: demographicAverages.avgDiversityIndex + 2 * demographicAverages.stdDevDiversityIndex,
    oneStdDevBelow: demographicAverages.avgDiversityIndex - demographicAverages.stdDevDiversityIndex,
    twoStdDevBelow: demographicAverages.avgDiversityIndex - 2 * demographicAverages.stdDevDiversityIndex
  };

  return demographicAverages;
};

const calculateContaminationAverages = (contaminationCounts) => {
  const contaminationValues = [];
  const contaminationAverages = {
    avgContamination: 0,
    totalCounties: 0
  };

  for (const countyId in contaminationCounts) {
    const data = contaminationCounts[countyId];
    contaminationValues.push(data.total);
    contaminationAverages.totalCounties += 1;
  }

  if (contaminationAverages.totalCounties > 0) {
    contaminationAverages.avgContamination = contaminationValues.reduce((a, b) => a + b, 0) / contaminationAverages.totalCounties;
  }

  // Calculate standard deviation for contamination
  contaminationAverages.stdDevContamination = calculateStandardDeviation(contaminationValues, contaminationAverages.avgContamination);

  // Calculate thresholds for one and two standard deviations
  contaminationAverages.contaminationThresholds = {
    oneStdDevAbove: contaminationAverages.avgContamination + contaminationAverages.stdDevContamination,
    twoStdDevAbove: contaminationAverages.avgContamination + 2 * contaminationAverages.stdDevContamination,
    oneStdDevBelow: contaminationAverages.avgContamination - contaminationAverages.stdDevContamination,
    twoStdDevBelow: contaminationAverages.avgContamination - 2 * contaminationAverages.stdDevContamination
  };

  return contaminationAverages;
};

const calculateStandardDeviation = (values, mean) => {
  const variance = values.reduce((acc, value) => acc + Math.pow(value - mean, 2), 0) / values.length;
  return Math.sqrt(variance);
};

const main = async () => {
  const { diversityData, lifeExpectancyData, contaminationCounts } = await loadData();
  
  const contaminationAverages = calculateAverages(contaminationCounts);
  const demographicAverages = calculateDemographicAverages(diversityData, lifeExpectancyData);
  const contaminationStats = calculateContaminationAverages(contaminationCounts);

  // Combine results
  const results = {
    contaminationAverages,
    demographicAverages,
    contaminationStats
  };

  // Save to a new output file
  fs.writeFileSync(path.join(__dirname, '../source-data/computed/averages.json'), JSON.stringify(results, null, 2));
  console.log('Averages calculated and saved to averages.json');
};

// Run the main function
main().catch(error => console.error('Error calculating averages:', error));