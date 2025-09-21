import crypto from 'crypto';
import axios from 'axios';
import type { ExecutionSpec, ExecutionResult, ExecutionRequest } from '../types/execution.js';

const ABS_API_BASE = "https://data.api.abs.gov.au";
const DEFAULT_TTL = 15 * 60 * 1000; // 15 minutes

export class HybridExecutionService {
  private executions: Map<string, ExecutionSpec>;

  constructor() {
    this.executions = new Map();
  }

  async generateExecutionSpec(request: ExecutionRequest): Promise<ExecutionSpec> {
    const executionId = crypto.randomUUID();

    // Build API call based on tool name and parameters
    const apiCall = this.buildApiCall(request.toolName, request.parameters);

    const spec: ExecutionSpec = {
      executionId,
      toolName: request.toolName,
      parameters: request.parameters,
      apiCall,
      timestamp: new Date().toISOString(),
      status: 'pending',
      ttl: DEFAULT_TTL
    };

    this.executions.set(executionId, spec);
    return spec;
  }

  private buildApiCall(toolName: string, parameters: Record<string, any>) {
    if (toolName === 'query_dataset') {
      return {
        method: 'GET' as const,
        url: `${ABS_API_BASE}/rest/data/${parameters.datasetId}/all`,
        params: {
          format: 'jsondata',
          dimensionAtObservation: 'AllDimensions'
        }
      };
    }

    throw new Error(`Unknown tool: ${toolName}`);
  }

  getExecutionSpec(executionId: string): ExecutionSpec | undefined {
    return this.executions.get(executionId);
  }

  async executeSpec(executionId: string): Promise<ExecutionResult> {
    const spec = this.executions.get(executionId);

    if (!spec) {
      return {
        executionId,
        status: 'error',
        error: 'Execution spec not found'
      };
    }

    try {
      // Update status
      spec.status = 'executing';

      // Execute the API call
      const url = `${spec.apiCall.url}?${new URLSearchParams(spec.apiCall.params || {}).toString()}`;
      const response = await axios.get(url);

      // Calculate record count
      const observations = response.data?.data?.dataSets?.[0]?.observations;
      const recordCount = observations ? Object.keys(observations).length : 0;

      // Update status
      spec.status = 'success';

      return {
        executionId,
        status: 'success',
        recordCount,
        executedAt: new Date().toISOString()
        // Always returns metadata only - data is never passed through
      };
    } catch (error) {
      spec.status = 'error';

      return {
        executionId,
        status: 'error',
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  validateSpec(spec: ExecutionSpec): boolean {
    // Check required fields
    if (!spec.executionId || !spec.toolName || !spec.parameters || !spec.apiCall) {
      return false;
    }

    // Check API call structure
    if (!spec.apiCall.method || !spec.apiCall.url) {
      return false;
    }

    // Check timestamp is valid
    if (!spec.timestamp || isNaN(Date.parse(spec.timestamp))) {
      return false;
    }

    return true;
  }

  getActiveSpecs(): ExecutionSpec[] {
    return Array.from(this.executions.values());
  }

  cleanupOldSpecs(maxAge: number = DEFAULT_TTL): void {
    const now = Date.now();

    for (const [id, spec] of this.executions.entries()) {
      const specAge = now - new Date(spec.timestamp).getTime();

      if (specAge > maxAge) {
        this.executions.delete(id);
      }
    }
  }

  // Helper method to get summary without data
  getSpecSummary(executionId: string): Omit<ExecutionSpec, 'data'> | undefined {
    const spec = this.executions.get(executionId);

    if (!spec) {
      return undefined;
    }

    // Return spec without any data field
    const { ...summary } = spec;
    return summary;
  }

  // Get a formatted table of all stored execution IDs
  getExecutionsTable(): string {
    const specs = this.getActiveSpecs();

    if (specs.length === 0) {
      return 'No executions stored in memory';
    }

    // Create table header
    const headers = ['Execution ID', 'Tool', 'Dataset ID', 'Status', 'Age', 'Expires In'];
    const divider = headers.map(h => '-'.repeat(h.length));

    // Create table rows
    const now = Date.now();
    const rows = specs.map(spec => {
      const age = now - new Date(spec.timestamp).getTime();
      const ttl = spec.ttl || DEFAULT_TTL;
      const expiresIn = Math.max(0, ttl - age);

      return [
        spec.executionId.substring(0, 8) + '...',
        spec.toolName,
        spec.parameters.datasetId || 'N/A',
        spec.status,
        this.formatDuration(age),
        expiresIn > 0 ? this.formatDuration(expiresIn) : 'EXPIRED'
      ];
    });

    // Find max width for each column
    const columnWidths = headers.map((header, i) => {
      const widths = [header.length, ...rows.map(row => row[i].length)];
      return Math.max(...widths);
    });

    // Format table
    const formatRow = (row: string[]) =>
      '| ' + row.map((cell, i) => cell.padEnd(columnWidths[i])).join(' | ') + ' |';

    const table = [
      formatRow(headers),
      formatRow(divider.map((d, i) => '-'.repeat(columnWidths[i]))),
      ...rows.map(formatRow)
    ].join('\n');

    return table;
  }

  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }
}