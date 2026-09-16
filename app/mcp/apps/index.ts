import { registerDisplayProcessApp } from "./display-process";

/**
 * MCP Apps: tools paired with an HTML resource the host renders in an iframe.
 *
 * Registered alongside the plain tools, prompts and resources in
 * [route.ts](../route.ts). An App tool is still a normal tool — it returns
 * text and structuredContent, so a host that ignores `_meta.ui` gets a usable
 * answer and only loses the viewer.
 */
export function registerAllApps(server: Parameters<typeof registerDisplayProcessApp>[0]): void {
  registerDisplayProcessApp(server);
}
