import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

const handler = createMcpHandler(
  async (server) => {
    try {
      server.registerTool(
        "echo",
        {
          title: "echo",
          description: "Echo a message",
          inputSchema: z.object({
            message: z.string().min(1).max(100),
          }),
        },
        async ({ message }) => ({
          content: [{ type: "text", text: `Tool echo: ${message}` }],
        })
      );

      server.registerTool(
        "echo2",
        {
          title: "echo2",
          description: "Echo a message",
          inputSchema: z.object({
            message: z.string().min(1).max(100),
          }),
        },
        async ({ message }) => ({
          content: [{ type: "text", text: `Tool echo: ${message}` }],
        })
      );
    } catch (err) {
      console.error("[mcp init error]", String(err));
      throw err;
    }
  },
  {},
  {
    basePath: "",
    verboseLogs: true,
    maxDuration: 800,
    disableSse: true,
  }
);

export { handler as GET, handler as POST, handler as DELETE };