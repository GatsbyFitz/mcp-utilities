#!/usr/bin/env node
// PostToolUse hook: after Edit/Write touches app/mcp/**/*.ts, run pnpm type-check
// so drift under the MCP server surfaces immediately instead of at the next
// manual verify pass. See .claude/skills/verify-mcp-server for the fuller check.
import { execSync } from "node:child_process";

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
  if (!/\/app\/mcp\/.*\.ts$/.test(filePath)) {
    process.exit(0);
  }

  try {
    execSync("pnpm type-check", { cwd: event.cwd, stdio: "pipe" });
    process.exit(0);
  } catch (err) {
    process.stderr.write(
      `pnpm type-check failed after editing ${filePath}:\n\n` +
        (err.stdout?.toString() ?? "") +
        (err.stderr?.toString() ?? "")
    );
    process.exit(2);
  }
});
