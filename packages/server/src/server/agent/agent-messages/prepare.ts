import type { PluginAgentPromptRequest } from "@getpaseo/plugin/server";
import type { AgentManager } from "../agent-manager.js";
import type { AgentStorage } from "../agent-storage.js";
import type { AgentPromptContentBlock, AgentPromptInput } from "../agent-sdk-types.js";
import { describeHookAgent } from "../../plugins/lifecycle/index.js";
import { prepareAgentMessage, renderAgentMessageText, type AgentPromptSource } from "./envelope.js";

export interface AgentMessagePreparationDependencies {
  agentManager: Pick<AgentManager, "getAgent" | "hasAgentPromptHook" | "beforeAgentPrompt">;
  agentStorage: Pick<AgentStorage, "get">;
}

export interface AgentMessagePreparation {
  recipientId: string;
  prompt: AgentPromptInput;
  source?: AgentPromptSource;
  messageId?: string;
}

async function describeRecipient(
  dependencies: AgentMessagePreparationDependencies,
  recipientId: string,
): Promise<PluginAgentPromptRequest["agent"] | null> {
  const live = dependencies.agentManager.getAgent(recipientId);
  if (live) return describeHookAgent({ ...live, title: live.config.title });
  const record = await dependencies.agentStorage.get(recipientId);
  return record ? describeHookAgent(record) : null;
}

function describeSource(source: AgentPromptSource): PluginAgentPromptRequest["source"] {
  const common = {
    agentId: source.agentId,
    title: source.title ?? null,
    serverId: source.serverId ?? null,
  };
  return source.kind === "agent-notification"
    ? { kind: source.kind, ...common, event: source.event }
    : { kind: source.kind, ...common };
}

function withText(prompt: AgentPromptInput, text: string): AgentPromptInput {
  if (typeof prompt === "string") return text;
  const images = prompt.filter((block) => block.type === "image");
  const blocks: AgentPromptContentBlock[] = text ? [{ type: "text", text }] : [];
  return [...blocks, ...images];
}

/**
 * Format an agent-originated prompt for its recipient, running the `agent.prompt`
 * before hook first. A hook failure rejects; callers decide what that means for them.
 * Human prompts (no source) and daemons without the hook registered take the
 * unchanged `prepareAgentMessage` path.
 */
export async function prepareAgentMessageForAgent(
  dependencies: AgentMessagePreparationDependencies,
  input: AgentMessagePreparation,
): Promise<{ prompt: AgentPromptInput; messageId?: string }> {
  const { source } = input;
  if (!source || !dependencies.agentManager.hasAgentPromptHook()) {
    return prepareAgentMessage(input.prompt, source, input.messageId);
  }
  const agent = await describeRecipient(dependencies, input.recipientId);
  if (!agent) return prepareAgentMessage(input.prompt, source, input.messageId);
  const text = renderAgentMessageText(input.prompt);
  const result = await dependencies.agentManager.beforeAgentPrompt({
    agent,
    source: describeSource(source),
    text,
    delivery: "envelope",
  });
  const prompt = result.text === text ? input.prompt : withText(input.prompt, result.text);
  if (result.delivery === "plain") {
    // Plain text goes through the human path, so a body that looks like an envelope is quoted.
    return prepareAgentMessage(withText(input.prompt, result.text), undefined, input.messageId);
  }
  return prepareAgentMessage(prompt, source, input.messageId);
}
