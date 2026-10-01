// The entrypoints the overseer mints through `ctx.exports`: the loopbacks behind a dynamic
// isolate's env bindings, the agent's `self` object, tail workers and hook callbacks, and the agent
// spawner gatekeeper. They reach the overseer only by RPC to its Durable Object, never through an
// OverseerImpl, so this module takes nothing but types from overseer.ts. `ctx.exports` resolves
// names against the main module, so server.ts re-exports each of them.

import { RpcTarget } from "capnweb";
import { validateRpc } from "capnweb-validate";
import type { WorkpieceId, AgentSpawnerConfig, ConsoleLogEvent } from "@gadgets/workshop-shared/api";
import type { Gatekeeper, HookInitiator, ResourceDescription, ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import { DurableObject, WorkerEntrypoint, RpcStub as NativeRpcStub } from "cloudflare:workers";
import type { AgentSpawnerBinding, CallableAgent, SpawnCallableOptions } from "./agent-spawner-binding";
import { createWorkshopLogger } from "./observability";
import type { OverseerDurableObject } from "./overseer";
import type { GatekeeperCaller } from "./overseer-storage";

export type { AgentSpawnerBindingProps, BindingLoopbackTarget, GadgetTailLoopbackProps,
    GatekeeperHookLoopbackProps, GatekeeperLoopbackProps };

const logger = createWorkshopLogger("workshop.overseer");

type GatekeeperLoopbackProps = {
  overseerId: string;

  target: BindingLoopbackTarget;

  caller: GatekeeperCaller;
};

type BindingLoopbackTarget = {
  type: "gadget" | "gatekeeper";
  id: WorkpieceId;
} | {
  type: "worktree";
  id: WorkpieceId;

  // The executeCodeMode execution this loopback was minted for. A worktree binding resolves
  // against the turn state registered for exactly that execution (see #activeWorktreeTurns), so
  // a stub retained past it -- say, stored in a gadget the agent called -- fails closed instead
  // of coming back to life against a later execution's turn.
  executionId: string;
} | {
  // The `env.GIT` binding (see git-binding.ts).
  type: "git";
};

/**
 * Horrible hack: At present the `env` of a dynamic isolate can contain ServiceStubs but cannot
 * contain RpcStubs. But if we ask the gatekeeper to open a session, we get an RpcStub. So we
 * actually initialize each binding to be a `ServiceStub` pointing at a `GatekeeperLoopback` whose
 * props identify the overseer and target workpiece, so that on each method call it can resolve the
 * target session.
 *
 * TODO(multi-gadget): Rename to BindingLoopback. Stubs to this entrypoint aren't stored anywhere,
 * so a rename should be safe.
 */
export class GatekeeperLoopback extends WorkerEntrypoint<Cloudflare.Env, GatekeeperLoopbackProps> {
  constructor(ctx: ExecutionContext<GatekeeperLoopbackProps>, env: Cloudflare.Env) {
    super(ctx, env);

    let ns = ctx.exports.OverseerDurableObject;
    let stub: DurableObjectStub<OverseerDurableObject> =
        ns.get(ns.idFromString(ctx.props.overseerId));

    // @ts-ignore: LSP-only RPC types bug, "type instantiation is excessively deep"
    let session = stub.startGatekeeperSession(
        this.ctx.props.target, this.ctx.props.caller);

    return new Proxy(session, {
      get(target, prop, receiver) {
        // Note: We need `target` to be used as the receiver. If we use `receiver` as the receiver,
        //   we'll get an illegal invocation, as `receiver` points to our Proxy.
        return Reflect.get(target, prop, target);
      },
      getPrototypeOf(target) {
        return WorkerEntrypoint.prototype;
      },
    });
  }

  /**
   * We need to declare a method otherwise the validator won't even report this class as existing
   * and so the loopback binding won't be created.
   */
  dummyMethodToWorkAroundValidatorBug() {}
}

type GatekeeperHookLoopbackProps = {
  overseerId: string;
  hookId: number;
};

/**
 * When a gatekeeper's hook is connected, it receives a Fetcher to this class, which implements
 * the HookInitiator interface. When the gatekeeper wants to invoke the hook, it calls
 * startHook(), which returns both the actual hook RpcStub and an ApprovalQueue for logging
 * observations and actions.
 */
export class GatekeeperHookLoopback
    extends WorkerEntrypoint<Cloudflare.Env, GatekeeperHookLoopbackProps>
    implements HookInitiator<RpcTarget> {
  startHook(): Promise<
      {callback: NativeRpcStub<RpcTarget>, approvalQueue: NativeRpcStub<ApprovalQueue>}> {
    let ns = this.ctx.exports.OverseerDurableObject;
    let overseer: DurableObjectStub<OverseerDurableObject> =
        ns.get(ns.idFromString(this.ctx.props.overseerId));

    // Get an ApprovalQueue for this hook invocation from the overseer.
    // @ts-ignore seems the RPC types aren't working here
    return overseer.startHook(this.ctx.props.hookId);
  }
}

type AgentSelfLoopbackProps = {
  overseerId: string;
  chatId: number;
  initiatorUserId: string;
  initiatorModelId: string | null;  // null for a callable agent whose spawner has no model
};

/**
 * The `self` magic object passed to code executed via the agent's `executeCode` tool, and the
 * stub returned by an agent spawner's spawnCallable(). Calling any method on it (e.g.,
 * self.foo(123)) delivers a callback message to the chat thread and activates the agent to
 * respond. The call resolves once the callback is durably recorded and returns nothing; the
 * arguments must be storable (any RPC stubs among them must be persistent stubs). This is a
 * WorkerEntrypoint so it produces a Fetcher that can be passed over RPC and stored in Durable
 * Object KV storage.
 * TODO: Would be awesome if the agent could pass a sub-object like `self.foo`, and then be told
 *   later e.g. "foo.callback() was called". This requires that we implement RpcPromise
 *   serializability in the built-in RPC system, matching Cap'n Web.
 */
export class AgentSelfLoopback
    extends WorkerEntrypoint<Cloudflare.Env, AgentSelfLoopbackProps> {
  constructor(ctx: ExecutionContext<AgentSelfLoopbackProps>, env: Cloudflare.Env) {
    super(ctx, env);

    let ns = ctx.exports.OverseerDurableObject;
    let stub: DurableObjectStub<OverseerDurableObject> =
        ns.get(ns.idFromString(ctx.props.overseerId));
    let { chatId, initiatorUserId, initiatorModelId } = ctx.props;

    return new Proxy<AgentSelfLoopback>(<any>this, {
      get(target, prop, receiver) {
        if (typeof prop === 'symbol') return Reflect.get(target, prop, target);
        return (...args: unknown[]) => {
          return stub.deliverAgentCallback(
              chatId, String(prop), args, initiatorUserId, initiatorModelId);
        };
      },
      getPrototypeOf(target) {
        return WorkerEntrypoint.prototype;
      },
    });
  }

  /**
   * We need to declare a method otherwise the validator won't even report this class as existing
   * and so the loopback binding won't be created.
   */
  dummyMethodToWorkAroundValidatorBug() {}
}

type GadgetTailLoopbackProps = {
  chatId?: number;

  // Which gadget's worker these logs come from.
  gadgetId: WorkpieceId;

  overseerId: string;
};

export class GadgetTailLoopback extends WorkerEntrypoint<Cloudflare.Env, GadgetTailLoopbackProps> {
  async #deliver(logs: ConsoleLogEvent[]) {
    let ns = this.ctx.exports.OverseerDurableObject;
    let stub: DurableObjectStub<OverseerDurableObject> =
        ns.get(ns.idFromString(this.ctx.props.overseerId));
    await stub.deliverGadgetLogs(this.ctx.props.chatId ?? null, logs);
  }

  /**
   * New-style streaming tail worker. Delivers gadget console logs to the product UI in real time.
   * Do not console.log the tail events here — they spam wrangler dev and are not ops logs.
   */
  tailStream(event: TailStream.TailEvent<TailStream.Onset>)
      : TailStream.TailEventHandlerType | Promise<TailStream.TailEventHandlerType> {
    return {
      log: (event: TailStream.TailEvent<TailStream.Log>) => {
        let log: ConsoleLogEvent = {
          timestamp: new Date(event.timestamp),
          level: event.event.level,
          message: event.event.message as any[]
        }
        return this.#deliver([log]);
      },

      exception: (event: TailStream.TailEvent<TailStream.Exception>) => {
        let log: ConsoleLogEvent = {
          timestamp: new Date(event.timestamp),
          level: "error",
          message: [event.event.message, event.event.stack]
        }
        return this.#deliver([log]);
      },
    };
  }

  /**
   * Old-style tail worker. Logs are delayed until the end of the RPC event, which can be annoying
   * for calls that do things like register subscriptions.
   */
  async tail(events: TraceItem[]) {
    if (events.length != 1) {
      logger.error("unexpected gadget trace size", {
        event: "gadget.trace.size.unexpected",
        gadgetId: this.ctx.props.overseerId,
        chatId: this.ctx.props.chatId,
        size: events.length,
      });
      return;
    }

    let event: TraceItem = events[0];

    // HACK: Convert trace to serializable value by round-tripping to JSON.
    // TODO: Make traces serializable in workerd.
    event = JSON.parse(JSON.stringify(event));

    let logs: ConsoleLogEvent[] = event.logs.map(log => {
      let result: ConsoleLogEvent = {
        timestamp: new Date(log.timestamp),
        level: log.level as ConsoleLogEvent["level"],
        message: log.message,
      };
      return result;
    });

    for (let err of event.exceptions) {
      // Pretend errors were logged using console.error().
      logs.push({
        timestamp: new Date(err.timestamp),
        level: "error",
        message: [err.message],
      });
    }

    await this.#deliver(logs);
  }
}

type CodeModeLoopbackProps = {
  executionId: string;
  overseerId: string;
};

export class CodeModeTailLoopback extends WorkerEntrypoint<Cloudflare.Env, CodeModeLoopbackProps> {
  // TODO: Use tailStream here, but see comment in GadgetTailLoopback about excessive log spam
  //   on workerd console, need to fix that first.

  async tail(events: TraceItem[]) {
    if (events.length != 1) {
      logger.error("unexpected code mode trace size", {
        event: "code.mode.trace.size.unexpected",
        gadgetId: this.ctx.props.overseerId,
        executionId: this.ctx.props.executionId,
        size: events.length,
      });
      return;
    }

    let event: TraceItem = events[0];
    if (event.event && ("rpcMethod" in event.event) && event.event.rpcMethod === "verify") {
      // ignore verify() call
      return;
    }

    // HACK: Convert trace to serializable value by round-tripping to JSON.
    // TODO: Make traces serializable in workerd.
    event = JSON.parse(JSON.stringify(event));

    let ns = this.ctx.exports.OverseerDurableObject;
    let stub: DurableObjectStub<OverseerDurableObject> =
        ns.get(ns.idFromString(this.ctx.props.overseerId));
    await stub.deliverCodeModeTrace(this.ctx.props.executionId, event);
  }
}

// =======================================================================================

type AgentSpawnerBindingProps = {
  // ID of the overseer under which this agent should run.
  overseerId: string,

  config: AgentSpawnerConfig,

  // DO ID of the user who created this binding. When agents are spawned, the model is
  // resolved from this user's account. Falls back to the gadget owner for bindings
  // created before collaborator support was added.
  creatorUserId?: string,
};

import AGENT_SPAWNER_BINDING_TYPES from "./agent-spawner-binding.txt";

export class AgentSpawnerGatekeeper
    extends DurableObject<Cloudflare.Env, AgentSpawnerBindingProps>
    implements Gatekeeper<AgentSpawnerBinding> {
  async describe(): Promise<ResourceDescription> {
    return {
      // TODO: Decide if we need real URLs or if `url` should stop being part of the description.
      url: `http://agent-spawner.local/`,

      title: this.ctx.props.config.displayName,
      snippet: "Allows the gadget to spawn AI agents to perform tasks on given resources.",

      suggestedBindingName: "AGENT_SPAWNER",

      tsType: `AgentSpawnerBinding`,
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return AGENT_SPAWNER_BINDING_TYPES;
  }

  async getAutoApprovableActions() {
    return [];
  }

  async startSession(approvalQueue: NativeRpcStub<ApprovalQueue>)
      : Promise<AgentSpawnerBinding> {
    return new AgentSpawnerBindingImpl(this.ctx);
  }

  applyAction(action: number): Promise<void> {
    throw new Error("This gatekeeper implements no actions.");
  }
  rejectAction(action: number): Promise<void | {restart?: boolean}> {
    throw new Error("This gatekeeper implements no actions.");
  }
  revertAction(action: number):
      Promise<void | {message?: string, canRetry?: boolean, restart?: boolean}> {
    throw new Error("This gatekeeper implements no actions.");
  }

  async addObserver(_id: string, _user: Fetcher): Promise<void> {
    // The agent spawner itself is not a restricted-access resource: it reads nothing that
    // identifies the observer or leaks private data, so any observer is permitted. What it
    // *reaches* -- the connections its env names -- is modeled in the use-scope closure
    // (#useScopeGatekeeperIds), so observers are verified against those targets directly.
    // No-op (never throws).
  }

  async removeObserver(_id: string): Promise<void> {
    // No observer state is tracked (see addObserver). Idempotent no-op.
  }
}

// Deliberately not `implements AgentSpawnerBinding`: capnweb-validate sharpens an implemented
// interface's signatures onto the generated validator, which would reject the string that the
// migration guard in spawnCallable exists to explain. Conformance to the served interface is
// still checked, by startSession()'s return type.
@validateRpc()
class AgentSpawnerBindingImpl extends RpcTarget {
  constructor(private ctx: DurableObjectState<AgentSpawnerBindingProps>) {
    super();
  }

  #getOverseer() {
    let ns = this.ctx.exports.OverseerDurableObject;
    let id = ns.idFromString(this.ctx.props.overseerId);
    return ns.get(id);
  }

  async spawn(title: string, prompt: string): Promise<void> {
    // TODO: Should we be calling authorizeObservation() here? It's not really observing anything,
    //   but you might want the audit logs? But also, the agents show up in the chat history so
    //   maybe it's not really necessary to include them in the audit log too.
    return this.#getOverseer().spawnAgent(
        title, prompt, this.ctx.props.config, this.ctx.props.creatorUserId);
  }

  // Migration guard: `options` admits a string only so that a gadget written against the old
  // spawnCallable(title, prompt) fails with an explanation rather than a validator type error.
  // The served .d.ts keeps the clean signature. Remove once existing gadgets have been updated.
  async spawnCallable(title: string, options: SpawnCallableOptions | string)
      : Promise<CallableAgent> {
    if (typeof options === "string") {
      throw new Error(
          "spawnCallable(title, prompt) has been replaced by spawnCallable(title, " +
          "{types, mainType}); the agent no longer receives a prompt and calls no longer return " +
          "values. Update the calling code -- call describeBinding on the spawner for the new " +
          "interface.");
    }
    return this.#getOverseer().spawnCallableAgent(
        title, options, this.ctx.props.config, this.ctx.props.creatorUserId);
  }
}
