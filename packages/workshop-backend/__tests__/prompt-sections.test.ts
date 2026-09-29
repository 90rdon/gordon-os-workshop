// The system prompt's workspace sections: a chat's leading system message keeps the sections it
// started with, and later workspace changes are announced at their place in the conversation, so
// each request extends the previous one (the prefix the provider's prompt cache can read). Drives
// the real runAgent against a real OverseerImpl, with pi's faux provider standing in for the model.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  createFauxCore, fauxAssistantMessage, fauxText, type Api, type Message, type Model,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type {
  AiChatAuthorInfo, AiChatMessageBody, AiModelConfig,
} from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject, OverseerStorage } from "../src/overseer.js";
import { runAgent, type AgentHooks } from "../src/agent";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const OWNER: AiChatAuthorInfo = { type: "user", id: "owner@example.com", name: "Owner" };
const MODEL_CONFIG = {
  provider: "cloudflare", model: "faux-model", apiToken: "",
} satisfies AiModelConfig;

// The OverseerImpl members these tests drive; the class itself is private to overseer.ts.
type Impl = AgentHooks & {
  storage: OverseerStorage;
  nextChatSequence(chatId: number): number;
};

let doCounter = 0;

async function withImpl(fn: (impl: Impl) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`prompt-sections-${++doCounter}`);
  // Element access is how TypeScript lets a test reach the Durable Object's private impl.
  await runInDurableObject(stub, (instance: OverseerDurableObject) => {
    let impl = instance["impl"];
    // Both come from outside the workspace; fixed so the prompt has a section before and after the
    // gadgets.
    impl.describeStandardFormats = async () => "Standard formats: documents.";
    impl.listConnectableVendors = async () => [{ id: "github", displayName: "GitHub" }];
    return fn(impl);
  });
}

function putGadget(impl: Impl, id: number, title: string): void {
  impl.storage.gadgets.put({
    type: "gadget", id, title, created: new Date(0), bindingName: title.toUpperCase(), bindings: {},
  });
}

function startChat(impl: Impl, chatId: number): void {
  impl.storage.chatMeta.put(
      { id: chatId, title: "Chat", started: new Date(0), lastActive: new Date(0) });
}

let clock = 0;

function addMessage(impl: Impl, chatId: number, body: AiChatMessageBody): void {
  impl.storage.chats.put({
    chatId, sequence: impl.nextChatSequence(chatId),
    // Workers clocks don't advance without I/O, and timestamps are indexed uniquely per chat.
    timestamp: new Date(Date.now() + 60_000 * ++clock),
    author: OWNER, ...body,
  });
}

// Runs one agent turn answered by `reply`, returning the messages the model was sent and the
// error the turn failed with, if any.
async function attemptTurn(
    impl: Impl, chatId: number, midConvoSystem: boolean,
    reply = fauxAssistantMessage(fauxText("Done.")),
): Promise<{ request: Message[], error: unknown }> {
  let faux = createFauxCore({ models: [{ id: "faux-model" }] });
  let requests: Message[][] = [];
  faux.setResponses([(context: TranscriptContext) => {
    requests.push(structuredClone(context.messages));
    return reply;
  }]);
  // pi types a model's compat by its API, so the capable model borrows one that declares it.
  let model: Model<Api> = midConvoSystem
      ? {
          ...faux.getModel(), api: "anthropic-messages",
          compat: { supportsMidConvoSystemMessages: true },
        }
      : faux.getModel();
  let error = await runAgent(impl, { model, stream: faux.stream }, chatId,
      { type: "agent", id: "faux-model", name: "Faux" }, new AbortController().signal, OWNER,
      MODEL_CONFIG).then(() => undefined, (caught: unknown) => caught);
  expect(requests).toHaveLength(1);
  return { request: requests[0], error };
}

async function runTurn(impl: Impl, chatId: number, midConvoSystem: boolean): Promise<Message[]> {
  let { request, error } = await attemptTurn(impl, chatId, midConvoSystem);
  expect(error).toBeUndefined();
  return request;
}

function isSectionUpdate(message: Message): boolean {
  return message.role === "system" ||
      (message.role === "user" && typeof message.content === "string" &&
       message.content.startsWith("<system_update"));
}

function sectionNames(message: Message): string[] {
  return message.role === "system" ? Object.keys(message.sections ?? {}) : [];
}

describe.each([
  { name: "a model that accepts mid-conversation system messages", midConvoSystem: true },
  { name: "any other model", midConvoSystem: false },
])("prompt sections, for $name", ({ midConvoSystem }) => {
  it("extends the previous request when gadgets are added and removed", () => withImpl(async impl => {
    putGadget(impl, 100, "App");
    startChat(impl, 1);
    addMessage(impl, 1, { type: "message", message: "Hi" });
    let first = await runTurn(impl, 1, midConvoSystem);
    expect(first.filter(isSectionUpdate)).toEqual([first[0]]);
    expect(sectionNames(first[0])).toContain("gadget APP");

    // Created after the chat started, so the chat has no binding for it.
    putGadget(impl, 101, "Notes");
    addMessage(impl, 1, { type: "message", message: "Next" });
    let second = await runTurn(impl, 1, midConvoSystem);
    expect(second.slice(0, first.length)).toEqual(first);
    expect(second.at(-1)).toMatchObject(midConvoSystem
        ? {
            role: "system", content: "",
            sections: { [`gadget "Notes"`]: expect.stringContaining(`## Gadget "Notes"`) },
          }
        : {
            role: "user",
            content: expect.stringContaining(`Updated system prompt section "gadget "Notes""`),
          });

    impl.storage.gadgets.delete(101);
    addMessage(impl, 1, { type: "message", message: "Third" });
    let third = await runTurn(impl, 1, midConvoSystem);
    expect(third.slice(0, second.length)).toEqual(second);
    expect(third.at(-1)).toMatchObject(midConvoSystem
        ? { role: "system", sections: { [`gadget "Notes"`]: null } }
        : { content: expect.stringContaining(`Removed system prompt section "gadget "Notes"".`) });
  }));

  it("replays each change recorded after the same message as it was sent",
      () => withImpl(async impl => {
    putGadget(impl, 100, "App");
    startChat(impl, 1);
    addMessage(impl, 1, { type: "message", message: "Hi" });
    await runTurn(impl, 1, midConvoSystem);

    // runAgent persists nothing from a failed model request, so the next pass records its change
    // after the same message, as a turn resumed after a restart does.
    putGadget(impl, 101, "Notes");
    addMessage(impl, 1, { type: "message", message: "Next" });
    let failed = await attemptTurn(impl, 1, midConvoSystem,
        fauxAssistantMessage([], { stopReason: "error", errorMessage: "overloaded" }));
    expect(failed.error).toBeDefined();
    putGadget(impl, 102, "Tasks");
    let retried = await runTurn(impl, 1, midConvoSystem);
    expect(retried.slice(0, failed.request.length)).toEqual(failed.request);
    expect(retried.slice(-2).every(isSectionUpdate)).toBe(true);

    addMessage(impl, 1, { type: "message", message: "Third" });
    let next = await runTurn(impl, 1, midConvoSystem);
    expect(next.slice(0, retried.length)).toEqual(retried);
  }));

  it("folds compacted changes into the leading prompt, each section with its kind",
      () => withImpl(async impl => {
    putGadget(impl, 100, "App");
    putGadget(impl, 102, "Tasks");
    startChat(impl, 1);
    addMessage(impl, 1, { type: "message", message: "Hi" });
    await runTurn(impl, 1, midConvoSystem);

    putGadget(impl, 101, "Notes");
    addMessage(impl, 1, { type: "message", message: "Next" });
    await runTurn(impl, 1, midConvoSystem);
    addMessage(impl, 1, {
      type: "slashCommand", request: { id: { builtin: true, commandId: "compact" }, args: "" },
    });
    await runTurn(impl, 1, midConvoSystem);
    addMessage(impl, 1, { type: "message", message: "Third" });
    let compacted = await runTurn(impl, 1, midConvoSystem);

    expect(compacted.filter(isSectionUpdate)).toEqual([compacted[0]]);
    let names = sectionNames(compacted[0]);
    expect(names.toSorted()).toEqual([
      "connections", "formats", `gadget "Notes"`, "gadget APP", "gadget TASKS", "workspace",
    ]);
    expect([names[0], names.at(-1)]).toEqual(["formats", "connections"]);
  }));
});
