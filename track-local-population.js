#!/usr/bin/env node

import { DirectFetchClient } from './query-direct.js';
import fs from 'fs/promises';

async function trackLocalPopulation(lgaCodeOrName) {
  const client = new DirectFetchClient();

  try {
    await client.connect();

    console.log('\n📍 Local Area Population Tracker');
    console.log('=================================');
    console.log(`Tracking population for: ${lgaCodeOrName}`);

    // Fetch historical ERP data
    console.log('\n📈 Historical Population Data (ERP_LGA2023)');
    console.log('--------------------------------------------');
    const erpData = await client.queryDatasetDirect('ERP_LGA2023');

    // Parse and filter for specific LGA
    const observations = erpData?.data?.dataSets?.[0]?.observations || {};
    const dimensions = erpData?.data?.structure?.dimensions?.observation || [];

    // Find LGA dimension
    let lgaDimension = null;
    let timeDimension = null;
    for (let i = 0; i < dimensions.length; i++) {
      const dim = dimensions[i];
      if (dim.id === 'LGA_2023' || dim.id === 'ASGS_2023' || dim.id === 'REGION') {
        lgaDimension = { index: i, values: dim.values };
      } else if (dim.id === 'TIME_PERIOD' || dim.id === 'TIME') {
        timeDimension = { index: i, values: dim.values };
      }
    }

    // Filter observations for the specified LGA
    const lgaData = [];
    let matchedLGA = null;

    for (const [key, value] of Object.entries(observations)) {
      const indices = key.split(':').map(Number);

      if (lgaDimension && timeDimension) {
        const lgaIndex = indices[lgaDimension.index];
        const timeIndex = indices[timeDimension.index];

        const lgaInfo = lgaDimension.values[lgaIndex];
        const timeInfo = timeDimension.values[timeIndex];

        // Check if this matches our LGA (by code or name)
        if (lgaInfo && (
          lgaInfo.id === lgaCodeOrName ||
          lgaInfo.name?.toLowerCase().includes(lgaCodeOrName.toLowerCase())
        )) {
          if (!matchedLGA) {
            matchedLGA = lgaInfo;
            console.log(`\n✓ Found LGA: ${lgaInfo.name} (${lgaInfo.id})`);
          }

          lgaData.push({
            year: timeInfo.id || timeInfo.name,
            population: value[0],
            lgaName: lgaInfo.name,
            lgaCode: lgaInfo.id
          });
        }
      }
    }

    if (lgaData.length > 0) {
      // Sort by year
      lgaData.sort((a, b) => a.year.localeCompare(b.year));

      console.log('\n📊 Population History:');
      console.log('Year  | Population');
      console.log('------|------------');

      for (const entry of lgaData) {
        console.log(`${entry.year} | ${entry.population.toLocaleString()}`);
      }

      // Calculate growth
      if (lgaData.length > 1) {
        const firstYear = lgaData[0];
        const lastYear = lgaData[lgaData.length - 1];
        const totalGrowth = lastYear.population - firstYear.population;
        const percentGrowth = ((totalGrowth / firstYear.population) * 100).toFixed(2);
        const yearsSpan = parseInt(lastYear.year) - parseInt(firstYear.year);
        const avgAnnualGrowth = (totalGrowth / yearsSpan).toFixed(0);

        console.log('\n📈 Growth Analysis:');
        console.log(`Period: ${firstYear.year} to ${lastYear.year}`);
        console.log(`Total Growth: ${totalGrowth.toLocaleString()} (${percentGrowth}%)`);
        console.log(`Average Annual Growth: ${avgAnnualGrowth} people/year`);
      }

      // Save to file
      const outputFile = `population_${matchedLGA.id}.json`;
      await fs.writeFile(outputFile, JSON.stringify({
        lga: matchedLGA,
        populationHistory: lgaData,
        metadata: {
          source: 'Australian Bureau of Statistics',
          dataset: 'ERP_LGA2023',
          extracted: new Date().toISOString()
        }
      }, null, 2));

      console.log(`\n💾 Data saved to: ${outputFile}`);

    } else {
      console.log(`\n⚠️ No data found for LGA: ${lgaCodeOrName}`);
      console.log('\nTip: Try one of these formats:');
      console.log('  - LGA code: "10050" for Adelaide');
      console.log('  - Partial name: "Adelaide", "Sydney", "Melbourne"');
      console.log('  - Full name: "Brisbane (C)"');
    }

    // Try to fetch projection data if available
    console.log('\n🔮 Checking for Population Projections...');
    try {
      const projData = await client.queryDatasetDirect('POPULATION_PROJECTIONS_LGA');
      console.log('✓ Projection data available - processing...');
      // Process projection data similarly...
    } catch (projError) {
      console.log('ℹ️ No projection data available for LGAs in this dataset');
    }

  } catch (error) {
    console.error('\n❌ Error:', error.message);
  } finally {
    client.close();
  }
}

// Parse command line arguments
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('\n📍 Local Area Population Tracker');
    console.log('Usage: node track-local-population.js <LGA_CODE_OR_NAME>');
    console.log('\nExamples:');
    console.log('  node track-local-population.js 10050      # Adelaide by code');
    console.log('  node track-local-population.js Adelaide   # Adelaide by name');
    console.log('  node track-local-population.js "Sydney"   # Sydney');
    console.log('  node track-local-population.js 20660      # Melbourne');
    console.log('\nCommon LGA codes:');
    console.log('  10050 - Adelaide (C)');
    console.log('  11570 - Brisbane (C)');
    console.log('  20660 - Melbourne (C)');
    console.log('  17200 - Sydney (C)');
    console.log('  18450 - Perth (C)');
    process.exit(1);
  }

  const lgaInput = args.join(' '); // Handle multi-word names
  await trackLocalPopulation(lgaInput);
}

// Run if executed directly
if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch(console.error);
}

// Export for use in other scripts
export { trackLocalPopulation };