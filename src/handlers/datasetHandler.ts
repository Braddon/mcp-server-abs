import axios, { AxiosError } from "axios";
import crypto from 'crypto';
import type { ExecutionMetadata, HybridResponse } from '../types/abs.js';
import { HybridExecutionService } from '../services/HybridExecutionService.js';

export interface ApiCallInfo {
  method: string;
  url: string;
  params: Record<string, any>;
}

const ABS_API_BASE = "https://data.api.abs.gov.au";

export interface QueryDatasetArgs {
  datasetId?: string;
  format?: string;
}

export interface HandlerResponse {
  content: Array<{
    type: string;
    text: string;
  }>;
}

export async function handleQueryDataset(args: QueryDatasetArgs): Promise<HandlerResponse> {
  if (!args?.datasetId || typeof args.datasetId !== "string") {
    throw new Error("datasetId is required and must be a string");
  }

  const url = `${ABS_API_BASE}/rest/data/${args.datasetId}/all?format=jsondata&dimensionAtObservation=AllDimensions`;

  try {
    const response = await axios.get(url);

    // Generate execution metadata
    const executionId = crypto.randomUUID();

    // Calculate record count from observations
    const observations = response.data?.data?.dataSets?.[0]?.observations;
    const recordCount = observations ? Object.keys(observations).length : 0;

    // Create execution metadata
    const executionMetadata: ExecutionMetadata = {
      executionId,
      endpoint: url,
      timestamp: new Date().toISOString(),
      hybridReady: true
    };

    // Create hybrid response WITHOUT data (for true hybrid execution)
    const hybridResponse: HybridResponse & { apiCall: ApiCallInfo } = {
      executionId,
      status: 'success',
      datasetId: args.datasetId,
      recordCount,
      summary: `Retrieved ${recordCount} observations from ${args.datasetId}`,
      apiCall: {
        method: 'GET',
        url: `${ABS_API_BASE}/rest/data/${args.datasetId}/all`,
        params: {
          format: 'jsondata',
          dimensionAtObservation: 'AllDimensions'
        }
      }
      // NO data field - client should execute the API call
    };

    // For now, include metadata in the response content
    // MCP doesn't support custom _meta field in the response
    const responseWithMeta = {
      ...hybridResponse,
      _meta: executionMetadata
    };

    return {
      content: [{
        type: "text",
        text: JSON.stringify(responseWithMeta, null, 2)
      }]
    };
  } catch (error) {
    if (error instanceof AxiosError && error.response) {
      throw new Error(`ABS API Error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
    }
    throw error;
  }
}

// Service-based handler for Phase 2
const hybridService = new HybridExecutionService();

export async function handleQueryDatasetWithService(args: QueryDatasetArgs): Promise<HandlerResponse> {
  if (!args?.datasetId || typeof args.datasetId !== "string") {
    throw new Error("datasetId is required and must be a string");
  }

  // Generate execution spec using the service
  const spec = await hybridService.generateExecutionSpec({
    toolName: 'query_dataset',
    parameters: {
      datasetId: args.datasetId
    }
  });

  // For testing purposes, execute locally to get record count
  // In production, this would be optional or client-driven
  const url = `${ABS_API_BASE}/rest/data/${args.datasetId}/all?format=jsondata&dimensionAtObservation=AllDimensions`;

  try {
    const response = await axios.get(url);

    // Calculate record count from observations
    const observations = response.data?.data?.dataSets?.[0]?.observations;
    const recordCount = observations ? Object.keys(observations).length : 0;

    // Create hybrid response using service spec
    const hybridResponse: HybridResponse & { apiCall: ApiCallInfo } = {
      executionId: spec.executionId,
      status: 'success',
      datasetId: args.datasetId,
      recordCount,
      summary: `Retrieved ${recordCount} observations from ${args.datasetId}`,
      apiCall: {
        method: spec.apiCall.method,
        url: spec.apiCall.url,
        params: spec.apiCall.params || {}
      }
      // NO data field - client should execute using the spec
    };

    return {
      content: [{
        type: "text",
        text: JSON.stringify(hybridResponse, null, 2)
      }]
    };
  } catch (error) {
    if (error instanceof AxiosError && error.response) {
      throw new Error(`ABS API Error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
    }
    throw error;
  }
}