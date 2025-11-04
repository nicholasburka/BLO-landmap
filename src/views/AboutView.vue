<template>
  <div class="about">
    <div class="about-content">
      <h1>About the BLO Liveability Index</h1>

      <section class="intro-section">
        <p>
          The <strong>BLO Liveability Index</strong> is an interactive mapping tool designed to help Black Americans
          identify the most favorable counties for living, working, and building wealth across the United States.
        </p>
        <p>
          By combining data from diverse sources—including demographic information, health outcomes, economic indicators,
          housing affordability, environmental quality, and racial equity measures—this tool provides a comprehensive
          view of county-level conditions that impact Black liveability.
        </p>
      </section>

      <section class="methodology-section">
        <h2>How the BLO Liveability Index is Calculated</h2>

        <p>
          The BLO Liveability Index is a <strong>weighted composite score (0-5)</strong> that combines 11 normalized
          metrics across 6 key dimensions. Each metric is normalized to a 0-1 scale and weighted according to a roughly estimated "relative importance" in determining overall liveability for Black Americans.
        </p>

        <table class="metrics-table">
          <thead>
            <tr>
              <th>Category</th>
              <th>Weight</th>
              <th>Metrics</th>
            </tr>
          </thead>
          <tbody>
            <tr class="category-demographics">
              <td><strong>Demographics</strong></td>
              <td>20%</td>
              <td>
                Diversity Index (10%)<br>
                Percent Black Population (10%)
              </td>
            </tr>
            <tr class="category-health">
              <td><strong>Health</strong></td>
              <td>10%</td>
              <td>Life Expectancy (10%)</td>
            </tr>
            <tr class="category-environment">
              <td><strong>Environment</strong></td>
              <td>5%</td>
              <td>EPA Contamination Sites (5%)</td>
            </tr>
            <tr class="category-economic">
              <td><strong>Economic Opportunity</strong></td>
              <td>20%</td>
              <td>
                Average Weekly Wage (10%)<br>
                Median Household Income (Black) (10%)
              </td>
            </tr>
            <tr class="category-housing">
              <td><strong>Housing Affordability</strong></td>
              <td>20%</td>
              <td>
                Median Home Value (10%)<br>
                Median Property Tax (5%)<br>
                Black Homeownership Rate (5%)
              </td>
            </tr>
            <tr class="category-equity">
              <td><strong>Racial Equity</strong></td>
              <td>25%</td>
              <td>
                Poverty Rate (Black) (10%)<br>
                Black Progress Index (15%)
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section class="datasets-section">
        <h2>Data Sources</h2>

        <p>
          The BLO Liveability Index draws from multiple authoritative sources to provide a comprehensive
          and accurate picture of county-level conditions:
        </p>

        <div class="dataset-group">
          <h3>Demographics & Population</h3>
          <div class="dataset-item">
            <h4>US Census Bureau</h4>
            <p>
              Provides diversity index, percent Black population, and total population data from the
              American Community Survey 5-year estimates (2023).
            </p>
            <a href="https://www.census.gov/" target="_blank" rel="noopener">census.gov</a>
          </div>
        </div>

        <div class="dataset-group">
          <h3>Health</h3>
          <div class="dataset-item">
            <h4>Institute for Health Metrics and Evaluation (IHME)</h4>
            <p>
              County-level life expectancy data (2014) based on mortality rates and population estimates.
            </p>
            <a href="https://www.healthdata.org/" target="_blank" rel="noopener">healthdata.org</a>
          </div>
        </div>

        <div class="dataset-group">
          <h3>Environment</h3>
          <div class="dataset-item">
            <h4>Environmental Protection Agency (EPA)</h4>
            <p>
              Aggregated contamination site counts from EPA Envirofacts (2024) including Superfund sites,
              hazardous waste facilities, toxic release inventory sites, brownfields, and air pollution sources.
            </p>
            <a href="https://www.epa.gov/enviro" target="_blank" rel="noopener">epa.gov/enviro</a>
          </div>
        </div>

        <div class="dataset-group">
          <h3>Economic Indicators</h3>
          <div class="dataset-item">
            <h4>US Bureau of Labor Statistics (BLS)</h4>
            <p>
              Average weekly wages from Quarterly Census of Employment and Wages (QCEW) data (2023).
            </p>
            <a href="https://www.bls.gov/cew/" target="_blank" rel="noopener">bls.gov/cew</a>
          </div>
          <div class="dataset-item">
            <h4>Urban Institute - Diversity Data Kids</h4>
            <p>
              Race-specific median household income for Black households from American Community Survey (2022).
            </p>
            <a href="https://data.diversitydatakids.org/" target="_blank" rel="noopener">diversitydatakids.org</a>
          </div>
        </div>

        <div class="dataset-group">
          <h3>Housing & Affordability</h3>
          <div class="dataset-item">
            <h4>Urban Institute - Diversity Data Kids</h4>
            <p>
              Median home values, median property taxes, and Black homeownership rates from American Community
              Survey 5-year estimates (2022). Black homeownership data includes only counties with 50+ Black
              residents for statistical reliability.
            </p>
            <a href="https://data.diversitydatakids.org/" target="_blank" rel="noopener">diversitydatakids.org</a>
          </div>
        </div>

        <div class="dataset-group">
          <h3>Racial Equity</h3>
          <div class="dataset-item">
            <h4>Urban Institute - Diversity Data Kids</h4>
            <p>
              Poverty rates for Black individuals from American Community Survey (2022).
            </p>
            <a href="https://data.diversitydatakids.org/" target="_blank" rel="noopener">diversitydatakids.org</a>
          </div>
          <div class="dataset-item">
            <h4>NAACP & Brookings Institution</h4>
            <p>
              The Black Progress Index (2020) combines 8 indicators: Black life expectancy, low birth weight rate,
              math proficiency, bachelor's degree attainment, homeownership rate, business ownership rate, median
              household income, and Black population percentage.
            </p>
            <a href="https://www.brookings.edu/" target="_blank" rel="noopener">brookings.edu</a>
          </div>
        </div>
      </section>

      <section class="usage-section">
        <h2>How to Use This Tool</h2>
        <ol>
          <li>
            <strong>Explore the Map:</strong> Click on any county to view detailed statistics and see how it
            compares to national averages.
          </li>
          <li>
            <strong>Layer Controls:</strong> Toggle different data layers to visualize specific metrics like
            median income, homeownership rates, or environmental quality.
          </li>
          <li>
            <strong>Color Coding:</strong> Generally, greener counties indicate better conditions while redder
            counties indicate challenges. Some metrics (like home values) use inverse scales where lower is better
            for affordability.
          </li>
          <li>
            <strong>National Averages:</strong> County statistics show differences from national averages with
            color-coded indicators to help you identify above or below average conditions.
          </li>
        </ol>
      </section>

      <section class="disclaimer-section">
        <h2>Disclaimer</h2>
        <p>
          The BLO Liveability Index is intended as an informational tool to help inform decision-making.
          It should not be the sole factor in determining where to live, as individual circumstances, preferences,
          and priorities vary significantly. Data accuracy depends on source reliability and may not reflect
          the most current conditions. Users should conduct additional research and consider personal factors
          when making relocation decisions.
        </p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.about {
  min-height: 100vh;
  background-color: #f8f9fa;
  padding: 2rem 1rem;
}

.about-content {
  max-width: 900px;
  margin: 0 auto;
  background: white;
  padding: 2rem 3rem;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

h1 {
  color: #2c3e50;
  margin-bottom: 1.5rem;
  font-size: 2.5rem;
  border-bottom: 3px solid #42b983;
  padding-bottom: 0.5rem;
}

h2 {
  color: #2c3e50;
  margin-top: 2.5rem;
  margin-bottom: 1rem;
  font-size: 1.8rem;
}

h3 {
  color: #34495e;
  margin-top: 1.5rem;
  margin-bottom: 0.75rem;
  font-size: 1.3rem;
}

h4 {
  color: #34495e;
  margin-top: 1rem;
  margin-bottom: 0.5rem;
  font-size: 1.1rem;
}

section {
  margin-bottom: 2rem;
}

.intro-section p {
  font-size: 1.1rem;
  line-height: 1.7;
  color: #333;
  margin-bottom: 1rem;
}

.methodology-section p {
  line-height: 1.6;
  color: #333;
  margin-bottom: 1rem;
}

.metrics-table {
  width: 100%;
  border-collapse: collapse;
  margin: 2rem 0;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.metrics-table thead {
  background: #42b983;
  color: white;
}

.metrics-table th {
  padding: 1rem;
  text-align: left;
  font-weight: 600;
  font-size: 1.05rem;
}

.metrics-table td {
  padding: 1rem;
  border-bottom: 1px solid #e0e0e0;
  line-height: 1.6;
}

.metrics-table tbody tr {
  background: white;
}

.category-demographics {
  background: #e3f2fd !important;
}

.category-health {
  background: #fce4ec !important;
}

.category-environment {
  background: #e8f5e9 !important;
}

.category-economic {
  background: #fff3e0 !important;
}

.category-housing {
  background: #fce4ec !important;
}

.category-equity {
  background: #e0f2f1 !important;
}

.metrics-table tbody tr:hover {
  opacity: 0.8;
}

.calculation-note {
  background: #e8f5e9;
  padding: 1.5rem;
  border-radius: 8px;
  margin-top: 2rem;
  border-left: 4px solid #4caf50;
}

.calculation-note h4 {
  margin-top: 0;
  color: #2d5016;
}

.calculation-note p {
  margin-bottom: 1rem;
  line-height: 1.6;
}

.score-stats {
  background: white;
  padding: 1rem;
  border-radius: 4px;
  font-family: monospace;
  font-size: 0.95rem;
  color: #2d5016;
  margin-top: 1rem;
}

.datasets-section p {
  line-height: 1.6;
  color: #333;
  margin-bottom: 1rem;
}

.dataset-group {
  margin-bottom: 2rem;
}

.dataset-group h3 {
  color: #2c3e50;
  border-bottom: 2px solid #e0e0e0;
  padding-bottom: 0.5rem;
  margin-bottom: 1rem;
}

.dataset-item {
  background: #f8f9fa;
  padding: 1.25rem;
  border-radius: 6px;
  margin-bottom: 1rem;
  border-left: 3px solid #667eea;
}

.dataset-item h4 {
  margin-top: 0;
  color: #667eea;
  font-size: 1.1rem;
}

.dataset-item p {
  margin: 0.5rem 0;
  line-height: 1.6;
  color: #555;
}

.dataset-item a {
  color: #667eea;
  text-decoration: none;
  font-weight: 500;
  font-size: 0.9rem;
}

.dataset-item a:hover {
  text-decoration: underline;
}

.usage-section ol {
  line-height: 1.8;
  color: #333;
  padding-left: 1.5rem;
}

.usage-section li {
  margin-bottom: 1rem;
}

.usage-section strong {
  color: #2c3e50;
}

.disclaimer-section {
  background: #fff3cd;
  padding: 1.5rem;
  border-radius: 8px;
  border-left: 4px solid #ffc107;
  margin-top: 3rem;
}

.disclaimer-section h2 {
  margin-top: 0;
  color: #856404;
  font-size: 1.5rem;
}

.disclaimer-section p {
  color: #856404;
  line-height: 1.7;
  margin-bottom: 0;
}

@media (max-width: 768px) {
  .about-content {
    padding: 1.5rem 1.5rem;
  }

  h1 {
    font-size: 2rem;
  }

  h2 {
    font-size: 1.5rem;
  }

  .metric-categories {
    grid-template-columns: 1fr;
  }
}
</style>
