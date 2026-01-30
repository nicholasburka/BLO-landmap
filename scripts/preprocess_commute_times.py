#!/usr/bin/env python3
"""
Preprocess commute times data by mapping county names to FIPS codes.
Outputs a CSV file ready for map integration.
"""

import csv
import json
import os
from pathlib import Path

# State name to FIPS code mapping
STATE_FIPS = {
    'Alabama': '01', 'Alaska': '02', 'Arizona': '04', 'Arkansas': '05',
    'California': '06', 'Colorado': '08', 'Connecticut': '09', 'Delaware': '10',
    'District of Columbia': '11', 'Florida': '12', 'Georgia': '13', 'Hawaii': '15',
    'Idaho': '16', 'Illinois': '17', 'Indiana': '18', 'Iowa': '19',
    'Kansas': '20', 'Kentucky': '21', 'Louisiana': '22', 'Maine': '23',
    'Maryland': '24', 'Massachusetts': '25', 'Michigan': '26', 'Minnesota': '27',
    'Mississippi': '28', 'Missouri': '29', 'Montana': '30', 'Nebraska': '31',
    'Nevada': '32', 'New Hampshire': '33', 'New Jersey': '34', 'New Mexico': '35',
    'New York': '36', 'North Carolina': '37', 'North Dakota': '38', 'Ohio': '39',
    'Oklahoma': '40', 'Oregon': '41', 'Pennsylvania': '42', 'Rhode Island': '44',
    'South Carolina': '45', 'South Dakota': '46', 'Tennessee': '47', 'Texas': '48',
    'Utah': '49', 'Vermont': '50', 'Virginia': '51', 'Washington': '53',
    'West Virginia': '54', 'Wisconsin': '55', 'Wyoming': '56', 'Puerto Rico': '72'
}

# Commute time category to ordinal mapping (1 = shortest, 12 = longest)
COMMUTE_TIME_ORDINAL = {
    'Less than 5 minutes': 1,
    '5 to 9 minutes': 2,
    '10 to 14 minutes': 3,
    '15 to 19 minutes': 4,
    '20 to 24 minutes': 5,
    '25 to 29 minutes': 6,
    '30 to 34 minutes': 7,
    '35 to 39 minutes': 8,
    '40 to 44 minutes': 9,
    '45 to 59 minutes': 10,
    '60 to 89 minutes': 11,
    '90 or more minutes': 12
}


def normalize_county_name(name):
    """Normalize county name for matching."""
    name = name.strip().lower()
    # Remove common suffixes for matching
    for suffix in [' county', ' parish', ' borough', ' census area',
                   ' municipality', ' city and borough', ' city']:
        if name.endswith(suffix):
            name = name[:-len(suffix)]
    return name


def build_fips_lookup(geojson_path):
    """Build a lookup table from (state_fips, normalized_county_name) -> GEOID."""
    with open(geojson_path, 'r') as f:
        data = json.load(f)

    lookup = {}
    for feature in data['features']:
        props = feature['properties']
        geoid = props['GEOID']
        state_fips = props['STATEFP']
        county_name = normalize_county_name(props['NAME'])

        key = (state_fips, county_name)
        lookup[key] = geoid

    return lookup


def process_commute_data(input_path, geojson_path, output_path):
    """Process commute times CSV and add FIPS codes."""

    # Build FIPS lookup
    fips_lookup = build_fips_lookup(geojson_path)
    print(f"Built FIPS lookup with {len(fips_lookup)} counties")

    # Process commute data
    matched = 0
    unmatched = []
    output_rows = []

    with open(input_path, 'r') as f:
        reader = csv.DictReader(f)

        for row in reader:
            # Skip non-county records
            if row['geo_level'] != 'county':
                continue

            state_name = row['state_name']
            if not state_name or state_name not in STATE_FIPS:
                unmatched.append(f"Unknown state: {state_name}")
                continue

            state_fips = STATE_FIPS[state_name]

            # Parse county name from geo_name (format: "County Name, State")
            geo_name = row['geo_name']
            if ',' in geo_name:
                county_part = geo_name.rsplit(',', 1)[0].strip()
            else:
                county_part = geo_name.strip()

            normalized_county = normalize_county_name(county_part)

            # Look up FIPS
            key = (state_fips, normalized_county)
            if key not in fips_lookup:
                # Try alternative lookups for edge cases
                geoid = None

                # Try with "city" suffix for Virginia independent cities
                if state_fips == '51':
                    for alt_key, alt_geoid in fips_lookup.items():
                        if alt_key[0] == '51' and normalized_county in alt_key[1]:
                            geoid = alt_geoid
                            break

                if not geoid:
                    unmatched.append(f"{county_part}, {state_name}")
                    continue
            else:
                geoid = fips_lookup[key]

            matched += 1

            # Get ordinal value for commute time
            commute_time = row['most_frequent_commute_time']
            commute_ordinal = COMMUTE_TIME_ORDINAL.get(commute_time, 0)

            # Build output row
            output_row = {
                'GEOID': geoid,
                'county_name': county_part,
                'state_name': state_name,
                'year': row['year'],
                'most_frequent_commute_time': commute_time,
                'commute_time_ordinal': commute_ordinal,
                'pct_drove_alone': row['pct_workers_16andover_drove_alone_black_alone'] or '',
                'pct_carpooled': row['pct_workers_16andover_carpooled_in_car_truck_van_black_alone'] or '',
                'pct_public_transit': row['pct_workers_16andover_public_transportation_black_alone'] or '',
                'pct_black': row['pct_black_alone'] or ''
            }
            output_rows.append(output_row)

    # Write output
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    fieldnames = ['GEOID', 'county_name', 'state_name', 'year',
                  'most_frequent_commute_time', 'commute_time_ordinal',
                  'pct_drove_alone', 'pct_carpooled', 'pct_public_transit', 'pct_black']

    with open(output_path, 'w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(output_rows)

    print(f"\nResults:")
    print(f"  Matched: {matched}")
    print(f"  Unmatched: {len(unmatched)}")
    print(f"  Match rate: {matched / (matched + len(unmatched)) * 100:.1f}%")
    print(f"\nOutput written to: {output_path}")

    if unmatched:
        print(f"\nFirst 20 unmatched counties:")
        for county in unmatched[:20]:
            print(f"  - {county}")

    return matched, len(unmatched)


if __name__ == '__main__':
    # Paths
    base_dir = Path(__file__).parent.parent
    input_path = base_dir / 'source-data' / 'commute-times' / 'emp_06.csv'
    geojson_path = base_dir / 'public' / 'datasets' / 'geographic' / 'counties.geojson'
    output_path = base_dir / 'public' / 'datasets' / 'transportation' / 'commute_times.csv'

    print(f"Input: {input_path}")
    print(f"GeoJSON: {geojson_path}")
    print(f"Output: {output_path}")
    print()

    process_commute_data(input_path, geojson_path, output_path)
