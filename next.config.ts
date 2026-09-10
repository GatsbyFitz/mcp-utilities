import type { NextConfig } from "next";
import { baseURL } from "./baseUrl";
import {withWorkflow} from "workflow/next"

const nextConfig: NextConfig = {
  assetPrefix: baseURL,
  devIndicators: false,
  // mupdf must not be bundled. It is a WASM module whose Node loader calls
  // `createRequire` and resolves its .wasm relative to its own location on
  // disk. Bundling rewrites both: webpack's interop leaves `createRequire`
  // undefined — "TypeError: a is not a function" the moment extractFigures
  // loads it — and it inlines the *build machine's* absolute path to
  // mupdf-wasm.js, which does not exist under /var/task at runtime.
  //
  // Marking it external leaves the package intact and required from
  // node_modules, which is the only arrangement where its own path resolution
  // is true. Next's file tracing carries it into the function.
  serverExternalPackages: ["mupdf"],
};

export default withWorkflow(nextConfig);
