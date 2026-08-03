import { registerDocumentsResource } from "./documents";

export function registerAllResources(server: any): void {
  registerDocumentsResource(server);
}
