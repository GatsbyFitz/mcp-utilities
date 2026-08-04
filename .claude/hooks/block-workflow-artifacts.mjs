#!/usr/bin/env node
// PreToolUse hook: block Edit/Write on generated workflow build artifacts.
// Per CLAUDE.md, app/.well-known/workflow/v1/** and manifest.json are
// gitignored output of withWorkflow() — hand edits are silently clobbered
// on the next build, so refuse the edit rather than let it happen quietly.
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  let event;
  try {
    event = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  const filePath = event?.tool_input?.file_path ?? "";
  const isGenerated =
    /\/app\/\.well-known\/workflow\/v1\//.test(filePath) ||
    /\/app\/\.well-known\/workflow\/manifest\.json$/.test(filePath);

  if (!isGenerated) {
    process.exit(0);
  }

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          `${filePath} is a generated workflow build artifact (compiled by ` +
          `withWorkflow() from "use workflow"/"use step" directives). It is ` +
          `gitignored and rewritten on every build — hand edits are silently ` +
          `lost. Edit the source in app/api/upload/workflow.ts or ` +
          `app/api/upload/steps/ instead.`,
      },
    })
  );
  process.exit(0);
});
