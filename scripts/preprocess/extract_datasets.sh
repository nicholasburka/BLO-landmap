#!/bin/bash

# BLO Data Integration - Dataset Extraction Script
# This script extracts zipped datasets from source-data folder

set -e  # Exit on error

echo "========================================="
echo "BLO Dataset Extraction Script"
echo "========================================="
echo ""

# Define paths
SOURCE_DIR="source-data"
OUTPUT_DIR="source-data"

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to extract a zip file
extract_zip() {
    local zip_path=$1
    local output_path=$2
    local description=$3

    echo -e "${BLUE}Extracting:${NC} $description"
    echo "  From: $zip_path"
    echo "  To: $output_path"

    if [ -f "$zip_path" ]; then
        unzip -o "$zip_path" -d "$output_path"
        echo -e "${GREEN}✓ Extracted successfully${NC}"
        echo ""
    else
        echo -e "${YELLOW}⚠ File not found: $zip_path${NC}"
        echo ""
    fi
}

# Extract Median Home Value
echo "1. Extracting Median Home Value Data"
echo "-------------------------------------"
extract_zip \
    "$SOURCE_DIR/MEDIAN VALUE of OWNER OCCUPIED MORTGAGES/explore_data_hom_06.zip" \
    "$SOURCE_DIR/MEDIAN VALUE of OWNER OCCUPIED MORTGAGES/" \
    "Median Home Value"

# Extract Median Property Tax
echo "2. Extracting Median Property Tax Data"
echo "---------------------------------------"
extract_zip \
    "$SOURCE_DIR/MEDIAN REAL ESTATE TAXES OF OWNER - OCCUPIED MORTGAGES/explore_data_hom_08.zip" \
    "$SOURCE_DIR/MEDIAN REAL ESTATE TAXES OF OWNER - OCCUPIED MORTGAGES/" \
    "Median Property Tax"

# Extract Racial Progress datasets
echo "3. Extracting Racial Progress Datasets"
echo "---------------------------------------"

# Check and extract each racial progress dataset
RACIAL_PROGRESS_DIR="$SOURCE_DIR/RACIAL PROGRESS"

# Debt to Income
if [ -d "$RACIAL_PROGRESS_DIR/Debt to Income Ratio for Households" ]; then
    for zipfile in "$RACIAL_PROGRESS_DIR/Debt to Income Ratio for Households"/*.zip; do
        if [ -f "$zipfile" ]; then
            extract_zip "$zipfile" "$(dirname "$zipfile")" "Debt to Income Ratio"
        fi
    done
fi

# Homeownership Rate
if [ -d "$RACIAL_PROGRESS_DIR/Homeownership Rate by Race_Ehtnicity" ]; then
    for zipfile in "$RACIAL_PROGRESS_DIR/Homeownership Rate by Race_Ehtnicity"/*.zip; do
        if [ -f "$zipfile" ]; then
            extract_zip "$zipfile" "$(dirname "$zipfile")" "Homeownership Rate"
        fi
    done
fi

# Poverty Rate
if [ -d "$RACIAL_PROGRESS_DIR/Percent Poverty (by Race_Ethnicity)" ]; then
    for zipfile in "$RACIAL_PROGRESS_DIR/Percent Poverty (by Race_Ethnicity)"/*.zip; do
        if [ -f "$zipfile" ]; then
            extract_zip "$zipfile" "$(dirname "$zipfile")" "Poverty Rate"
        fi
    done
fi

# Racial Equity Index
if [ -d "$RACIAL_PROGRESS_DIR/Racial Equity Index (National Equity Index)" ]; then
    for zipfile in "$RACIAL_PROGRESS_DIR/Racial Equity Index (National Equity Index)"/*.zip; do
        if [ -f "$zipfile" ]; then
            extract_zip "$zipfile" "$(dirname "$zipfile")" "Racial Equity Index"
        fi
    done
fi

# Black Progress Index
if [ -d "$RACIAL_PROGRESS_DIR/The Black Progress Index (NAACPxBrookings)" ]; then
    for zipfile in "$RACIAL_PROGRESS_DIR/The Black Progress Index (NAACPxBrookings)"/*.zip; do
        if [ -f "$zipfile" ]; then
            extract_zip "$zipfile" "$(dirname "$zipfile")" "Black Progress Index"
        fi
    done
fi

echo "========================================="
echo -e "${GREEN}Extraction Complete!${NC}"
echo "========================================="
echo ""
echo "Next steps:"
echo "1. Run: python3 scripts/preprocess/convert_svi_gdb.py"
echo "2. Run: node scripts/preprocess/standardize_datasets.cjs"
echo ""
