#!/usr/bin/env node

import { spawn } from 'child_process';
import assert from 'assert';

class TestClient {
  constructor() {
    this.server = null;
    this.messageId = 0;
    this.responseHandlers = new Map();
    this.buffer = '';
  }

  async connect() {
    this.server = spawn('node', ['build/index.js'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.server.stdout.on('data', (data) => {
      this.buffer += data.toString();
      this.processBuffer();
    });

    await new Promise(resolve => setTimeout(resolve, 1500));
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

async function testMetadataOnly() {
  console.log('=== Testing Metadata-Only Response ===\n');

  const client = new TestClient();
  await client.connect();

  try {
    // Get execution spec
    const specResponse = await client.callTool('query_dataset', {
      datasetId: 'ERP_LGA2023'  // Large dataset that was failing
    });

    const spec = JSON.parse(specResponse.result.content[0].text);
    console.log('✓ Got execution spec');

    // Call execute_direct
    const execResponse = await client.callTool('execute_direct', {
      executionId: spec.executionId
    });

    const result = JSON.parse(execResponse.result.content[0].text);
    const responseSize = JSON.stringify(result).length;

    // Verify response size is small (metadata only)
    assert(responseSize < 1000, `Response too large: ${responseSize} bytes`);
    console.log(`✓ Response size: ${responseSize} bytes (metadata only)`);

    // Verify no data field
    assert(!result.data, 'Response should not contain data field');
    console.log('✓ No data field in response');

    // Verify required metadata fields
    assert(result.executionId, 'Missing executionId');
    assert(result.status, 'Missing status');
    assert(result.recordCount !== undefined, 'Missing recordCount');
    assert(result.executedAt, 'Missing executedAt');
    console.log('✓ All metadata fields present');

    console.log('\n✅ PASS: execute_direct returns metadata only');

  } catch (error) {
    console.error('❌ FAIL:', error.message);
    process.exit(1);
  } finally {
    client.close();
  }
}

testMetadataOnly().catch(console.error);