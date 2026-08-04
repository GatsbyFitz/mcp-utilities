#!/usr/bin/env node
// PreToolUse hook: deny Bash commands that would print .env.local or a
// secret env var straight into the transcript. Per CLAUDE.md, .env.local
// holds real credentials (Neo4j, Neon, Upstash, Blob, AI Gateway) that
// should never end up in a captured session log.
const SECRET_VARS = [
  "NEO4J_PASSWORD",
  "NEO4J_URI",
  "NEO4J_USERNAME",
  "DATABASE_URL",
  "BLOB_READ_WRITE_TOKEN",
  "AI_GATEWAY_API_KEY",
  "UPSTASH_VECTOR_REST_TOKEN",
  "UPSTASH_VECTOR_REST_URL",
];

let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  let event;
  try {
    event = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  const command = event?.tool_input?.command ?? "";

  const readsEnvFile = /\.env(\.local)?\b/.test(command);
  const readsSecretVar = SECRET_VARS.some((name) =>
    new RegExp(`\\$\\{?${name}\\}?\\b`).test(command)
  );

  if (!readsEnvFile && !readsSecretVar) {
    process.exit(0);
  }

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          `Refusing to run this command: it reads .env.local or a secret ` +
          `env var directly, which would print a real credential ` +
          `(Neo4j/Neon/Upstash/Blob/AI Gateway) into the transcript. If you ` +
          `need to confirm a var is set, check for its presence only, e.g. ` +
          `\`[ -n "$DATABASE_URL" ] && echo set\`, rather than printing the value.`,
      },
    })
  );
  process.exit(0);
});
