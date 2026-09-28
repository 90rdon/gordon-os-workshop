import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { AiChatAuthorInfo, AiChatMetadata } from "@gadgets/workshop-shared/api";
import type { AgentStepUsage } from "../src/agent.js";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const AUTHOR: AiChatAuthorInfo = { type: "agent", id: "model-id", name: "Model" };

describe("AI Gateway cost persistence", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("retries and records a cross-account log cost on the matching chat and gadget", async () => {
    const fetchMock = vi.fn(async () => fetchMock.mock.calls.length === 1
      ? new Response(null, { status: 404 })
      : Response.json({ success: true, result: { cost: 1.25 } }));
    vi.stubGlobal("fetch", fetchMock);

    const stub = env.TEST_OVERSEER.getByName("ai-gateway-cost");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      const overseer = instance as unknown as {
        impl: {
          storage: {
            chatMeta: {
              put(meta: AiChatMetadata): void;
              get(id: number): AiChatMetadata | undefined;
            };
            totalCost: { get(): number };
          };
          addChatMessages(
            chatId: number,
            author: AiChatAuthorInfo,
            messages: [],
            usage?: AgentStepUsage,
          ): void;
        };
      };
      overseer.impl.storage.chatMeta.put({
        id: 7,
        title: "Chat",
        started: new Date(0),
        lastActive: new Date(0),
      });

      overseer.impl.addChatMessages(7, AUTHOR, [], {
        aiGatewayLogId: "log-id",
        aiGatewayLogRoute: {
          accountId: "gateway-account-id",
          gateway: "platform-gateway",
          apiToken: "read-run-token",
        },
      });

      await vi.waitFor(() => {
        expect(overseer.impl.storage.chatMeta.get(7)?.totalCost).toBe(1.25);
      }, { timeout: 3000 });
      expect(overseer.impl.storage.totalCost.get()).toBe(1.25);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 5000);

  it("accumulates prompt tokens across steps, so a chat's cache share covers the whole chat",
      async () => {
    const stub = env.TEST_OVERSEER.getByName("prompt-token-accounting");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      const overseer = instance as unknown as {
        impl: {
          storage: { chatMeta: {
            put(meta: AiChatMetadata): void;
            get(id: number): AiChatMetadata | undefined;
          } };
          addChatMessages(
            chatId: number, author: AiChatAuthorInfo, messages: [], usage?: AgentStepUsage): void;
        };
      };
      overseer.impl.storage.chatMeta.put(
        { id: 9, title: "Chat", started: new Date(0), lastActive: new Date(0) });

      // A cold first step writes the prefix; the next reads it back.
      overseer.impl.addChatMessages(9, AUTHOR, [], {
        totalTokens: 1_200,
        promptTokens: { uncached: 200, cacheRead: 0, cacheWrite: 800 },
      });
      overseer.impl.addChatMessages(9, AUTHOR, [], {
        totalTokens: 1_400,
        promptTokens: { uncached: 100, cacheRead: 800, cacheWrite: 100 },
      });

      const meta = overseer.impl.storage.chatMeta.get(9);
      expect(meta?.promptTokens).toEqual({ uncached: 300, cacheRead: 800, cacheWrite: 900 });
      // totalTokens still measures only the last step, so it cannot stand in for this.
      expect(meta?.totalTokens).toBe(1_400);
    });
  });
});
