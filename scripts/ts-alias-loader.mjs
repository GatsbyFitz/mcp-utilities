// Resolver hook so a verification script can import the app's TypeScript
// directly. Node can strip the types itself (--experimental-strip-types); what
// it cannot do is resolve the `@/…` alias from tsconfig, or add the `.ts`
// extension that ESM requires and the source omits. Both are done here.
//
// This exists because the repo has no test framework — scripts/ is where a
// piece of logic gets exercised without one. See .claude/conventions/commands.md.
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** First of `base.ts`, `base.tsx`, `base/index.ts` that exists. */
function withExtension(base) {
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function resolve(specifier, context, next) {
  // The `@/…` alias from tsconfig.
  if (specifier.startsWith("@/")) {
    const resolved = withExtension(path.join(root, specifier.slice(2)));
    if (resolved) return next(pathToFileURL(resolved).href, context);
  }

  // A relative import between two source files. TypeScript writes these
  // without an extension; ESM requires one.
  if (specifier.startsWith(".") && context.parentURL && !path.extname(specifier)) {
    const from = path.dirname(fileURLToPath(context.parentURL));
    const resolved = withExtension(path.resolve(from, specifier));
    if (resolved) return next(pathToFileURL(resolved).href, context);
  }

  return next(specifier, context);
}
