import pandas as pd
import numpy as np

# Read the CSV file
df = pd.read_csv('dist/datasets/lifeexpectancy-USA.csv')

# Create GEOID by padding state and county codes with zeros
df['GEOID'] = (df['STATE2KX'].astype(str).str.zfill(2) + 
               df['CNTY2KX'].astype(str).str.zfill(3))

# Group by GEOID and calculate aggregates
county_data = df.groupby('GEOID').agg({
    'e(0)': 'mean',  # Simple mean for life expectancy
    'se(e(0))': lambda x: np.sqrt(np.mean(x**2))  # Root mean square for standard errors
}).reset_index()

# Round to 1 decimal place for life expectancy and 4 decimal places for standard error
county_data['e(0)'] = county_data['e(0)'].round(1)
county_data['se(e(0))'] = county_data['se(e(0))'].round(4)

# Add back state and county codes
county_data['STATE2KX'] = county_data['GEOID'].str[:2].astype(int)
county_data['CNTY2KX'] = county_data['GEOID'].str[2:].astype(int)

# Reorder columns
county_data = county_data[['GEOID', 'STATE2KX', 'CNTY2KX', 'e(0)', 'se(e(0))']]

# Save to CSV in the public folder
county_data.to_csv('public/datasets/lifeexpectancy-USA-county.csv', index=False)

# After creating GEOIDs
# Check Colorado data
colorado_data = df[df['STATE2KX'] == 8]  # Colorado is FIPS 08
print("\nColorado counties in life expectancy data:")
print(colorado_data[['GEOID', 'e(0)']].head())
print(f"Total Colorado counties: {len(colorado_data)}")

# Check GEOID format
print("\nSample GEOIDs:")
print(county_data['GEOID'].head())
print("\nGEOID lengths:", county_data['GEOID'].str.len().value_counts())