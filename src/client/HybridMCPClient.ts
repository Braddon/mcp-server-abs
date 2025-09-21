import { spawn, ChildProcess } from 'child_process';

export interface QueryOptions {
  format?: string;
  timeout?: number;
}

export interface MCPResponse {
  jsonrpc: string;
  id: number;
  result?: any;
  error?: {
    code: number;
    message: string;
  };
}

export interface QueryResult {
  executionId: string;
  status: string;
  datasetId?: string;
  recordCount?: number;
  data?: any;
  apiCall?: {
    method: string;
    url: string;
    params: Record<string, any>;
  };
}

export class HybridMCPClient {
  private server: ChildProcess | null = null;
  private messageId = 0;
  private responseHandlers = new Map<number, (response: MCPResponse) => void>();
  private buffer = '';
  private initialized = false;

  constructor(private serverPath: string) {}

  async connect(): Promise<void> {
    if (this.server) {
      throw new Error('Client already connected');
    }

    this.server = spawn('node', [this.serverPath], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.server.stdout?.on('data', (data) => {
      this.handleData(data.toString());
    });

    this.server.stderr?.on('data', (data) => {
      console.error('Server:', data.toString());
    });

    this.server.on('error', (error) => {
      console.error('Server process error:', error);
    });

    this.server.on('exit', (code) => {
      if (code !== 0) {
        console.error('Server exited with code:', code);
      }
      this.cleanup();
    });

    // Wait for server to start
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Initialize MCP connection
    await this.initialize();
  }

  private async initialize(): Promise<void> {
    const response = await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {
          list: true,
          call: true
        }
      },
      clientInfo: {
        name: 'HybridMCPClient',
        version: '1.0.0'
      }
    });

    if (response.error) {
      throw new Error(`Failed to initialize: ${response.error.message}`);
    }

    this.initialized = true;
  }

  private handleData(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim()) {
        try {
          const response = JSON.parse(line) as MCPResponse;
          this.handleResponse(response);
        } catch (error) {
          // Not valid JSON, ignore
        }
      }
    }
  }

  private handleResponse(response: MCPResponse): void {
    if (response.id && this.responseHandlers.has(response.id)) {
      const handler = this.responseHandlers.get(response.id);
      this.responseHandlers.delete(response.id);
      handler?.(response);
    }
  }

  private sendRequest(method: string, params?: any): Promise<MCPResponse> {
    if (!this.server) {
      throw new Error('Client not connected');
    }

    return new Promise((resolve, reject) => {
      const id = ++this.messageId;

      const timeoutId = setTimeout(() => {
        if (this.responseHandlers.has(id)) {
          this.responseHandlers.delete(id);
          reject(new Error('Request timeout'));
        }
      }, 30000); // 30 second timeout

      this.responseHandlers.set(id, (response) => {
        clearTimeout(timeoutId);
        resolve(response);
      });

      const request = {
        jsonrpc: '2.0',
        id,
        method,
        params
      };

      this.server?.stdin?.write(JSON.stringify(request) + '\n');
    });
  }

  async queryDataset(datasetId: string, options: QueryOptions = {}): Promise<QueryResult> {
    if (!this.initialized) {
      throw new Error('Client not initialized');
    }

    // Always get execution spec (no data included)
    const response = await this.callTool('query_dataset', {
      datasetId,
      format: options.format
    });

    const result = JSON.parse(response.content[0].text) as QueryResult;

    // Always fetch data directly using execution ID
    if (result.executionId) {
      const dataResponse = await this.executeDirectly(result.executionId);
      return {
        ...result,
        data: dataResponse
      };
    }

    // Should not happen, but handle gracefully
    throw new Error('No execution ID received from server');
  }

  private async executeDirectly(executionId: string): Promise<any> {
    const response = await this.callTool('execute_direct', { executionId });
    return JSON.parse(response.content[0].text);
  }

  private async callTool(toolName: string, args: any): Promise<any> {
    const response = await this.sendRequest('tools/call', {
      name: toolName,
      arguments: args
    });

    if (response.error) {
      throw new Error(`Tool call failed: ${response.error.message}`);
    }

    return response.result;
  }

  async listTools(): Promise<any[]> {
    if (!this.initialized) {
      throw new Error('Client not initialized');
    }

    const response = await this.sendRequest('tools/list');

    if (response.error) {
      throw new Error(`Failed to list tools: ${response.error.message}`);
    }

    return response.result?.tools || [];
  }

  async queryMultipleDatasets(datasetIds: string[], options: QueryOptions = {}): Promise<QueryResult[]> {
    // Execute queries in parallel
    const promises = datasetIds.map(id => this.queryDataset(id, options));
    return Promise.all(promises);
  }

  close(): void {
    this.cleanup();
    if (this.server) {
      this.server.kill();
      this.server = null;
    }
  }

  private cleanup(): void {
    this.responseHandlers.clear();
    this.initialized = false;
    this.buffer = '';
    this.messageId = 0;
  }

  isConnected(): boolean {
    return this.server !== null && this.initialized;
  }
}