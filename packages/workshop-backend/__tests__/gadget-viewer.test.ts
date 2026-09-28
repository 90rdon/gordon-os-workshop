// A gadget learns who each UI connection belongs to by defining `connectViewer(viewer)`: the
// connection's calls then go to whatever that returns, never to the Gadget itself (see
// OverseerImpl.getGadgetFacet).
//
// Runs real gadgets, loaded from real commits, inside a real OverseerDurableObject.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";
import { openFakeOverseer } from "./fixtures.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const ADA = { id: "ada@example.com", name: "Ada", role: "use" };

// Await a stub call's rejection with a single handler: expect(...).rejects forks the underlying
// JsRpcPromise (each .then mints a fresh RPC continuation), and the leftover copy is reported as
// an unhandled rejection (see overseer-hooks.test.ts).
async function expectRejection(call: Promise<unknown>, message: string): Promise<void> {
  let caught: unknown;
  let rejected = false;
  try { await call; } catch (err) { rejected = true; caught = err; }
  expect(rejected).toBe(true);
  expect(String(caught)).toContain(message);
}

// Hands each connection a ViewerSession that knows its viewer and records who left; hello() is on
// the Gadget alone.
const VIEWER_GADGET = `
import { DurableObject, RpcTarget } from "cloudflare:workers";

export class Gadget extends DurableObject {
  connectViewer(viewer) {
    return new ViewerSession(this, viewer);
  }

  hello() {
    return "hi";
  }

  lastLeft() {
    return this.ctx.storage.kv.get("lastLeft") ?? null;
  }
}

class ViewerSession extends RpcTarget {
  constructor(gadget, viewer) {
    super();
    this.gadget = gadget;
    this.viewer = viewer;
  }

  whoami() {
    return this.viewer;
  }

  [Symbol.dispose]() {
    this.gadget.ctx.storage.kv.put("lastLeft", this.viewer.id);
  }
}
`;

let doCounter = 0;

async function withGadget(serverJs: string, fn: (impl: any) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`gadget-viewer-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    let commitId = await impl.gitStore.writeFilesAsCommit(new Map([["server.js", serverJs]]), {
      parents: [],
      author: { name: "Alice", email: "alice@example.com" },
      message: "test commit",
      timestamp: new Date(1700000000_000),
    });
    impl.storage.gadgets.put({
      type: "gadget", id: 1, title: "G", created: new Date(0), bindingName: "G",
      bindings: {}, commitId,
    });
    await fn(impl);
  });
}

describe("gadget viewers", () => {
  // openFakeOverseer's "build" client is the owner.
  it.each([
    ["the owner", "build", "owner"],
    ["a use collaborator", "use", "use"],
  ] as const)("gives %s a session that knows who they are",
      (_who, clientRole, role) => withGadget(VIEWER_GADGET, async impl => {
    let client = await openFakeOverseer({}, { role: clientRole, impl: {
      getGadgetRecord: (id: number) => impl.getGadgetRecord(id),
      getGadgetFacet: (...args: unknown[]) => impl.getGadgetFacet(...args),
      recordGadgetAnalytics: () => {},
      users: {
        idFromString: (id: string) => id,
        get: () => ({
          id: { toString: () => "ada-user-do" },
          whoami: async () => ({ type: "user", id: "ada@example.com", name: "Ada" }),
          recordSharedGadgetOpen: async () => {},
        }),
      },
    } });
    using gadget = await client.getGadget(1);
    using connection: any = await gadget.connectToGadget();

    expect(await connection.whoami()).toEqual({ id: "ada@example.com", name: "Ada", role });
    // The connection reaches only the session, never the Gadget -- nor its connectViewer().
    await expectRejection(connection.hello(), 'does not implement the method "hello"');
  }));

  it("connects a gadget without connectViewer() to the Gadget itself, as before",
      () => withGadget(`
import { DurableObject } from "cloudflare:workers";

export class Gadget extends DurableObject {
  hello() {
    return "hi";
  }
}
`, async impl => {
    using connection = await impl.getGadgetFacet(1, undefined, "use", ADA);
    expect(await connection.hello()).toBe("hi");
  }));

  it("never lets a connection reach a gadget that refused its viewer", () => withGadget(`
import { DurableObject } from "cloudflare:workers";

export class Gadget extends DurableObject {
  connectViewer(viewer) {
    throw new Error("Only the owner may use this gadget.");
  }

  hello() {
    return "hi";
  }
}
`, async impl => {
    using connection = await impl.getGadgetFacet(1, undefined, "use", ADA);
    await expectRejection(connection.hello(), "Only the owner may use this gadget.");
  }));

  it("asks connectViewer() again after it fails", () => withGadget(`
import { DurableObject, RpcTarget } from "cloudflare:workers";

export class Gadget extends DurableObject {
  connectViewer(viewer) {
    if (!this.ready) {
      this.ready = true;
      throw new Error("Not ready yet.");
    }
    return new ViewerSession(viewer);
  }
}

class ViewerSession extends RpcTarget {
  constructor(viewer) {
    super();
    this.viewer = viewer;
  }

  whoami() {
    return this.viewer;
  }
}
`, async impl => {
    using connection = await impl.getGadgetFacet(1, undefined, "use", ADA);
    await expectRejection(connection.whoami(), "Not ready yet.");
    expect(await connection.whoami()).toEqual(ADA);
  }));

  it("lets only the Workshop name a viewer", () => withGadget(VIEWER_GADGET, async impl => {
    // Another gadget's binding to this one; the agent's executeCode binding is the same path.
    using bound = await impl.startGatekeeperSession(
        { type: "gadget", id: 1 }, { from: "gadget", gadgetId: 2 });
    await expectRejection(bound.connectViewer({ ...ADA, role: "owner" }),
        "reserved for the Workshop");
  }));

  it("disposes the session when its connection closes", () => withGadget(VIEWER_GADGET,
      async impl => {
    let connection = await impl.getGadgetFacet(1, undefined, "use", ADA);
    await connection.whoami();
    connection[Symbol.dispose]();

    using gadget = await impl.getGadgetFacet(1);
    // Disposal reaches the gadget asynchronously, with nothing to await but its effect.
    await expect.poll(() => gadget.lastLeft()).toBe("ada@example.com");
  }));
});
