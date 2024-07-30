import pandas as pd
import numpy as np

def calculate_diversity_index(group):
    total_pop = group['TOT_POP'].sum()
    
    if total_pop == 0:
        return pd.Series({'diversity_index': 0, 'total_population': 0})
    
    races = {
        'NH_White': group['NHWA_MALE'].sum() + group['NHWA_FEMALE'].sum(),
        'NH_Black': group['NHBA_MALE'].sum() + group['NHBA_FEMALE'].sum(),
        'NH_AmIndian': group['NHIA_MALE'].sum() + group['NHIA_FEMALE'].sum(),
        'NH_Asian': group['NHAA_MALE'].sum() + group['NHAA_FEMALE'].sum(),
        'NH_PacIslander': group['NHNA_MALE'].sum() + group['NHNA_FEMALE'].sum(),
        'NH_TwoOrMore': group['NHTOM_MALE'].sum() + group['NHTOM_FEMALE'].sum(),
        'Hispanic': group['H_MALE'].sum() + group['H_FEMALE'].sum()
    }
    
    sum_squares = sum((n / total_pop) ** 2 for n in races.values() if n > 0)
    diversity_index = 1 - sum_squares
    
    result = {
        'diversity_index': diversity_index,
        'total_population': total_pop
    }
    result.update(races)
    return pd.Series(result)


# Read the CSV file
df = pd.read_csv('/Users/mac/Desktop/BLO/map/BLO-landmap/public/datasets/countyCensus-est2023-alldata.csv', encoding='latin-1')

# Group by county and calculate diversity index and aggregate statistics
county_diversity = df.groupby(['STATE', 'COUNTY', 'STNAME', 'CTYNAME']).apply(calculate_diversity_index).reset_index()

# Create GEOID column
county_diversity['GEOID'] = county_diversity['STATE'].astype(str).str.zfill(2) + county_diversity['COUNTY'].astype(str).str.zfill(3)


# Sort by diversity index in descending order
county_diversity = county_diversity.sort_values('diversity_index', ascending=False)

# Display the results
print(county_diversity)

# Save to a new CSV file
county_diversity.to_csv('county_diversity_index_with_stats.csv', index=False)