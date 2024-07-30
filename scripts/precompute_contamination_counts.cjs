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
