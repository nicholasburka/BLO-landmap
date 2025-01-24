const fs = require('fs')
const path = require('path')
const turf = require('@turf/turf')
const topojson = require('topojson-client')

const contaminationLayers = [
  'acres_brownfields',
  'air_pollution_sources',
  'hazardous_waste_sites',
  'superfund_sites',
  'toxic_release_inventory'
]

const countiesData = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../public/datasets/counties-10m.json'), 'utf-8')
)
const countyContaminationCounts = {}

// Convert TopoJSON to GeoJSON
const counties = topojson.feature(countiesData, countiesData.objects.counties)
console.log(counties)
console.log(counties[0])
console.log(counties.features)

// Add after loading counties
const stateStats = counties.features.reduce((acc, county) => {
  const stateFIPS = county.id.substring(0, 2);
  // Map of FIPS codes to state names
  const fipsToState = {
    '01': 'Alabama', '02': 'Alaska', '04': 'Arizona', '05': 'Arkansas',
    '06': 'California', '08': 'Colorado', '09': 'Connecticut', '10': 'Delaware',
    '11': 'District of Columbia', '12': 'Florida', '13': 'Georgia', '15': 'Hawaii',
    '16': 'Idaho', '17': 'Illinois', '18': 'Indiana', '19': 'Iowa',
    '20': 'Kansas', '21': 'Kentucky', '22': 'Louisiana', '23': 'Maine',
    '24': 'Maryland', '25': 'Massachusetts', '26': 'Michigan', '27': 'Minnesota',
    '28': 'Mississippi', '29': 'Missouri', '30': 'Montana', '31': 'Nebraska',
    '32': 'Nevada', '33': 'New Hampshire', '34': 'New Jersey', '35': 'New Mexico',
    '36': 'New York', '37': 'North Carolina', '38': 'North Dakota', '39': 'Ohio',
    '40': 'Oklahoma', '41': 'Oregon', '42': 'Pennsylvania', '44': 'Rhode Island',
    '45': 'South Carolina', '46': 'South Dakota', '47': 'Tennessee', '48': 'Texas',
    '49': 'Utah', '50': 'Vermont', '51': 'Virginia', '53': 'Washington',
    '54': 'West Virginia', '55': 'Wisconsin', '56': 'Wyoming'
  };
  
  const stateName = fipsToState[stateFIPS];
  if (stateName) {
    acc[stateName] = (acc[stateName] || 0) + 1;
  } else {
    console.log('Unknown state FIPS code:', stateFIPS, 'for county:', county.properties.name);
  }
  return acc;
}, {});

console.log('\nMap boundary coverage:');
console.log('Total states:', Object.keys(stateStats).length);
console.log('\nStates and their county counts in GeoJSON:');
console.log(stateStats);

// Find missing states
const censusStates = new Set([
  'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 
  'Colorado', 'Connecticut', 'Delaware', 'District of Columbia', 
  'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 
  'Iowa', 'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland', 
  'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi', 'Missouri', 
  'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey', 
  'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio', 
  'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina', 
  'South Dakota', 'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia', 
  'Washington', 'West Virginia', 'Wisconsin', 'Wyoming'
]);

const missingStates = Array.from(censusStates)
  .filter(state => !stateStats[state])
  .sort();

console.log('\nStates missing from map boundaries:');
console.log(missingStates);

// After loading counties data
console.log('Sample Colorado counties from map:', 
  counties.features
    .filter(f => f.id.startsWith('08')) // 08 is Colorado's FIPS code
    .slice(0, 5)
    .map(f => ({
      id: f.id,
      name: f.properties.name
    }))
);

contaminationLayers.forEach((layer) => {
  const data = JSON.parse(
    fs.readFileSync(path.join(__dirname, `../public/datasets/${layer}.geojson`), 'utf-8')
  )
  data.features.forEach((feature) => {
    const point = turf.point(feature.geometry.coordinates)
    const county = findCounty(point, counties)
    if (county) {
      const countyId = county.id
      if (!countyContaminationCounts[countyId]) {
        countyContaminationCounts[countyId] = {
          total: 0,
          layers: {}
        }
      }
      countyContaminationCounts[countyId].total += 1
      countyContaminationCounts[countyId].layers[layer] =
        (countyContaminationCounts[countyId].layers[layer] || 0) + 1
    }
  })
})

fs.writeFileSync(
  path.join(__dirname, '../public/datasets/new_contamination_counts.json'),
  JSON.stringify(countyContaminationCounts)
)

function findCounty(point, counties) {
  //console.log(point)
  for (const county of counties.features) {
    //console.log(county)
    if (turf.booleanPointInPolygon(point, county)) {
      //console.log('found point in county ' + county.properties.name)
      return county
    }
  }
  //console.log('could not find a county')
  return null
}
