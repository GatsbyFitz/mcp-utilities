import { registerResearchTopicPrompt } from "./research-topic";

export function registerAllPrompts(server: any): void {
  registerResearchTopicPrompt(server);
}
