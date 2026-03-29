#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import sql from "mssql";

// MSSQL connection configuration
interface MSSQLConfig {
  user: string;
  password: string;
  server: string;
  database: string;
  options: {
    encrypt: boolean;
    trustServerCertificate: boolean;
  };
  port?: number;
}

// Remove SQL comments and normalize whitespace for safe analysis
function stripComments(query: string): string {
  // Remove block comments (/* ... */), including nested
  let result = query.replace(/\/\*[\s\S]*?\*\//g, " ");
  // Remove line comments (-- ...)
  result = result.replace(/--[^\n]*/g, " ");
  // Collapse whitespace
  return result.replace(/\s+/g, " ").trim();
}

// Validate that query is read-only
function isReadOnlyQuery(query: string): boolean {
  const cleaned = stripComments(query).toUpperCase();

  // Block multiple statements (semicolons)
  if (cleaned.includes(";")) {
    return false;
  }

  // Dangerous keywords — block if they appear as whole words anywhere
  const blockedKeywords = [
    'INSERT',
    'UPDATE',
    'DELETE',
    'DROP',
    'CREATE',
    'ALTER',
    'TRUNCATE',
    'EXEC',
    'EXECUTE',
    'MERGE',
    'GRANT',
    'REVOKE',
    'DENY',
    'BULK',
    'OPENROWSET',
    'OPENDATASOURCE',
    'OPENQUERY',
    'XP_CMDSHELL',
    'SP_EXECUTESQL',
    'SP_CONFIGURE',
    'RECONFIGURE',
    'SHUTDOWN',
    'DBCC',
    'BACKUP',
    'RESTORE',
    'INTO',        // SELECT INTO creates tables
    'WRITETEXT',
    'UPDATETEXT',
  ];

  for (const keyword of blockedKeywords) {
    // Match as whole word using word boundary check
    const regex = new RegExp(`\\b${keyword}\\b`);
    if (regex.test(cleaned)) {
      return false;
    }
  }

  // Only allow queries that start with SELECT or WITH (CTEs)
  if (!cleaned.startsWith("SELECT") && !cleaned.startsWith("WITH")) {
    return false;
  }

  return true;
}

// Format query results for display
function formatResults(recordset: any[]): string {
  if (!recordset || recordset.length === 0) {
    return "No results found.";
  }

  return JSON.stringify(recordset, null, 2);
}

// Create MCP server
const server = new Server(
  {
    name: "mssql-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Available tools
const TOOLS: Tool[] = [
  {
    name: "query_mssql",
    description: "Execute a read-only SQL query on the MSSQL database. Only SELECT queries are allowed. INSERT, UPDATE, DELETE, and other write operations are blocked.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The SQL query to execute (read-only)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "list_tables",
    description: "List all tables in the current database",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "describe_table",
    description: "Get the schema information for a specific table",
    inputSchema: {
      type: "object",
      properties: {
        table_name: {
          type: "string",
          description: "The name of the table to describe",
        },
      },
      required: ["table_name"],
    },
  },
];

// Get database configuration from environment variables
function getConfig(): MSSQLConfig {
  return {
    user: process.env.MSSQL_USER || "sa",
    password: process.env.MSSQL_PASSWORD || "",
    server: process.env.MSSQL_SERVER || "localhost",
    database: process.env.MSSQL_DATABASE || "master",
    port: process.env.MSSQL_PORT ? parseInt(process.env.MSSQL_PORT) : 1433,
    options: {
      encrypt: process.env.MSSQL_ENCRYPT === "true",
      trustServerCertificate: process.env.MSSQL_TRUST_CERT !== "false",
    },
  };
}

// Shared connection pool
let pool: sql.ConnectionPool | null = null;

async function getPool(): Promise<sql.ConnectionPool> {
  if (pool && pool.connected) {
    return pool;
  }
  const config = getConfig();
  pool = await sql.connect(config);
  return pool;
}

// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    const db = await getPool();

    switch (name) {
      case "query_mssql": {
        const query = args.query as string;

        if (!query) {
          throw new Error("Query is required");
        }

        // Validate read-only
        if (!isReadOnlyQuery(query)) {
          throw new Error(
            "Only read-only queries are allowed. INSERT, UPDATE, DELETE, and other write operations are blocked."
          );
        }

        const result = await db.request().query(query);

        return {
          content: [
            {
              type: "text",
              text: formatResults(result.recordset),
            },
          ],
        };
      }

      case "list_tables": {
        const query = `
          SELECT
            TABLE_SCHEMA,
            TABLE_NAME,
            TABLE_TYPE
          FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_TYPE = 'BASE TABLE'
          ORDER BY TABLE_SCHEMA, TABLE_NAME
        `;

        const result = await db.request().query(query);

        return {
          content: [
            {
              type: "text",
              text: formatResults(result.recordset),
            },
          ],
        };
      }

      case "describe_table": {
        const tableName = args.table_name as string;

        if (!tableName) {
          throw new Error("table_name is required");
        }

        const query = `
          SELECT
            COLUMN_NAME,
            DATA_TYPE,
            CHARACTER_MAXIMUM_LENGTH,
            IS_NULLABLE,
            COLUMN_DEFAULT
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_NAME = @tableName
          ORDER BY ORDINAL_POSITION
        `;

        const result = await db
          .request()
          .input("tableName", sql.VarChar, tableName)
          .query(query);

        return {
          content: [
            {
              type: "text",
              text: formatResults(result.recordset),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: `Error: ${errorMessage}`,
        },
      ],
      isError: true,
    };
  }
});

// Graceful shutdown
async function shutdown() {
  if (pool) {
    await pool.close();
    pool = null;
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MSSQL MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
