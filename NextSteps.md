## Backlog

### High
- Build Knowledgebase with 50 Documents
- Publish MCP Server

### Med
- Implement a Researcher Agent - With SubAgents (maybe using vercel eve)
- Implement image intelligence to save images and retrieve when required
- Implement a request doc tool
- Asynchronous batch processing for Markdown creation — move `createMarkdown` to a batch API (roughly half the per-token cost; ingestion is a durable background workflow with no latency requirement)
- Semantic based chunking strategy
- Explore reranking improvements
- Add an ingestion workflow visualisation using https://elements.ai-sdk.dev/examples/workflow

### Low
- Implement Submit Market Document Tool
- Implement Logging (once supported by Claude.ai)
- Implement MCP progress notifications (once supported by Claude.ai — the upload page's own progress is done, see below)
- Additional advanced techniques TBD

### Done
- ✓ Implement a resource prompt to return all documents in the database
- ✓ Implement Prompts into the MCP
- ✓ Implement Claude Code Commands for Confirming Embedding and Graph Database integrity
- ✓ Contextual Retrieval Pre-Processing
- ✓ Added NextAuth to upload pathway
- ✓ Per-step ingestion progress tracking (`/api/uploadStatus`, polled by the upload page)
- ✓ Reject duplicate uploads by file name
- ✓ Per-step failure detail, and retry a failed ingestion from its saved Markdown
- ✓ Client uploads go straight to Blob, lifting the 4.5 MB request-body limit

### Trashed
- Implement Sampling! (Deprecated)

## Notes

### Confirming Embedding and Graph Database Integrity
Run `/check-embedding-integrity` — see [.claude/commands/check-embedding-integrity.md](.claude/commands/check-embedding-integrity.md).
