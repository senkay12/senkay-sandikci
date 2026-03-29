#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import sql from "mssql";

// Defaults
const DEFAULT_MAX_ROWS = 1000;
const DEFAULT_QUERY_TIMEOUT_MS = 30000;

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
  requestTimeout?: number;
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
    description: "Execute a read-only SQL query on the MSSQL database. Only SELECT queries are allowed. INSERT, UPDATE, DELETE, and other write operations are blocked. Results are limited to max_rows (default 1000). Query timeout is 30 seconds.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The SQL query to execute (read-only)",
        },
        max_rows: {
          type: "number",
          description: "Maximum number of rows to return (default: 1000)",
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
  {
    name: "list_views",
    description: "List all views in the current database",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "list_stored_procedures",
    description: "List all stored procedures in the current database with their schemas",
    inputSchema: {
      type: "object",
      properties: {
        schema: {
          type: "string",
          description: "Filter by schema name (optional)",
        },
      },
    },
  },
  {
    name: "get_foreign_keys",
    description: "Get foreign key relationships for a specific table, or all tables if no table name is provided",
    inputSchema: {
      type: "object",
      properties: {
        table_name: {
          type: "string",
          description: "The name of the table (optional, shows all if omitted)",
        },
      },
    },
  },
  {
    name: "get_indexes",
    description: "Get index information for a specific table",
    inputSchema: {
      type: "object",
      properties: {
        table_name: {
          type: "string",
          description: "The name of the table",
        },
      },
      required: ["table_name"],
    },
  },
  {
    name: "search_columns",
    description: "Search for columns by name across all tables in the database",
    inputSchema: {
      type: "object",
      properties: {
        column_name: {
          type: "string",
          description: "The column name or pattern to search for (supports SQL LIKE wildcards: % and _)",
        },
      },
      required: ["column_name"],
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
    requestTimeout: process.env.MSSQL_QUERY_TIMEOUT
      ? parseInt(process.env.MSSQL_QUERY_TIMEOUT)
      : DEFAULT_QUERY_TIMEOUT_MS,
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
        const maxRows = Math.min(
          Math.max(1, Number(args.max_rows) || DEFAULT_MAX_ROWS),
          DEFAULT_MAX_ROWS
        );

        if (!query) {
          throw new Error("Query is required");
        }

        // Validate read-only
        if (!isReadOnlyQuery(query)) {
          throw new Error(
            "Only read-only queries are allowed. INSERT, UPDATE, DELETE, and other write operations are blocked."
          );
        }

        // Wrap in a row-limited subquery to prevent unbounded results
        const limitedQuery = `SELECT TOP(${maxRows}) * FROM (${query}) AS __limited`;
        const result = await db.request().query(limitedQuery);

        const truncated = result.recordset.length >= maxRows;
        const summary = truncated
          ? `\n\n--- Results truncated to ${maxRows} rows. Use max_rows parameter or add TOP/WHERE to your query. ---`
          : "";

        return {
          content: [
            {
              type: "text",
              text: formatResults(result.recordset) + summary,
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

      case "list_views": {
        const query = `
          SELECT
            TABLE_SCHEMA,
            TABLE_NAME
          FROM INFORMATION_SCHEMA.VIEWS
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

      case "list_stored_procedures": {
        const schema = args.schema as string | undefined;

        let query = `
          SELECT
            ROUTINE_SCHEMA,
            ROUTINE_NAME,
            CREATED,
            LAST_ALTERED
          FROM INFORMATION_SCHEMA.ROUTINES
          WHERE ROUTINE_TYPE = 'PROCEDURE'
        `;

        const req = db.request();

        if (schema) {
          query += ` AND ROUTINE_SCHEMA = @schema`;
          req.input("schema", sql.VarChar, schema);
        }

        query += ` ORDER BY ROUTINE_SCHEMA, ROUTINE_NAME`;

        const result = await req.query(query);

        return {
          content: [
            {
              type: "text",
              text: formatResults(result.recordset),
            },
          ],
        };
      }

      case "get_foreign_keys": {
        const fkTable = args.table_name as string | undefined;

        let query = `
          SELECT
            fk.name AS FK_NAME,
            tp.name AS PARENT_TABLE,
            cp.name AS PARENT_COLUMN,
            tr.name AS REFERENCED_TABLE,
            cr.name AS REFERENCED_COLUMN
          FROM sys.foreign_keys AS fk
          INNER JOIN sys.foreign_key_columns AS fkc
            ON fk.object_id = fkc.constraint_object_id
          INNER JOIN sys.tables AS tp
            ON fkc.parent_object_id = tp.object_id
          INNER JOIN sys.columns AS cp
            ON fkc.parent_object_id = cp.object_id AND fkc.parent_column_id = cp.column_id
          INNER JOIN sys.tables AS tr
            ON fkc.referenced_object_id = tr.object_id
          INNER JOIN sys.columns AS cr
            ON fkc.referenced_object_id = cr.object_id AND fkc.referenced_column_id = cr.column_id
        `;

        const req = db.request();

        if (fkTable) {
          query += ` WHERE tp.name = @tableName OR tr.name = @tableName`;
          req.input("tableName", sql.VarChar, fkTable);
        }

        query += ` ORDER BY tp.name, fk.name`;

        const result = await req.query(query);

        return {
          content: [
            {
              type: "text",
              text: formatResults(result.recordset),
            },
          ],
        };
      }

      case "get_indexes": {
        const idxTable = args.table_name as string;

        if (!idxTable) {
          throw new Error("table_name is required");
        }

        const query = `
          SELECT
            i.name AS INDEX_NAME,
            i.type_desc AS INDEX_TYPE,
            i.is_unique AS IS_UNIQUE,
            i.is_primary_key AS IS_PRIMARY_KEY,
            STRING_AGG(c.name, ', ') WITHIN GROUP (ORDER BY ic.key_ordinal) AS COLUMNS
          FROM sys.indexes AS i
          INNER JOIN sys.index_columns AS ic
            ON i.object_id = ic.object_id AND i.index_id = ic.index_id
          INNER JOIN sys.columns AS c
            ON ic.object_id = c.object_id AND ic.column_id = c.column_id
          WHERE i.object_id = OBJECT_ID(@tableName)
            AND i.name IS NOT NULL
          GROUP BY i.name, i.type_desc, i.is_unique, i.is_primary_key
          ORDER BY i.is_primary_key DESC, i.name
        `;

        const result = await db
          .request()
          .input("tableName", sql.VarChar, idxTable)
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

      case "search_columns": {
        const columnName = args.column_name as string;

        if (!columnName) {
          throw new Error("column_name is required");
        }

        const query = `
          SELECT
            TABLE_SCHEMA,
            TABLE_NAME,
            COLUMN_NAME,
            DATA_TYPE,
            IS_NULLABLE
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE COLUMN_NAME LIKE @columnName
          ORDER BY TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME
        `;

        const result = await db
          .request()
          .input("columnName", sql.VarChar, columnName)
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
