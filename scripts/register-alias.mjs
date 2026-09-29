// Registers ts-alias-loader.mjs as a module-resolution hook. Hooks run on a
// separate thread, so they have to be registered from a file loaded with
// --import rather than from the script itself.
import { register } from "node:module";
register("./ts-alias-loader.mjs", import.meta.url);
