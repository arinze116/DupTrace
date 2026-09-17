import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import * as z from "zod/v4";

const app = createMcpExpressApp();

const handler = createMcpHandler(() => {
  const server = new McpServer({
    name: "amazon-alexa-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "system_status",
    {
      description:
        "Returns the current status of the Amazon Alexa MCP development server.",
      inputSchema: z.object({}),
    },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "ok",
            service: "amazon-alexa-mcp",
            timestamp: new Date().toISOString(),
          }),
        },
      ],
    })
  );

  return server;
});

const nodeHandler = toNodeHandler(handler);

app.all("/mcp", (req, res) => {
  void nodeHandler(req, res, req.body);
});

const port = Number(process.env.PORT || 3000);

app.listen(port, "127.0.0.1", () => {
  console.log(
    "MCP server listening on http://127.0.0.1:" + port + "/mcp"
  );
});
