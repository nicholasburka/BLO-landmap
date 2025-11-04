const fs = require('fs');
const path = require('path');

function processCountyData(data) {
    // Calculate combined scores for all counties
    let combinedScores = [];
    let processedData = {...data};
    
    // First pass: calculate combined scores
    for (let countyId in data) {
        const scores = data[countyId].scores;
        let validScores = 0;
        let combinedScore = 0;
        
        // Count valid scores and sum them with appropriate weights
        // Invert contamination score so higher is better (6 - score maps 1->5, 5->1)
        if (scores.contaminationScore !== 0) {
            combinedScore += (6 - scores.contaminationScore);
            validScores++;
        }
        // Triple-weight percent Black (count it 3 times)
        if (scores.pctBlackScore !== 0) {
            combinedScore += scores.pctBlackScore * 3;
            validScores += 3;
        }
        if (scores.diversityIndexScore !== 0) {
            combinedScore += scores.diversityIndexScore;
            validScores++;
        }
        if (scores.lifeExpectancyScore !== 0) {
            combinedScore += scores.lifeExpectancyScore;
            validScores++;
        }
        
        // Normalize by number of valid scores
        if (validScores > 0) {
            combinedScore = combinedScore / validScores;
            combinedScores.push(combinedScore);
            processedData[countyId].combinedScore = combinedScore;
        }
    }
    
    // Calculate statistics
    const average = combinedScores.reduce((a, b) => a + b, 0) / combinedScores.length;
    const stdDev = Math.sqrt(
        combinedScores.reduce((sq, n) => sq + Math.pow(n - average, 2), 0) / combinedScores.length
    );
    
    // Sort scores for ranking
    const sortedScores = [...combinedScores].sort((a, b) => b - a);
    
    // Create a map of scores to count of counties with that score
    const scoreCountMap = {};
    combinedScores.forEach(score => {
        scoreCountMap[score] = (scoreCountMap[score] || 0) + 1;
    });
    
    // Second pass: add rankings, std dev scores, and count of counties with same rank
    for (let countyId in processedData) {
        if (processedData[countyId].combinedScore !== undefined) {
            const score = processedData[countyId].combinedScore;
            processedData[countyId].rankScore = sortedScores.indexOf(score) + 1;
            processedData[countyId].stdDevsFromMean = (score - average) / stdDev;
            processedData[countyId].countiesWithSameRank = scoreCountMap[score];
        }
    }
    
    // Add statistics to the output
    processedData.statistics = {
        average,
        standardDeviation: stdDev,
        totalCounties: combinedScores.length
    };
    
    return processedData;
}

// Read and process the data
const inputData = JSON.parse(fs.readFileSync(path.join(__dirname, '../source-data/computed/county_scores.json')));
const processedData = processCountyData(inputData);

// Write the results
fs.writeFileSync(path.join(__dirname, '../public/datasets/BLO-liveability-index/combined_scores.json'), JSON.stringify(processedData, null, 2));