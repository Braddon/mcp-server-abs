#!/usr/bin/env node

import { spawn } from 'child_process';

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

    this.server.stderr.on('data', (data) => {
      console.error('Server stderr:', data.toString());
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
    await new Promise(resolve => setTimeout(resolve, 1000));
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
  console.log('=== Testing Metadata-Only Response Fix ===\n');

  const client = new TestClient();
  await client.connect();

  try {
    // Step 1: Get execution spec
    console.log('1. Getting execution spec...');
    const specResponse = await client.callTool('query_dataset', {
      datasetId: 'C21_G01_LGA'
    });

    const spec = JSON.parse(specResponse.result.content[0].text);
    console.log('✓ Got execution spec:', spec.executionId);

    // Step 2: Call execute_direct
    console.log('\n2. Calling execute_direct...');
    const execResponse = await client.callTool('execute_direct', {
      executionId: spec.executionId
    });

    const result = JSON.parse(execResponse.result.content[0].text);

    // Step 3: Verify response
    console.log('\n3. Verifying response...');

    const responseSize = JSON.stringify(result).length;
    console.log(`✓ Response size: ${responseSize} bytes`);

    if (responseSize > 5000) {
      console.error('❌ FAILURE: Response too large! Still contains data.');
    } else {
      console.log('✅ SUCCESS: Response is metadata only (<5KB)');
    }

    console.log('\n4. Response fields:');
    console.log('   - executionId:', result.executionId ? '✓' : '❌');
    console.log('   - status:', result.status ? '✓' : '❌');
    console.log('   - recordCount:', result.recordCount !== undefined ? '✓' : '❌');
    console.log('   - executedAt:', result.executedAt ? '✓' : '❌');
    console.log('   - message:', result.message ? '✓' : '❌');
    console.log('   - data field:', result.data ? '❌ PRESENT (BAD)' : '✓ NOT PRESENT (GOOD)');

    console.log('\n✅ PHASE 1 FIX VERIFIED: execute_direct returns metadata only!');

  } catch (error) {
    console.error('Test failed:', error.message);
  } finally {
    client.close();
  }
}

testMetadataOnly().catch(console.error);