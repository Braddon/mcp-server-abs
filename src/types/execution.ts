export interface ExecutionSpec {
  executionId: string;
  toolName: string;
  parameters: Record<string, any>;
  apiCall: {
    method: string;
    url: string;
    params?: Record<string, any>;
    headers?: Record<string, string>;
  };
  timestamp: string;
  status: 'pending' | 'executing' | 'success' | 'error';
  ttl?: number; // Time to live in milliseconds
}

export interface ExecutionResult {
  executionId: string;
  status: 'success' | 'error';
  recordCount?: number;
  data?: any;
  error?: string;
  executedAt?: string;
}

export interface ExecutionRequest {
  toolName: string;
  parameters: Record<string, any>;
}

export interface ExecutionContext {
  hybridMode: boolean;
  directExecution?: boolean;
  clientId?: string;
}