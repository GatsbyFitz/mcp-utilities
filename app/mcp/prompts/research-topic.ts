import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

export function registerResearchTopicPrompt(server: McpServer): void {
  server.registerPrompt(
    "research-topic",
    {
      title: "Research Topic",
      description:
        "Research a topic across the document index and knowledge graph, " +
        "then synthesize the findings with citations.",
      argsSchema: z.object({
        topic: z.string().min(2).max(500),
      }),
    },
    ({ topic }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text:
              `Research "${topic}" using the available tools, in this order:\n\n` +
              `1. Call search_docs with query "${topic}" for direct factual ` +
              `content on the topic.\n` +
              `2. Call search_graph with query "${topic}" for relationships, ` +
              `obligations, or dependencies connected to it.\n` +
              `3. Synthesize both result sets into a single answer. Cite every ` +
              `claim using the citation headers each tool returns (document ` +
              `title, version, and page range), and list each source URL at ` +
              `most once. If the two tools disagree or one finds nothing, say ` +
              `so rather than papering over it.`,
          },
        },
      ],
    })
  );
}
