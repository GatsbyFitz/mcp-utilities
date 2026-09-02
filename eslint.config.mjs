import { fixupConfigRules } from "@eslint/compat";
import { FlatCompat } from "@eslint/eslintrc";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const config = [
  {
    // Build output, all of it gitignored and none of it hand-written. Without
    // this, `pnpm lint` passes on a clean tree and fails right after
    // `pnpm build` on a minified chunk — the two commands CLAUDE.md names as
    // the only automated verification this repo has.
    //
    // `app/.well-known/workflow/v1/` is the Workflow SDK's compiled output
    // from the "use workflow"/"use step" directives; it regenerates on every
    // build and must never be edited, so linting it can only ever produce
    // findings nobody may act on.
    ignores: [".next/**", "app/.well-known/workflow/v1/**"],
  },
  ...fixupConfigRules(compat.extends("next/core-web-vitals")),
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
];

export default config;