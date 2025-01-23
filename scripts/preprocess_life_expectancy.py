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