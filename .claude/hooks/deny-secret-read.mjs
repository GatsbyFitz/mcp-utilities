#!/usr/bin/env node
// PreToolUse hook: unconditional deny. The settings.json `if` clause already
// scoped which Bash commands reach this script (direct reads of .env.local
// or a known secret env var) — this just emits the deny decision.
console.log(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        "Refusing to run this command: it reads .env.local or a secret env " +
        "var directly, which would print a real credential " +
        "(Neo4j/Neon/Upstash/Blob/AI Gateway) into the transcript. If you " +
        "need to confirm a var is set, check for its presence only, e.g. " +
        '`[ -n "$DATABASE_URL" ] && echo set`, rather than printing the value.',
    },
  })
);
process.exit(0);
