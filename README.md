# Next.js MCP Utilities

A Next.js app that lets you upload PDF documents, embed them into Upstash Vector, and expose an MCP server with searchable tools over Streamable HTTP.

## What this project does

- Uploads PDF files from the web UI at the root page.
- Extracts text from PDFs, chunks the text, and stores embeddings in Upstash Vector.
- Exposes an MCP endpoint at /mcp using MCP v2 server transport.
- Includes two tools:
  - echo: simple connectivity test tool
  - search_docs: semantic search over indexed document chunks

## Requirements

- Node.js 20 or newer
- pnpm
- Upstash Vector database
- Google embeddings credentials for AI SDK

## Install and run

1. Install dependencies

       pnpm install

2. Start development server

       pnpm dev

3. Open app

       http://localhost:3000

## Ingestion flow

1. Upload a PDF in the UI.
2. Server parses the PDF text.
3. Text is split into chunks.
4. AI SDK generates embeddings using google/gemini-embedding-2 with dimension 1536.
5. Chunks are upserted into Upstash with metadata:
   - text
   - source
   - chunkIndex

## MCP endpoint

- Endpoint: /mcp
- Methods: GET, POST, DELETE
- Transport: Streamable HTTP with stateless session mode

## Registered tools

### echo

**Input**
- message: string, min 1, max 100

**Output**
- text response echoing the input

### search_docs

**Input**
- query: string, min 2, max 1000
- topK: integer, 1 to 10, default 5

**Behavior**
- Embeds the query using AI SDK
- Queries Upstash Vector by similarity
- Returns a text summary and structured match payload with score, source, chunkIndex, and text

If you want, I can also give you a polished full README version with sections for environment variables, troubleshooting, and local testing commands.