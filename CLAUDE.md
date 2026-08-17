# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

For a feature-level overview of what the MCP server exposes (tools, prompts, resources) and the ingestion pipeline that feeds it, see [README.md](README.md).

## Conventions

This file covers what the system *is*; conventions cover what to *do*. Two mechanisms, loaded differently:

- [.claude/conventions/](.claude/conventions/) — always loaded, every session, via the `@` imports below. Use for architecture/domain knowledge you need regardless of which file you're touching.
- [.claude/rules/](.claude/rules/) — path-scoped, loaded only when editing a matching file. Use for edit-time mechanics specific to one area.

@.claude/conventions/commands.md
@.claude/conventions/data-stores.md
@.claude/conventions/ingestion-pipeline.md
@.claude/conventions/mcp-server.md

| Rule | Scope |
| --- | --- |
| [api-routes.md](.claude/rules/api-routes.md) | `app/api/**/*.ts` — route handler shape, error/response conventions |
| [workflow-steps.md](.claude/rules/workflow-steps.md) | `app/api/upload/workflow.ts`, `app/api/upload/steps/**` — durability, retry semantics, extraction limits |
| [mcp-tools.md](.claude/rules/mcp-tools.md) | `app/mcp/**/*.ts`, `app/hooks/use-mcp-app.ts` — tool registration, citation rendering, MCP Apps |
