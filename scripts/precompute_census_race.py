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

    # Calculate total Black population (Hispanic + Non-Hispanic)
    total_black = group['BA_MALE'].sum() + group['BA_FEMALE'].sum()

    sum_squares = sum((n / total_pop) ** 2 for n in races.values() if n > 0)
    diversity_index = 1 - sum_squares
    pct_nhBlack = (races['NH_Black'] / total_pop) * 100 if total_pop > 0 else 0
    pct_Black = (total_black / total_pop) * 100 if total_pop > 0 else 0


    result = {
        'diversity_index': diversity_index,
        'total_population': total_pop,
        'pct_nhBlack': pct_nhBlack,
        'pct_Black': pct_Black,
        'total_Black': total_black
    }
    result.update(races)
    return pd.Series(result)


# Read the CSV file
df = pd.read_csv('../source-data/census/countyCensus-est2023-alldata.csv', encoding='latin-1')

# Census PEP file ships every county once per (YEAR, AGEGRP) combination —
# 5 vintages (1=Apr 2020 base, 2=2020, 3=2021, 4=2022, 5=2023) × 19 age
# groups (0=total, 1-18=brackets). The original groupby summed all 95 rows
# per county, inflating populations ~10x (Wake County ended up at 11.5M
# instead of 1.19M). Filter to the latest vintage + total age group BEFORE
# aggregating so each county contributes exactly one row.
LATEST_YEAR = df['YEAR'].max()  # 5 in the 2023 vintage file
df = df[(df['YEAR'] == LATEST_YEAR) & (df['AGEGRP'] == 0)].copy()
print(f"Filtered to YEAR={LATEST_YEAR}, AGEGRP=0: {len(df)} county rows")

# Group by county and calculate diversity index and aggregate statistics
county_diversity = df.groupby(['STATE', 'COUNTY', 'STNAME', 'CTYNAME']).apply(calculate_diversity_index).reset_index()

# Create GEOID column
county_diversity['GEOID'] = county_diversity['STATE'].astype(str).str.zfill(2) + county_diversity['COUNTY'].astype(str).str.zfill(3)


# Sort by diversity index in descending order
county_diversity = county_diversity.sort_values('diversity_index', ascending=False)

# Display the results
print(county_diversity)

# Save to a new CSV file
county_diversity.to_csv('../public/datasets/demographics/county_pctBlack_diversity_index_with_stats.csv', index=False)

# Add after line 38 in precompute_census_race.py
# Print state coverage statistics
state_counts = county_diversity.groupby('STNAME').size()
print("\nState Coverage:")
print(f"Total states: {len(state_counts)}")
print("\nStates and their county counts:")
print(state_counts)

# Check for any states with zero counties
all_states = df['STNAME'].unique()
states_with_data = county_diversity['STNAME'].unique()
missing_states = set(all_states) - set(states_with_data)
if missing_states:
    print("\nStates with no county data:")
    print(missing_states)