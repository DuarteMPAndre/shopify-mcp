#!/usr/bin/env node

import { randomUUID, timingSafeEqual } from "node:crypto";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import cors from "cors";
import dotenv from "dotenv";
import minimist from "minimist";
import { GraphQLClient } from "graphql-request";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from
  "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from
  "@modelcontextprotocol/sdk/types.js";

import { ShopifyAuth } from "./lib/shopifyAuth.js";
import { tools } from "./tools/registry.js";

dotenv.config();

const argv = minimist(process.argv.slice(2));

const SHOPIFY_ACCESS_TOKEN =
  argv.accessToken || process.env.SHOPIFY_ACCESS_TOKEN;

const SHOPIFY_CLIENT_ID =
  argv.clientId || process.env.SHOPIFY_CLIENT_ID;

const SHOPIFY_CLIENT_SECRET =
  argv.clientSecret || process.env.SHOPIFY_CLIENT_SECRET;

const MYSHOPIFY_DOMAIN =
  argv.domain || process.env.MYSHOPIFY_DOMAIN;

const SHOPIFY_API_VERSION =
  argv.apiVersion ||
  process.env.SHOPIFY_API_VERSION ||
  "2026-01";

const MCP_API_KEY = process.env.MCP_API_KEY;

const useClientCredentials = Boolean(
  SHOPIFY_CLIENT_ID && SHOPIFY_CLIENT_SECRET,
);

if (!SHOPIFY_ACCESS_TOKEN && !useClientCredentials) {
  console.error("Shopify authentication credentials are required.");
  process.exit(1);
}

if (!MYSHOPIFY_DOMAIN) {
  console.error("MYSHOPIFY_DOMAIN is required.");
  process.exit(1);
}

if (!MCP_API_KEY) {
  console.error("MCP_API_KEY is required.");
  process.exit(1);
}

process.env.MYSHOPIFY_DOMAIN = MYSHOPIFY_DOMAIN;

let accessToken: string;
let auth: ShopifyAuth | null = null;

if (useClientCredentials) {
  auth = new ShopifyAuth({
    clientId: SHOPIFY_CLIENT_ID!,
    clientSecret: SHOPIFY_CLIENT_SECRET!,
    shopDomain: MYSHOPIFY_DOMAIN,
  });

  accessToken = await auth.initialize();
} else {
  accessToken = SHOPIFY_ACCESS_TOKEN!;
}

process.env.SHOPIFY_ACCESS_TOKEN = accessToken;

const shopifyClient = new GraphQLClient(
  `https://${MYSHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
  {
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
  },
);

if (auth) {
  auth.setGraphQLClient(shopifyClient);
}

for (const tool of tools) {
  tool.initialize(shopifyClient);
}

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "shopify-customer-support",
    version: "1.0.0",
    description:
      "Read-only Shopify tools for authorised customer-support staff.",
  });

  for (const tool of tools) {
    server.tool(
      tool.name,
      tool.schema.shape,
      async (args) => {
        try {
          const result = await tool.execute(args);

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result),
              },
            ],
          };
        } catch (error: unknown) {
          const message =
            error instanceof Error
              ? error.message
              : "Unknown Shopify error";

          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: message,
                }),
              },
            ],
          };
        }
      },
    );
  }

  return server;
}

function tokenMatches(received: string, expected: string): boolean {
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);

  if (receivedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(receivedBuffer, expectedBuffer);
}

function authenticate(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const authorization = req.header("authorization");

  if (!authorization?.startsWith("Bearer ")) {
    res.status(401).json({
      error: "Missing bearer token",
    });
    return;
  }

  const receivedToken = authorization.slice("Bearer ".length);

  if (!tokenMatches(receivedToken, MCP_API_KEY!)) {
    res.status(403).json({
      error: "Invalid bearer token",
    });
    return;
  }

  next();
}

type ActiveSession = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
};

const sessions = new Map<string, ActiveSession>();

const app = express();
const port = Number(process.env.PORT || 3000);

app.set("trust proxy", 1);

app.use(
  cors({
    origin: false,
    methods: ["GET", "POST", "DELETE"],
    allowedHeaders: [
      "authorization",
      "content-type",
      "mcp-session-id",
      "mcp-protocol-version",
      "last-event-id",
    ],
    exposedHeaders: [
      "mcp-session-id",
      "mcp-protocol-version",
    ],
  }),
);

app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "shopify-customer-support-mcp",
  });
});

app.post(
  "/mcp",
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const sessionId = req.header("mcp-session-id");

      if (sessionId) {
        const session = sessions.get(sessionId);

        if (!session) {
          res.status(404).json({
            error: "Unknown MCP session",
          });
          return;
        }

        await session.transport.handleRequest(req, res, req.body);
        return;
      }

      if (!isInitializeRequest(req.body)) {
        res.status(400).json({
          error: "MCP session has not been initialised",
        });
        return;
      }

      const server = createMcpServer();

      let transport: StreamableHTTPServerTransport;

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),

        onsessioninitialized: (newSessionId: string) => {
          sessions.set(newSessionId, {
            server,
            transport,
          });
        },
      });

      transport.onclose = () => {
        const currentSessionId = transport.sessionId;

        if (currentSessionId) {
          sessions.delete(currentSessionId);
        }
      };

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error: unknown) {
      console.error("MCP request failed:", error);

      if (!res.headersSent) {
        res.status(500).json({
          error: "Internal MCP server error",
        });
      }
    }
  },
);

app.get(
  "/mcp",
  authenticate,
  async (req: Request, res: Response) => {
    const sessionId = req.header("mcp-session-id");

    if (!sessionId) {
      res.status(400).json({
        error: "Missing MCP session ID",
      });
      return;
    }

    const session = sessions.get(sessionId);

    if (!session) {
      res.status(404).json({
        error: "Unknown MCP session",
      });
      return;
    }

    await session.transport.handleRequest(req, res);
  },
);

app.delete(
  "/mcp",
  authenticate,
  async (req: Request, res: Response) => {
    const sessionId = req.header("mcp-session-id");

    if (!sessionId) {
      res.status(400).json({
        error: "Missing MCP session ID",
      });
      return;
    }

    const session = sessions.get(sessionId);

    if (!session) {
      res.status(404).json({
        error: "Unknown MCP session",
      });
      return;
    }

    await session.transport.handleRequest(req, res);
    sessions.delete(sessionId);
  },
);

app.listen(port, "0.0.0.0", () => {
  console.log(
    `Shopify support MCP running at http://localhost:${port}`,
  );
});