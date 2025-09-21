#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { HybridExecutionService } from './services/HybridExecutionService.js';

// Initialize hybrid execution service
const hybridService = new HybridExecutionService();

const server = new Server(
  {
    name: "abs-mcp-server",
    version: "0.1.0",
    description: "Access Australian Bureau of Statistics (ABS) data"
  },
  {
    capabilities: {
      tools: {
        list: true,
        call: true
      }
    }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "query_dataset",
        description: "Query a specific ABS dataset - returns execution spec for client-side data retrieval",
        inputSchema: {
          type: "object",
          required: ["datasetId"],
          properties: {
            datasetId: {
              type: "string",
              description: "ID of the dataset to query (e.g., C21_G01_LGA)"
            }
          }
        }
      },
      {
        name: "execute_direct",
        description: "Execute a query directly using execution ID",
        inputSchema: {
          type: "object",
          required: ["executionId"],
          properties: {
            executionId: {
              type: "string",
              description: "Execution ID from previous query"
            }
          }
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "query_dataset":
        return await handleQueryDataset(args);

      case "execute_direct":
        return await handleExecuteDirect(args);

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Error executing tool ${request.params.name}: ${errorMessage}`);
  }
});

async function handleQueryDataset(args: any) {
  if (!args?.datasetId || typeof args.datasetId !== "string") {
    throw new Error("datasetId is required and must be a string");
  }

  const executionSpec = await hybridService.generateExecutionSpec({
    toolName: "query_dataset",
    parameters: args
  });

  // Always return spec only - never include data in LLM response
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        ...executionSpec,
        status: "ready",
        datasetId: args.datasetId,
        message: "Use execute_direct tool with this executionId to fetch data"
      }, null, 2)
    }],
    _meta: executionSpec
  };
}

async function handleExecuteDirect(args: any) {
  if (!args?.executionId) {
    throw new Error("executionId is required");
  }

  const result = await hybridService.executeSpec(args.executionId);

  if (result.status === 'error') {
    throw new Error(result.error || 'Failed to execute query');
  }

  return {
    content: [{
      type: "text",
      text: JSON.stringify(result.data, null, 2)
    }]
  };
}

async function main() {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Server started successfully");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Server failed to start:", errorMessage);
    process.exit(1);
  }
}

main();