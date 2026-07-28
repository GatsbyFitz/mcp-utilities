---
paths:
  - "app/api/**/*.ts"
---

# API route conventions

Applies to route handlers under [app/api/](../../app/api/). Note this project has no `src/` — App Router code lives at the repo root under `app/`.

- Handlers are thin. A route validates input, kicks off work, and shapes the response; it does not embed pipeline logic. `POST /api/upload` only reads the form data and calls `start()` — all real work lives in `"use step"` functions.
- Return `NextResponse.json(...)`. Never return a bare object.
- Wrap DB reads in `try/catch`, log with a `[routeName]` prefix, and return `{ success: false, error: "<message>" }` with an explicit status. Follow [returnKnowledgeBase/route.ts](../../app/api/returnKnowledgeBase/route.ts).
- Never leak a raw driver or provider error message to the client — log the real error server-side, return a generic message.
- Convert `snake_case` Postgres columns to `camelCase` at the route boundary, coalescing nullable columns with `?? null`. Callers should never see `size_bytes`.
- Use the `sql` tagged template from [lib/db.ts](../../lib/db.ts) with interpolated values as parameters. Do not build query strings by concatenation.
- `middleware.ts` already applies permissive CORS to every route and handles `OPTIONS`. Do not add per-route CORS headers.
- New route directories are automatically covered by the middleware matcher, which excludes only `/.well-known/workflow/`. Do not add paths to that exclusion.
