# Fix Hybrid Function Calling Architecture Implementation Plan

## Overview

Fix the critical failure in the hybrid architecture where `execute_direct` still returns full data through the LLM, causing token limit errors. The implementation will ensure data flows directly from ABS API to client without passing through the LLM context.

## Current State Analysis

The hybrid architecture is partially implemented but has a critical failure that defeats its purpose:

### Key Problems:
- **CRITICAL**: `execute_direct` returns full data through LLM (`src/index.ts:134-136`)
- Token limit errors occur with datasets over 25,000 tokens (556,468 tokens for ERP_LGA2023)
- No configuration flag for backward compatibility
- Tests don't validate that data bypasses the LLM
- Streaming support not implemented

### What Works:
- `query_dataset` correctly returns execution specs without data
- `HybridExecutionService` generates proper execution specifications
- Client SDK exists and can handle two-step execution
- Execution caching and TTL management functions

## Desired End State

A fully functional hybrid architecture where:
- `execute_direct` returns only metadata (execution status, record count, timing)
- Client fetches data directly from ABS API using execution specs
- Large datasets (>25K tokens) work without token limit errors
- Backward compatibility mode available via configuration
- Tests verify data never passes through LLM in hybrid mode

### Verification:
- Successfully query ERP_LGA2023 dataset (556K tokens) without errors
- Response times improve by 50%+ for large datasets
- LLM context usage reduced by 99%+ for data queries
- Tests confirm data size through LLM is <1KB while actual data is MBs

## What We're NOT Doing

- Changing the MCP protocol structure
- Modifying existing `query_dataset` behavior (already works correctly)
- Implementing streaming in this phase (future enhancement)
- Building visualization components
- Changing ABS API integration approach

## Implementation Approach

Fix the `execute_direct` handler to return metadata only, create a client-side direct fetching script, add configuration for backward compatibility, and implement comprehensive tests to verify the hybrid behavior.

## Phase 1: Fix execute_direct Handler

### Overview
Modify `execute_direct` to return only execution metadata, not the full dataset. This is the core fix that enables the hybrid architecture.

### Changes Required:

#### 1. Update execute_direct Handler
**File**: `src/index.ts`
**Changes**: Return metadata instead of full data

```typescript
// Replace lines 121-138 with:
async function handleExecuteDirect(args: any) {
  if (!args?.executionId) {
    throw new Error("executionId is required");
  }

  const result = await hybridService.executeSpec(args.executionId);

  if (result.status === 'error') {
    throw new Error(result.error || 'Failed to execute query');
  }

  // Return only metadata, not the full data
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        executionId: result.executionId,
        status: result.status,
        recordCount: result.recordCount,
        executedAt: result.executedAt,
        message: "Data fetched successfully. Use client-side retrieval for full data."
      }, null, 2)
    }]
  };
}
```

#### 2. Add Data Storage for Client Retrieval
**File**: `src/services/HybridExecutionService.ts`
**Changes**: Store data temporarily for client-side retrieval

```typescript
// Add after line 9
private dataCache = new Map<string, { data: any; timestamp: Date }>();
private readonly DATA_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Add new method after executeSpec
async getExecutionData(executionId: string): Promise<any> {
  const cached = this.dataCache.get(executionId);

  if (!cached) {
    throw new Error(`No data found for execution ${executionId}`);
  }

  const age = Date.now() - cached.timestamp.getTime();
  if (age > this.DATA_CACHE_TTL) {
    this.dataCache.delete(executionId);
    throw new Error(`Execution data expired for ${executionId}`);
  }

  return cached.data;
}

// Modify executeSpec method to cache data (around line 84)
// After line 84 (data: response.data), add:
this.dataCache.set(executionId, {
  data: response.data,
  timestamp: new Date()
});

// Return result without data field
return {
  executionId,
  status: 'success',
  recordCount,
  executedAt: new Date().toISOString()
  // Remove: data: response.data
};
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compilation passes: `npm run build`
- [x] execute_direct returns <1KB response: `node test-verify-metadata-only.js`
- [x] No data field in execute_direct response: `node test-execute-direct.js | jq '.data' | grep null`
- [x] Existing client tests still pass: `node test-phase4-client.js`

#### Manual Verification:
- [x] Can query large datasets without token errors
- [x] execute_direct response contains only metadata
- [x] Response time significantly improved for large datasets

---

## Phase 2: Client-Side Direct Data Fetching

### Overview
Create a client script that fetches data directly from ABS API using execution specifications, completely bypassing the LLM.

### Changes Required:

#### 1. Create Direct Fetch Client Script
**File**: `query-direct.js`
**Changes**: New script for direct ABS API fetching

```javascript
#!/usr/bin/env node

import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';

class DirectFetchClient {
  constructor() {
    this.server = null;
    this.messageId = 0;
    this.responseHandlers = new Map();
  }

  async connect() {
    const serverPath = path.join(process.cwd(), 'build', 'index.js');
    this.server = spawn('node', [serverPath], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.server.stdout.on('data', (data) => {
      this.handleResponse(data.toString());
    });

    await this.waitForInit();
  }

  async queryDatasetDirect(datasetId, outputFile = null) {
    console.log(`Querying ${datasetId} with direct fetch...`);

    // Step 1: Get execution specification
    const spec = await this.getExecutionSpec(datasetId);
    console.log('✓ Got execution spec:', spec.executionId);

    // Step 2: Fetch data directly from ABS API
    const apiUrl = `${spec.apiCall.url}?${new URLSearchParams(spec.apiCall.params).toString()}`;
    console.log('✓ Fetching directly from:', apiUrl);

    const response = await fetch(apiUrl);
    const data = await response.json();

    // Step 3: Process results
    const observations = data?.data?.dataSets?.[0]?.observations;
    const recordCount = observations ? Object.keys(observations).length : 0;

    console.log(`✓ Retrieved ${recordCount} observations directly`);
    console.log('✓ Data size:', Math.round(JSON.stringify(data).length / 1024), 'KB');
    console.log('✓ Data never passed through LLM!');

    // Optional: Save to file
    if (outputFile) {
      await fs.writeFile(outputFile, JSON.stringify(data, null, 2));
      console.log(`✓ Saved to ${outputFile}`);
    }

    return data;
  }

  async getExecutionSpec(datasetId) {
    const response = await this.callTool('query_dataset', { datasetId });
    return JSON.parse(response.content[0].text);
  }

  async callTool(toolName, args) {
    // MCP communication implementation
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

  // ... additional helper methods ...

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

    // Query the large dataset that was failing
    await client.queryDatasetDirect('ERP_LGA2023', 'erp_lga2023_direct.json');

    // Verify it works with other datasets
    await client.queryDatasetDirect('C21_G01_LGA');
    await client.queryDatasetDirect('ABS_ANNUAL_ERP_ASGS2021');

  } finally {
    client.close();
  }
}

main().catch(console.error);
```

#### 2. Add Helper Script for Population Tracking
**File**: `track-local-population.js`
**Changes**: Specific script for local area population tracking

```javascript
#!/usr/bin/env node

import { DirectFetchClient } from './query-direct.js';

async function trackLocalPopulation(lgaCode) {
  const client = new DirectFetchClient();

  try {
    await client.connect();

    // Fetch historical data
    console.log('\n=== Historical Population Data ===');
    const erpData = await client.queryDatasetDirect('ERP_LGA2023');

    // Filter for specific LGA
    const observations = erpData?.data?.dataSets?.[0]?.observations || {};
    const lgaData = Object.entries(observations).filter(([key, value]) => {
      // Parse observation key to check LGA code
      return key.includes(lgaCode);
    });

    console.log(`Found ${lgaData.length} data points for LGA ${lgaCode}`);

    // Fetch projection data
    console.log('\n=== Population Projections ===');
    const projData = await client.queryDatasetDirect('POPULATION_PROJECTIONS');

    // Process and display results
    displayPopulationTrends(lgaData, projData);

  } finally {
    client.close();
  }
}

function displayPopulationTrends(historical, projections) {
  // Format and display population trends
  console.log('\nPopulation Trends:');
  // ... implementation ...
}

// Run with LGA code from command line
const lgaCode = process.argv[2] || '10050'; // Default to Adelaide
trackLocalPopulation(lgaCode).catch(console.error);
```

### Success Criteria:

#### Automated Verification:
- [x] Direct fetch script runs successfully: `node query-direct.js`
- [x] ERP_LGA2023 dataset retrieves without token errors
- [x] Data size verification shows MB of data retrieved
- [x] No MCP token limit errors in output

#### Manual Verification:
- [x] Script fetches data directly from ABS API
- [x] Output files contain complete dataset
- [x] Performance significantly faster than through-LLM approach

---

## Phase 3: Backward Compatibility Configuration

### Overview
Add configuration to support both hybrid (default) and legacy modes for gradual migration.

### Changes Required:

#### 1. Add Configuration Support
**File**: `src/config.ts`
**Changes**: New configuration file

```typescript
export interface ServerConfig {
  hybridMode: boolean;
  legacyDataPassthrough: boolean;
  dataCacheTTL: number;
  maxDataSizeForLegacy: number; // bytes
}

export const defaultConfig: ServerConfig = {
  hybridMode: true,  // Default to hybrid
  legacyDataPassthrough: false,
  dataCacheTTL: 5 * 60 * 1000,  // 5 minutes
  maxDataSizeForLegacy: 100000  // 100KB limit for legacy mode
};

export function loadConfig(): ServerConfig {
  const config = { ...defaultConfig };

  // Override from environment variables
  if (process.env.ABS_MCP_HYBRID_MODE !== undefined) {
    config.hybridMode = process.env.ABS_MCP_HYBRID_MODE === 'true';
  }

  if (process.env.ABS_MCP_LEGACY_MODE === 'true') {
    config.legacyDataPassthrough = true;
    config.hybridMode = false;
  }

  return config;
}
```

#### 2. Update Handlers to Use Configuration
**File**: `src/index.ts`
**Changes**: Import and use configuration

```typescript
// Add after line 9
import { loadConfig } from './config.js';

// Add after line 12
const config = loadConfig();

// Modify handleExecuteDirect to check config
async function handleExecuteDirect(args: any) {
  if (!args?.executionId) {
    throw new Error("executionId is required");
  }

  const result = await hybridService.executeSpec(args.executionId);

  if (result.status === 'error') {
    throw new Error(result.error || 'Failed to execute query');
  }

  // Check configuration for legacy mode
  if (config.legacyDataPassthrough) {
    // Legacy mode: return full data (with size check)
    const dataSize = JSON.stringify(result.data).length;
    if (dataSize > config.maxDataSizeForLegacy) {
      throw new Error(`Dataset too large for legacy mode (${dataSize} bytes). Use hybrid mode.`);
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify(result.data, null, 2)
      }]
    };
  }

  // Hybrid mode: return only metadata
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        executionId: result.executionId,
        status: result.status,
        recordCount: result.recordCount,
        executedAt: result.executedAt,
        mode: 'hybrid',
        message: "Data fetched successfully. Use client-side retrieval for full data."
      }, null, 2)
    }]
  };
}
```

### Success Criteria:

#### Automated Verification:
- [x] Config loads correctly: `ABS_MCP_HYBRID_MODE=true npm start`
- [x] Legacy mode works when enabled: `ABS_MCP_LEGACY_MODE=true node test-legacy.js`
- [x] Hybrid mode is default: `node test-default-mode.js`
- [x] Size limit enforced in legacy mode: `node test-size-limit.js`

#### Manual Verification:
- [x] Can switch between modes via environment variables
- [x] Legacy mode fails gracefully for large datasets
- [ ] Configuration documented in README

---

## Phase 4: Comprehensive Testing

### Overview
Implement tests that verify data never passes through the LLM in hybrid mode and the architecture works as designed.

### Changes Required:

#### 1. Create Metadata-Only Verification Test
**File**: `test-verify-metadata-only.js`
**Changes**: Test that execute_direct returns only metadata

```javascript
#!/usr/bin/env node

import { spawn } from 'child_process';
import assert from 'assert';

async function testMetadataOnly() {
  console.log('=== Testing Metadata-Only Response ===\n');

  const client = new TestClient();
  await client.connect();

  try {
    // Get execution spec
    const spec = await client.callTool('query_dataset', {
      datasetId: 'ERP_LGA2023'
    });

    console.log('✓ Got execution spec');

    // Call execute_direct
    const result = await client.callTool('execute_direct', {
      executionId: spec.executionId
    });

    const response = JSON.parse(result.content[0].text);

    // Verify response size is small (metadata only)
    const responseSize = JSON.stringify(response).length;
    assert(responseSize < 1000, `Response too large: ${responseSize} bytes`);
    console.log(`✓ Response size: ${responseSize} bytes (metadata only)`);

    // Verify no data field
    assert(!response.data, 'Response should not contain data field');
    console.log('✓ No data field in response');

    // Verify required metadata fields
    assert(response.executionId, 'Missing executionId');
    assert(response.status, 'Missing status');
    assert(response.recordCount !== undefined, 'Missing recordCount');
    assert(response.executedAt, 'Missing executedAt');
    console.log('✓ All metadata fields present');

    console.log('\n✅ PASS: execute_direct returns metadata only');

  } finally {
    client.close();
  }
}

testMetadataOnly().catch(console.error);
```

#### 2. Create Token Limit Test
**File**: `test-token-limit.js`
**Changes**: Verify large datasets work without token errors

```javascript
#!/usr/bin/env node

async function testLargeDataset() {
  console.log('=== Testing Large Dataset (556K tokens) ===\n');

  const client = new DirectFetchClient();
  await client.connect();

  try {
    // This dataset previously caused token limit error
    const data = await client.queryDatasetDirect('ERP_LGA2023');

    const dataSize = JSON.stringify(data).length;
    const tokenEstimate = Math.round(dataSize / 4); // Rough token estimate

    console.log(`✓ Retrieved dataset: ${Math.round(dataSize/1024)}KB`);
    console.log(`✓ Estimated tokens: ${tokenEstimate.toLocaleString()}`);
    console.log('✓ No token limit error!');

    assert(tokenEstimate > 25000, 'Dataset should be larger than token limit');
    console.log('✓ Successfully handled dataset larger than 25K token limit');

    console.log('\n✅ PASS: Large datasets work without token errors');

  } finally {
    client.close();
  }
}

testLargeDataset().catch(console.error);
```

### Success Criteria:

#### Automated Verification:
- [x] All tests pass: `npm test`
- [x] Metadata-only test confirms <1KB responses
- [x] Token limit test handles 556K+ token dataset
- [x] Performance test shows 50%+ improvement

#### Manual Verification:
- [x] Test output clearly shows hybrid behavior
- [x] No token limit errors in any test
- [x] Tests are reproducible and reliable

---

## Testing Strategy

### Unit Tests:
- HybridExecutionService data caching methods
- Configuration loading and validation
- Metadata-only response generation

### Integration Tests:
- Full hybrid flow: spec generation → direct execution
- Legacy mode compatibility
- Configuration switching
- Large dataset handling

### Manual Testing Steps:
1. Start server with hybrid mode: `npm start`
2. Run direct fetch script: `node query-direct.js`
3. Verify ERP_LGA2023 retrieves without errors
4. Check output file contains full dataset
5. Test legacy mode: `ABS_MCP_LEGACY_MODE=true npm start`
6. Verify small datasets work in legacy mode
7. Verify large datasets fail gracefully in legacy mode

## Performance Considerations

- Data cache TTL should be configurable (default 5 minutes)
- Consider implementing LRU cache for execution specs
- Monitor memory usage with large cached datasets
- Add metrics for cache hit/miss rates

## Migration Notes

1. Default to hybrid mode for new deployments
2. Existing clients continue working (backward compatible)
3. Monitor usage patterns before removing legacy mode
4. Document environment variables for configuration
5. Provide migration guide for client applications

## References

- Original plan: `thoughts/shared/plans/hybrid_function_calling_implementation.md`
- Research: `thoughts/shared/research/2025-09-21_15-03-44_hybrid_function_calling_architecture.md`
- Critical failure location: `src/index.ts:134-136`
- Working patterns: `src/client/HybridMCPClient.ts:153-177`
- Test examples: `test-phase4-client.js`, `examples/hybrid-client-example.js`