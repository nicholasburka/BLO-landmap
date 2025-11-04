#!/usr/bin/env python3
"""
BLO Data Integration - SVI Geodatabase Conversion Script
This script converts the CDC Social Vulnerability Index geodatabase to CSV format.
"""

import os
import sys

def check_dependencies():
    """Check if required packages are installed."""
    try:
        import geopandas as gpd
        import pandas as pd
        return True
    except ImportError as e:
        print("Error: Missing required packages.")
        print("\nPlease install required packages:")
        print("  pip install geopandas pandas")
        print("\nNote: GeoPandas requires GDAL/OGR to read .gdb files")
        print("On macOS: brew install gdal")
        print("On Ubuntu: sudo apt-get install gdal-bin python3-gdal")
        return False

def convert_svi_geodatabase():
    """Convert SVI geodatabase to CSV."""
    import geopandas as gpd
    import pandas as pd

    print("=" * 60)
    print("SVI Geodatabase Conversion Script")
    print("=" * 60)
    print()

    # Define paths
    gdb_path = "source-data/SVI2022_US_county.gdb"
    output_dir = "public/datasets/social-vulnerability"
    output_file = os.path.join(output_dir, "svi_2022_county.csv")

    # Check if geodatabase exists
    if not os.path.exists(gdb_path):
        print(f"Error: Geodatabase not found at {gdb_path}")
        sys.exit(1)

    print(f"Reading geodatabase: {gdb_path}")
    print("This may take a moment...")
    print()

    try:
        # List available layers
        layers = gpd.list_layers(gdb_path)
        print(f"Available layers: {[layer[0] for layer in layers]}")
        print()

        # Read the main SVI layer
        # Try common layer names
        layer_names = ["SVI2022_US_county", "SVI2022_US", "SVI_2022_US_county"]
        gdf = None

        for layer_name in layer_names:
            try:
                print(f"Attempting to read layer: {layer_name}")
                gdf = gpd.read_file(gdb_path, layer=layer_name)
                print(f"✓ Successfully read layer: {layer_name}")
                break
            except Exception as e:
                print(f"  Layer '{layer_name}' not found, trying next...")
                continue

        if gdf is None:
            # If no standard name works, use the first layer
            first_layer = layers[0][0]
            print(f"\nUsing first available layer: {first_layer}")
            gdf = gpd.read_file(gdb_path, layer=first_layer)

        print()
        print(f"Loaded {len(gdf)} counties")
        print(f"Columns: {len(gdf.columns)}")
        print()

        # Display first few column names
        print("Sample columns:")
        for col in list(gdf.columns)[:10]:
            print(f"  - {col}")
        print()

        # Create output directory if it doesn't exist
        os.makedirs(output_dir, exist_ok=True)

        # Convert to DataFrame (drop geometry)
        df = pd.DataFrame(gdf.drop(columns=['geometry']))

        # Save to CSV
        print(f"Saving to: {output_file}")
        df.to_csv(output_file, index=False)

        print()
        print("=" * 60)
        print("✓ Conversion Complete!")
        print("=" * 60)
        print()
        print(f"Output file: {output_file}")
        print(f"Rows: {len(df)}")
        print(f"Columns: {len(df.columns)}")
        print()

        # Display key SVI columns if they exist
        svi_columns = [col for col in df.columns if 'RPL' in col or 'SPL' in col or 'FIPS' in col or 'ST_ABBR' in col]
        if svi_columns:
            print("Key SVI columns found:")
            for col in svi_columns[:15]:
                print(f"  - {col}")
            if len(svi_columns) > 15:
                print(f"  ... and {len(svi_columns) - 15} more")
        print()

    except Exception as e:
        print(f"\nError during conversion: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

def main():
    """Main function."""
    if not check_dependencies():
        sys.exit(1)

    convert_svi_geodatabase()

    print("Next steps:")
    print("1. Review the output CSV file")
    print("2. Identify the key SVI columns to use")
    print("3. Run: node scripts/preprocess/standardize_datasets.cjs")
    print()

if __name__ == "__main__":
    main()
