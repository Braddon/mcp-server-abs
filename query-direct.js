#!/usr/bin/env node

import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';

class DirectFetchClient {
  constructor() {
    this.server = null;
    this.messageId = 0;
    this.responseHandlers = new Map();
    this.buffer = '';
  }

  async connect() {
    const serverPath = path.join(process.cwd(), 'build', 'index.js');
    this.server = spawn('node', [serverPath], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.server.stdout.on('data', (data) => {
      this.buffer += data.toString();
      this.processBuffer();
    });

    this.server.stderr.on('data', (data) => {
      // Suppress server messages unless debugging
      if (process.env.DEBUG) {
        console.error('Server:', data.toString());
      }
    });

    await this.waitForInit();
  }

  processBuffer() {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim()) {
        try {
          const response = JSON.parse(line);
          if (response.id && this.responseHandlers.has(response.id)) {
            const handler = this.responseHandlers.get(response.id);
            this.responseHandlers.delete(response.id);
            handler(response);
          }
        } catch (e) {
          // Not JSON, ignore
        }
      }
    }
  }

  async waitForInit() {
    console.log('Initializing MCP server...');
    await new Promise(resolve => setTimeout(resolve, 1500));
  }

  async queryDatasetDirect(datasetId, outputFile = null) {
    console.log(`\n📊 Querying ${datasetId} with direct fetch...`);

    try {
      // Step 1: Get execution specification from MCP server
      console.log('  1. Getting execution specification...');
      const spec = await this.getExecutionSpec(datasetId);
      console.log(`  ✓ Got execution spec: ${spec.executionId}`);

      // Step 2: Fetch data directly from ABS API (bypassing LLM)
      const apiUrl = `${spec.apiCall.url}?${new URLSearchParams(spec.apiCall.params).toString()}`;
      console.log(`  2. Fetching directly from ABS API...`);
      console.log(`     URL: ${apiUrl}`);

      const startTime = Date.now();
      const response = await fetch(apiUrl);

      if (!response.ok) {
        throw new Error(`ABS API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      const fetchTime = Date.now() - startTime;

      // Step 3: Process results
      const observations = data?.data?.dataSets?.[0]?.observations;
      const recordCount = observations ? Object.keys(observations).length : 0;
      const dataSize = JSON.stringify(data).length;

      console.log(`  ✓ Retrieved ${recordCount.toLocaleString()} observations`);
      console.log(`  ✓ Data size: ${Math.round(dataSize / 1024).toLocaleString()} KB`);
      console.log(`  ✓ Fetch time: ${(fetchTime / 1000).toFixed(2)}s`);
      console.log(`  ✓ Data never passed through LLM!`);

      // Estimate token count to show savings
      const estimatedTokens = Math.round(dataSize / 4);
      if (estimatedTokens > 25000) {
        console.log(`  💡 Saved ${estimatedTokens.toLocaleString()} tokens from LLM context!`);
      }

      // Optional: Save to file
      if (outputFile) {
        await fs.writeFile(outputFile, JSON.stringify(data, null, 2));
        console.log(`  ✓ Saved to ${outputFile}`);
      }

      return data;
    } catch (error) {
      console.error(`  ❌ Error: ${error.message}`);
      throw error;
    }
  }

  async getExecutionSpec(datasetId) {
    const response = await this.callTool('query_dataset', { datasetId });

    if (response.error) {
      throw new Error(`MCP error: ${response.error.message}`);
    }

    return JSON.parse(response.result.content[0].text);
  }

  async callTool(toolName, args) {
    const id = ++this.messageId;

    return new Promise((resolve, reject) => {
      this.responseHandlers.set(id, resolve);

      const request = {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name: toolName,
          arguments: args
        }
      };

      this.server.stdin.write(JSON.stringify(request) + '\n');

      setTimeout(() => {
        if (this.responseHandlers.has(id)) {
          this.responseHandlers.delete(id);
          reject(new Error('Request timeout'));
        }
      }, 30000);
    });
  }

  close() {
    if (this.server) {
      this.server.kill();
    }
  }
}

// Main execution
async function main() {
  const client = new DirectFetchClient();

  try {
    await client.connect();

    console.log('\n🚀 Direct ABS Data Fetcher');
    console.log('========================');
    console.log('Fetching data directly from ABS API, bypassing LLM token limits!');

    // Query the large dataset that was previously failing
    console.log('\n--- Testing with large dataset (ERP_LGA2023) ---');
    await client.queryDatasetDirect('ERP_LGA2023', 'erp_lga2023_direct.json');

    // Verify it works with other datasets
    console.log('\n--- Testing with Census data (C21_G01_LGA) ---');
    await client.queryDatasetDirect('C21_G01_LGA', 'census_lga_direct.json');

    console.log('\n--- Testing with annual ERP data ---');
    await client.queryDatasetDirect('ABS_ANNUAL_ERP_ASGS2021', 'annual_erp_direct.json');

    console.log('\n✅ SUCCESS: All datasets retrieved without LLM token limits!');
    console.log('\nOutput files created:');
    console.log('  - erp_lga2023_direct.json (Large dataset that previously failed)');
    console.log('  - census_lga_direct.json');
    console.log('  - annual_erp_direct.json');

  } catch (error) {
    console.error('\n❌ Fatal error:', error.message);
    process.exit(1);
  } finally {
    client.close();
  }
}

// Run if executed directly
if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch(console.error);
}

// Export for use in other scripts
export { DirectFetchClient };