// The RPC capabilities the overseer hands out: the Overseer and GadgetClient façades its clients
// hold (with the default-deny variants for "use" collaborators), GatekeeperClientImpl, and the
// ApprovalQueue and ObservationAuthorizer it gives gatekeepers. Each holds an OverseerImpl, but
// this module takes only types from overseer.ts, so overseer.ts can import its values; the
// storage helpers they share come from overseer-storage.ts.

import { RpcCompatible, RpcStub, RpcTarget } from "capnweb";
import { validateRpc } from "capnweb-validate";
import { Overseer, GadgetMetadata, UiBundle, WorkpieceId, WorkpiecesSubscriber, GadgetClient, GadgetBindingInfo, GatekeeperClient, ActionLogEntry, ActionsSubscriber, ActionHistoryFilter, ActionHistoryPage, CodeChangeSubmission, CommitInfo, FileAtCommit, MAX_READ_FILES_PER_CALL, TreeNode, MergeChangesResult, AiChatMetadata, AiChatMessage, AiChatHistoryPage, AiChatSubscriber, AiChatAuthorInfo, AiModelConfig, AgentSpawnerConfig, ConsoleLogSubscriber, CapsuleSpecifier, CollaboratorInfo, CollaboratorRole, AffectedCollaborator, ShareLinkInfo, GatekeeperCreationSpec, ObserverBindingNeed, BlueprintBindingAnnotation, BlueprintMetadata, MessageFormatRef, BlueprintGadgetSummary, BlueprintScreenshotUpload, blueprintScreenshotUrl, ChatAttachmentUpload, ChatAttachmentHandle, BoundHookInfo, PreApprovableAction, PresenceSubscriber, SlashCommandChoice, SlashCommandRequest, validateBindingName, type GadgetExportFormat } from "@gadgets/workshop-shared/api";
import type { Gatekeeper, HookInitiator, ResourceDescription, ApprovalQueue, ActionDescription, ObservationAuthorizer, ObservationDescription, HookController, HookDescription, ActionKind, GitCache } from "@gadgets/workshop-shared/gatekeeper";
import { RpcStub as NativeRpcStub, RpcTarget as NativeRpcTarget } from "cloudflare:workers";
import { keyString, type ListOptions } from "@gadgets/typed-storage";
import { commitIdentityForAuthor } from "./git-store";
import { GitCacheImpl } from "./git-cache";
import type { LanguageModelGatekeeperProps } from "./ai-models";
import { GIT_BINDING_NAME } from "./agent";
import type { UserDurableObject } from "./user";
import type { ProductAnalyticsConnectionType } from "./analytics";
import type { SharingCaller } from "./sharing";
import { retryOnDoReset, wrapDoStubForTelemetry } from "./do-retry";
import { validateChatAttachmentUpload } from "./chat-attachment-validation";
import type { OverseerImpl, SessionKind } from "./overseer";
import { actionLastChangedKey, compactionKey, defaultBlueprintBindingTitle, fallbackBindingName,
  stampBindHookAction, validateChatAttachmentId, validateOid } from "./overseer-storage";
import type { ActionRecord, BindingRecord, BlueprintGadgetRecord, BoundHookRecord, GadgetRecord,
  GatekeeperCaller, GatekeeperRecord } from "./overseer-storage";
import type { AgentSpawnerBindingProps, GatekeeperHookLoopbackProps } from "./overseer-loopbacks";

export { ApprovalQueueImpl, GatekeeperClientImpl, makeHookFiringCallback, OverseerClientInterface,
    requireLiveHook, SlashCommandAuthorizerImpl, UseOverseerInterface };

function connectionTypeFromCreationSpec(
    type: GatekeeperCreationSpec["type"] | undefined): ProductAnalyticsConnectionType | undefined {
  switch (type) {
    case "gatekeeper": return "gatekeeper";
    case "aiModel": return "ai_model";
    case "agentSpawner": return "agent_spawner";
    case "ambient": return undefined;   // auto-provided, not a user-initiated connection
    case undefined: return undefined;
  }
}

const MAX_BLUEPRINT_SCREENSHOT_BYTES = 1024 * 1024;
function validateBlueprintScreenshotUpload(screenshot: BlueprintScreenshotUpload): BlueprintScreenshotUpload {
  if (screenshot.mimeType !== "image/jpeg" && screenshot.mimeType !== "image/png") {
    throw new Error("Blueprint screenshot must be a JPEG or PNG image.");
  }
  if (screenshot.content.byteLength > MAX_BLUEPRINT_SCREENSHOT_BYTES) {
    throw new Error("Blueprint screenshot must be under 1 MB.");
  }
  return screenshot;
}

function actionRecordToLog(record: ActionRecord): ActionLogEntry {
  // TODO: ActionRecord and ActionLogEntry are almost identical. The main difference is that
  // ActionRecord includes `action`, which should NOT be provided to the client. We could make
  // the two match more -- just `action` needs to be different.

  // ActionLogEntry omits the gatekeeperId for records that didn't come from a real gatekeeper
  // (built-in agent tools use the BUILTIN_TOOL_GATEKEEPER_ID sentinel).
  let gatekeeperId = record.gatekeeperId >= 0 ? record.gatekeeperId : undefined;

  switch (record.type) {
    case "observation":
      return {
        id: record.id,
        gatekeeperId,
        resourceTitle: record.resourceTitle || "(title unavailable)",
        resourceUrl: record.resourceUrl,
        createdAt: record.createdAt,
        state: record.state,
        type: "observation",
        description: record.description,
      };
    case "action":
      return {
        id: record.id,
        gatekeeperId,
        resourceTitle: record.resourceTitle || "(title unavailable)",
        resourceUrl: record.resourceUrl,
        createdAt: record.createdAt,
        appliedAt: record.appliedAt,
        state: record.state,
        type: "action",
        description: record.description,
        resolvedBy: record.resolvedBy,
        autoApproved: record.autoApproved,
      };
    case "bindHook":
      return {
        id: record.id,
        gatekeeperId,
        resourceTitle: record.resourceTitle || "(title unavailable)",
        resourceUrl: record.resourceUrl,
        createdAt: record.createdAt,
        appliedAt: record.appliedAt,
        state: record.state,
        type: "bindHook",
        hookId: record.hookId,
        description: record.description,
        enabled: record.enabled,
      };
    default:
      record satisfies never;
      throw new TypeError(`Invalid ActionRecord type: ${(record as ActionRecord).type}`);
  }
}

/**
 * Raw records examined per page of subscribeToActions()'s startAfter resume replay. Exported
 * for tests.
 */
export const ACTION_REPLAY_PAGE_SIZE = 256;

/** listActions() entries returned per page. Exported for tests. */
export const ACTION_HISTORY_PAGE_DEFAULT_LIMIT = 50;

// Mark an overseer session as a present viewer for its lifetime. The caller invokes the returned
// function from the session's [Symbol.dispose] to leave.
function joinSessionPresence(
    impl: OverseerImpl, profileId: string, role: CollaboratorRole,
    fetchProfile: () => Promise<AiChatAuthorInfo>): () => void {
  let leave: (() => void) | undefined;
  let cancelled = false;
  fetchProfile().then(user => {
    if (!cancelled) leave = impl.joinPresence(profileId, user, role);
  }).catch(() => {});
  return () => {
    cancelled = true;
    leave?.();
  };
}

@validateRpc()
class OverseerClientInterface extends RpcTarget implements Overseer {
  #clientProfilePromise: Promise<AiChatAuthorInfo> | undefined;

  constructor(private impl: OverseerImpl,
              private clientProfileId: string,
              private clientUserId: string,
              private isOwner: boolean,
              private notifyClosed: NativeRpcStub<() => void>,
              // Ambient capsule reconciliation started during open(); listSlashCommands() waits for
              // this so ambient providers are attached when possible.
               private slashCommandsReady: Promise<void>) {
    super();
    this.#leaveSession = this.impl.joinSession(this.isOwner ? "owner" : "build");
    this.#leavePresence = joinSessionPresence(
        this.impl, this.clientProfileId, "build", () => this.#getClientProfile());
    this.#leaveOutputsFanout = this.impl.joinOutputsFanout(this.clientUserId);
  }

  // We create a new stub for every call so that we don't have to worry about detecting when a
  // stub has become broken (see AuthenticatedApiImpl.#user in server.ts).
  get #owner(): DurableObjectStub<UserDurableObject> {
    if (!this.impl.ownerId) throw new Error("Workspace has been deleted.");
    return wrapDoStubForTelemetry(
        this.impl.users.get(this.impl.users.idFromString(this.impl.ownerId)),
        this.impl.logger);
  }

  get #clientUser(): DurableObjectStub<UserDurableObject> {
    return wrapDoStubForTelemetry(
        this.impl.users.get(this.impl.users.idFromString(this.clientUserId)),
        this.impl.logger);
  }

  #leaveSession: () => void;
  #leavePresence: () => void;
  #leaveOutputsFanout: () => void;

  [Symbol.dispose]() {
    this.#leaveSession();
    this.#leavePresence();
    this.#leaveOutputsFanout();
    this.notifyClosed();
    this.notifyClosed[Symbol.dispose]();
  }

  // Per-session caller identity for the SharingManager.
  #sharingCaller(): SharingCaller {
    return { profileId: this.clientProfileId, isOwner: this.isOwner };
  }

  // What a capability minted into this session counts as toward #hasCollaboratorSession -- the
  // client can dispose this interface while retaining the capability, so each one counts for its
  // own lifetime. Undefined for the owner: the owner is never an observer, and counting them
  // would restart the owner's solo workspace for the owner's own change.
  #mintedCapabilityKind(): SessionKind | undefined {
    return this.isOwner ? undefined : "build";
  }

  // Count a subscription handle minted into a collaborator's session toward
  // #hasCollaboratorSession for its own lifetime, like every other retainable capability (see
  // #mintedCapabilityKind): a retained subscription keeps delivering workspace data after the
  // interface that minted it is disposed, so one that escaped the count would let a scope
  // widening find no session to sever while e.g. a chat or action subscription kept streaming
  // gatekeeper-derived data. Applied to every subscription-returning method uniformly -- one
  // invariant for every export, rather than per-subscription reasoning about which could carry
  // sensitive data. The owner's subscriptions pass through uncounted.
  #subscriptionLease(subscription: RpcStub<{}>): RpcStub<{}> {
    let kind = this.#mintedCapabilityKind();
    if (!kind) return subscription;
    let leave = this.impl.joinSession(kind);
    // @ts-expect-error Bugs in native RPC types make this not work currently.
    return new NativeRpcStub<{}>({
      [Symbol.dispose]() {
        leave();
        subscription[Symbol.dispose]();
      }
    });
  }

  async #getClientProfile(): Promise<AiChatAuthorInfo> {
    if (!this.#clientProfilePromise) {
      this.#clientProfilePromise = retryOnDoReset(
          () => this.#clientUser.whoami(), this.impl.logger)
          .catch((err: unknown) => {
            this.#clientProfilePromise = undefined;
            throw err;
          });
    }

    const profilePromise = this.#clientProfilePromise!;
    return profilePromise;
  }

  async getMetadata(): Promise<GadgetMetadata> {
    let result: GadgetMetadata = {
      id: this.impl.ctx.id.toString(),
      title: this.impl.storage.title.get(),
      totalCost: this.impl.storage.totalCost.get(),
      containsRestrictedData: this.impl.storage.containsRestrictedData.get(),
      ownerInvitesOnly: this.impl.storage.ownerInvitesOnly.get(),
      role: "build",
      defaultGadgetId: this.impl.defaultGadgetId,
    };
    if (!this.isOwner) {
      result.owner = await retryOnDoReset(() => this.#owner.whoami(), this.impl.logger);
    }
    return result;
  }

  async subscribeToMetadata(
      callback: RpcStub<(metadata: GadgetMetadata) => void>)
      : Promise<RpcStub<{}>> {
    callback = callback.dup();  // keep stub after return

    // For collaborators, fetch owner info first: storage is read and subscribed below with no
    // await in between, so an update can't land after the snapshot but before the subscription.
    let owner = this.isOwner
        ? undefined : await retryOnDoReset(() => this.#owner.whoami(), this.impl.logger);

    let metadata: GadgetMetadata = {
      id: this.impl.ctx.id.toString(),
      title: this.impl.storage.title.get(),
      totalCost: this.impl.storage.totalCost.get(),
      containsRestrictedData: this.impl.storage.containsRestrictedData.get(),
      ownerInvitesOnly: this.impl.storage.ownerInvitesOnly.get(),
      role: "build",
      defaultGadgetId: this.impl.defaultGadgetId,
    };
    if (owner) metadata.owner = owner;

    let titleSubscriber = {
      update(value: string) {
        metadata.title = value;
        callback(metadata).catch(unsubscribe);
      }
    };
    let costSubscriber = {
      update(value: number | undefined) {
        metadata.totalCost = value;
        callback(metadata).catch(unsubscribe);
      }
    };
    let restrictedDataSubscriber = {
      update(value: boolean | undefined) {
        metadata.containsRestrictedData = value;
        callback(metadata).catch(unsubscribe);
      }
    };
    let ownerInvitesOnlySubscriber = {
      update(value: boolean | undefined) {
        metadata.ownerInvitesOnly = value;
        callback(metadata).catch(unsubscribe);
      }
    };

    let unsubscribe = () => {
      this.impl.storage.title.unsubscribe(titleSubscriber);
      this.impl.storage.totalCost.unsubscribe(costSubscriber);
      this.impl.storage.containsRestrictedData.unsubscribe(restrictedDataSubscriber);
      this.impl.storage.ownerInvitesOnly.unsubscribe(ownerInvitesOnlySubscriber);
      callback[Symbol.dispose]();
    };

    this.impl.storage.title.subscribe(titleSubscriber);
    this.impl.storage.totalCost.subscribe(costSubscriber);
    this.impl.storage.containsRestrictedData.subscribe(restrictedDataSubscriber);
    this.impl.storage.ownerInvitesOnly.subscribe(ownerInvitesOnlySubscriber);

    callback(metadata).catch(unsubscribe);

    // @ts-expect-error Bugs in native RPC types make this not work currently.
    return this.#subscriptionLease(new NativeRpcStub<{}>({
      [Symbol.dispose]() {
        unsubscribe();
      }
    }));
  }

  async subscribeToPresence(
      subscriber: RpcStub<PresenceSubscriber>): Promise<RpcStub<{}>> {
    return this.#subscriptionLease(this.impl.addPresenceSubscriber(subscriber));
  }

  async setTitle(title: string): Promise<void> {
    this.impl.storage.title.put(title);
    await this.#owner.updateTitle(this.impl.ctx.id.toString(), title);
  }

  async setPinned(pinned: boolean): Promise<void> {
    await this.#clientUser.updatePinned(this.impl.ctx.id.toString(), pinned);
  }

  async subscribeToWorkpieces(subscriber: RpcStub<WorkpiecesSubscriber>): Promise<RpcStub<{}>> {
    return this.#subscriptionLease(this.impl.subscribeToWorkpieces(subscriber, true));
  }

  async createGadget(title: string, chatId?: number, bindingName?: string)
      : Promise<RpcStub<GadgetClient>> {
    // When creating within a chat, names already claimed in that chat's scope (its frozen seed
    // plus log-derived bindings) are off-limits too: the chat's binding map is keyed by name,
    // so on replay the existing binding would win and the new gadget would never be addressable
    // under its promised name.
    let chatNames: Set<string> | undefined;
    if (chatId !== undefined) {
      if (!this.impl.storage.chatMeta.get(chatId)) {
        throw new Error(`No such chat: ${chatId}`);
      }
      chatNames = this.impl.chatScopeNames(chatId);
    }
    if (bindingName === undefined) {
      // The user didn't pick a name: derive one from the title via the quick model (the
      // title-to-identifier transform is exactly what it's for), falling back to a generic
      // GADGET/GADGET_2. Existing gadget names -- including pending ones -- are off-limits.
      let taken = new Set(
          [...this.impl.storage.gadgets.list()].flatMap(
              gadget => gadget.bindingName !== undefined ? [gadget.bindingName] : []));
      for (let name of chatNames ?? []) taken.add(name);
      let userMeta = await retryOnDoReset(
          () => this.#clientUser.getChatContext(null), this.impl.logger);
      if (userMeta.quickModel) {
        bindingName = await this.impl.generateBindingName(
            title, taken, {config: userMeta.quickModel, initiator: userMeta.profile});
      }
      bindingName ??= fallbackBindingName("GADGET", name => taken.has(name));
    } else if (chatNames?.has(bindingName)) {
      throw new Error(`The name "${bindingName}" is already in use in this chat. Choose a ` +
          `different name.`);
    }

    let record;
    if (chatId === undefined) {
      // A permanent gadget is born with its head: an empty-tree initial commit (see
      // GadgetRecord.commitId), giving a chat's first edit a commit to pin. Written before the
      // record -- it is content-addressed and referenced by nothing yet, so a validation
      // failure in createGadget below leaves no trace worth cleaning up.
      let initialCommitId = await this.impl.gitStore.writeFilesAsCommit(new Map(), {
        parents: [],
        author: commitIdentityForAuthor(await this.#getClientProfile()),
        message: `Create gadget: ${title}`,
        timestamp: new Date(),
      });
      // (createGadget validates the title and name.)
      record = this.impl.createGadget(title, bindingName, undefined, undefined, initialCommitId);
      this.impl.recordGadgetAnalytics({
        event_name: "workpiece_created",
        user_id: this.clientUserId,
        workpiece_id: record.id,
        source: "direct",
      });
    } else {
      // Creating a gadget with a chat open is provisional to that chat, like code edits: record
      // the creation in the chat log as a "changes" message (with no code update) and mark
      // the gadget pending. Both writes happen in one synchronous step, so (unlike the agent's
      // createGadget tool, whose "changes" message is persisted at step end) this path has no
      // crash window at all.
      let author = await this.#getClientProfile();
      if (!this.impl.storage.chatMeta.get(chatId)) {
        // Re-check adjacent to the synchronous creation: the chat may have been deleted during
        // the awaits above, and a pending record for a deleted chat would never be reaped.
        throw new Error(`No such chat: ${chatId}`);
      }
      record = this.impl.createGadget(title, bindingName, chatId, undefined, undefined,
                                     this.clientUserId);
      this.impl.addChatMessages(chatId, author, [{
        type: "changes",
        createdGadgets: [{gadgetId: record.id, title: record.title, bindingName}],
      }]);
    }
    // @ts-expect-error An RpcTarget implementing the interface works in place of a stub, but the
    //     type system doesn't know this.
    return new GadgetClientImpl(this.impl, record.id, this.clientUserId,
        this.#mintedCapabilityKind());
  }

  async getGadget(id: WorkpieceId): Promise<RpcStub<GadgetClient>> {
    this.impl.getGadgetRecord(id);  // validate it exists
    // @ts-expect-error An RpcTarget implementing the interface works in place of a stub, but the
    //     type system doesn't know this.
    return new GadgetClientImpl(this.impl, id, this.clientUserId, this.#mintedCapabilityKind());
  }

  async deleteSelf(): Promise<void> {
    if (!this.isOwner) {
      throw new Error("Only the workspace owner can delete it.");
    }
    let startedAt = Date.now();

    this.impl.destroyAllLiveChats();
    // TODO: Revoke user sessions.

    // Disable all enabled hooks so that the gatekeepers stop delivering events to this gadget.
    // We do this before deleting storage so that we still have access to the hook controllers.
    // TODO: If any disablement fails, deletion will be blocked. We could ignore failures, but that
    //   would leave gatekeepers pointing at gadgets that don't exist anymore, which is also bad.
    //   What do we really want here?
    for (let record of Array.from(this.impl.storage.boundHooks.list())) {
      if (record.enabled) {
        await this.disableHook(record.id);
      }
    }

    await this.impl.ctx.blockConcurrencyWhile(async () => {
      await this.#owner.deleteGadget(this.impl.ctx.id.toString());
      await this.impl.ctx.storage.deleteAll();
      this.impl.recordGadgetAnalytics({
        event_name: "gadget_deleted",
        user_id: this.#clientUser.id.toString(),
      });
      // The restart severs every session still holding this workspace so its client reopens. The
      // deleter has nothing to reopen, so close it first. Best-effort: throwing here resets the DO.
      await this.notifyClosed().catch(() => {});
      this.impl.scheduleAccessRestart("Gadget restarted because the workspace was deleted.");
      this.impl.ownerId = undefined;
    });

    this.impl.logger.info("deleted workspace", {
      event: "workspace.delete.completed", durationMs: Date.now() - startedAt,
    });
  }

  async submitCodeChange(chatId: number, submission: CodeChangeSubmission)
      : Promise<{generation: number, revision: number}> {
    let author = await this.#getClientProfile();
    return await this.impl.submitCodeChange(chatId, submission, author, this.clientUserId);
  }

  // --- Commit-backed code reads ---

  // The reads go through the git cache and so may fault-pull through a gatekeeper on the
  // client's behalf -- reaching only commits the workspace's gatekeepers advertised or proved,
  // nothing an agent couldn't already trigger.
  async listTree(commitId: string): Promise<TreeNode[]> {
    return await this.impl.gitCache.readCommitTree(validateOid(commitId));
  }

  async readFilesAtCommit(commitId: string, paths: string[])
      : Promise<[path: string, FileAtCommit][]> {
    if (paths.length > MAX_READ_FILES_PER_CALL) {
      throw new Error(`Too many paths: at most ${MAX_READ_FILES_PER_CALL} per call.`);
    }
    return await this.impl.gitCache.readFilesAtCommit(validateOid(commitId), paths);
  }

  async getCommitLog(fromCommit: string, depth?: number): Promise<CommitInfo[]> {
    if (depth !== undefined && (!Number.isInteger(depth) || depth <= 0)) {
      throw new Error("Invalid depth.");
    }
    return await this.impl.gitStore.readCommitLog(validateOid(fromCommit), {depth});
  }

  async updateChatFromMainline(chatId: number): Promise<{conflictPaths: string[]}> {
    let author = await this.#getClientProfile();
    return await this.impl.withChatLock(chatId,
        () => this.impl.updateChatFromMainline(chatId, author));
  }

  async getGatekeeperById(id: number): Promise<GatekeeperClient<any>> {
    let gatekeeper = this.impl.storage.gatekeepers.get(id)?.id;
    if (gatekeeper === undefined) {
      throw new Error(`No such gatekeeper id: ${id}`);
    }
    // A connection published moments before a scope-widening restart is not usable by the
    // sessions that restart is about to sever (see #gatekeepersPendingRestart).
    this.impl.assertGatekeeperUsable(id);
    return new GatekeeperClientImpl(this.impl, id, this.impl.getGatekeeperFacet(id),
        this.clientUserId, this.#mintedCapabilityKind());
  }

  private async recordConnectionCreated(
      result: GatekeeperClient<any>, connectionType: ProductAnalyticsConnectionType,
      vendorId?: string): Promise<void> {
    let gatekeeperId = await result.getId();
    this.impl.recordGadgetAnalytics({
      event_name: "connection_created",
      user_id: this.#clientUser.id.toString(),
      gatekeeper_id: gatekeeperId,
      connection_type: connectionType,
      vendor_id: vendorId,
    });
  }

  async newGatekeeper(accountId: number, resourceUrl: string)
      : Promise<GatekeeperClient<any> | null> {
    let {class: cls, vendorId, typeUrlPattern} =
        await this.#clientUser.getGatekeeperClassFor(accountId, resourceUrl);
    let creationSpec: GatekeeperCreationSpec = {
      type: "gatekeeper",
      vendorId,
      resourceUrl,
      typeUrlPattern,
    };
    let result = await this.impl.addGatekeeper(
        cls, creationSpec, this.clientUserId, this.#mintedCapabilityKind());
    await this.recordConnectionCreated(result, "gatekeeper", vendorId);
    return result;
  }

  async newAiModelGatekeeper(modelId: string): Promise<GatekeeperClient<any>> {
    let chatMeta = await retryOnDoReset(
        () => this.#clientUser.getChatContext(modelId), this.impl.logger);
    let props: LanguageModelGatekeeperProps = {
      displayName: chatMeta.aiModel!.profile.name,
      config: chatMeta.aiModel!.config,
      initiator: this.impl.gadgetAuthorFor(chatMeta.profile),
      metadata: { source: "model-binding", gadgetId: this.impl.ctx.id.toString() },
    }

    let creationSpec: GatekeeperCreationSpec = {
      type: "aiModel",
      modelId,
      provider: chatMeta.aiModel!.config.provider,
      modelName: chatMeta.aiModel!.config.model,
    };

    let result = await this.impl.addGatekeeper(
        this.impl.ctx.exports.LanguageModelGatekeeper({props}), creationSpec,
        this.clientUserId, this.#mintedCapabilityKind());
    await this.recordConnectionCreated(result, "ai_model");
    return result;
  }

  async newAgentSpawnerGatekeeper(config: AgentSpawnerConfig): Promise<GatekeeperClient<any>> {
    // Validate the configured env: names must be valid binding names and targets must exist --
    // and must not be gadgets still provisional to some chat, which belong to that chat's
    // unaccepted proposal, not (yet) to the workspace. (Spawn-time snapshotting tolerates targets
    // deleted later; this just catches bad input.)
    for (let [name, target] of Object.entries(config.env)) {
      validateBindingName(name);
      if (name === GIT_BINDING_NAME) {
        // The spawned chat's env already has the automatic env.GIT, which this would shadow.
        throw new Error(`Agent spawner env entry "${name}": the binding name \`${name}\` is ` +
            `reserved.`);
      }
      let gadget = this.impl.storage.gadgets.get(target);
      if (gadget) {
        if (gadget.type === "worktree") {
          throw new Error(`Agent spawner env entry "${name}" references workpiece ${target}, ` +
              `which is a worktree; worktrees are chat-private and cannot be configured.`);
        }
        if (gadget.pending) {
          throw new Error(`Agent spawner env entry "${name}" references gadget ${target}, ` +
              `which is still pending in a chat.`);
        }
      } else if (!this.impl.storage.gatekeepers.get(target)) {
        throw new Error(`Agent spawner env entry "${name}" references workpiece ${target}, ` +
            `which does not exist.`);
      }
    }

    let props: AgentSpawnerBindingProps = {
      overseerId: this.impl.ctx.id.toString(),
      config,
      creatorUserId: this.#clientUser.id.toString(),
    };

    // Resolve model provider/name for blueprint metadata.
    let creationSpec: GatekeeperCreationSpec = {
      type: "agentSpawner",
      config,
    };
    if (config.modelId) {
      let chatMeta = await retryOnDoReset(
          () => this.#clientUser.getChatContext(config.modelId), this.impl.logger);
      if (chatMeta.aiModel) {
        creationSpec.modelProvider = chatMeta.aiModel.config.provider;
        creationSpec.modelName = chatMeta.aiModel.config.model;
      }
    }

    let result = await this.impl.addGatekeeper(
        this.impl.ctx.exports.AgentSpawnerGatekeeper({props}), creationSpec,
        this.clientUserId, this.#mintedCapabilityKind());
    await this.recordConnectionCreated(result, "agent_spawner");
    return result;
  }

  async listActions(options?: {beforeId?: number, filter?: ActionHistoryFilter})
      : Promise<ActionHistoryPage> {
    let {beforeId, filter = "all"} = options ?? {};
    if (beforeId !== undefined && (!Number.isSafeInteger(beforeId) || beforeId < 0)) {
      throw new TypeError(`Invalid beforeId: ${beforeId}`);
    }

    // One ranged read -- off the collection itself for "all" (already id-ordered), off
    // byHistoryFilter otherwise -- so the work is O(page) however sparse the matches. Pages are
    // full until the last; the +1 record probes whether an older page exists.
    let actions = this.impl.storage.actions;
    let range = {end: beforeId, reverse: true, limit: ACTION_HISTORY_PAGE_DEFAULT_LIMIT + 1};
    let page = [...(filter === "all"
        ? actions.list(range) : actions.byHistoryFilter.get(filter, range))];
    let more = page.length > ACTION_HISTORY_PAGE_DEFAULT_LIMIT;
    if (more) page.pop();
    return {
      entries: page.map(actionRecordToLog),
      nextBeforeId: more ? page.at(-1)!.id : undefined,
    };
  }

  async approveAction(id: number): Promise<void> {
    let action = this.impl.storage.actions.get(id);
    if (!action) {
      throw new Error(`No such action: ${id}`);
    }

    if (action.type === "bindHook") {
      throw new Error("Hooks should be enabled/disabled, not approved/rejected.");
    }
    if (action.state !== "pending") {
      throw new Error(`Action is not pending: ${id}`);
    }
    if (action.type === "observation") {
      throw new Error("Observations can't have 'pending' state.");
    }

    // Resolve the approver's identity before applying, so a failed profile fetch can't leave the
    // action applied in the world but still "pending" in storage.
    let profile = await this.#getClientProfile();
    await this.impl.applyPendingAction(action, profile, false);

    // If this was an awaited agent action, resume only after all awaited actions in the turn are
    // approved. If applyPendingAction throws, the action stays pending and the turn stays suspended.
    if (action.caller.from === "agent" && action.description.awaitDecision) {
      await this.#maybeResumeAfterActionDecision(action.caller.chatId, action.id);
    }

    // Clearing this manual gate may unblock later auto-eligible pending actions on the same
    // gatekeeper, so cascade a drain (in-order) once this one is applied.
    this.impl.ctx.waitUntil(this.#drainAutoApprovalsAndResume(action.gatekeeperId));
  }

  // A drain can decide an agent turn's last awaited action, which must resume that turn just as a
  // manual approval does.
  async #drainAutoApprovalsAndResume(gatekeeperId: WorkpieceId): Promise<void> {
    // Snapshot every awaited action, even auto-eligible ones that didn't suspend their turn: a turn
    // suspended on a manual action can also be waiting on them. Accepted cost: one applied here
    // (e.g. a retried auto-apply failure) can resume a turn that never suspended.
    let awaited = new Map<number, number>();  // action id -> chat id
    for (let record of this.impl.storage.actions.pendingByGatekeeper.get(gatekeeperId)) {
      if (record.type === "action" && record.caller.from === "agent" &&
          record.description.awaitDecision) {
        awaited.set(record.id, record.caller.chatId);
      }
    }
    await this.impl.drainAutoApprovals(gatekeeperId);
    // No caller awaits a drain, so log each failed resume rather than letting it end the loop.
    for (let [id, chatId] of awaited) {
      if (this.impl.storage.actions.get(id)?.state !== "approved") continue;
      await this.#maybeResumeAfterActionDecision(chatId, id).catch(error => {
        this.impl.logger.error("failed to resume agent after auto-approval", {
          event: "agent.resume.failed", chatId, error,
        });
      });
    }
  }

  async listHooks(): Promise<BoundHookInfo[]> {
    let defaultGadgetId = this.impl.defaultGadgetId;
    let result: BoundHookInfo[] = [];
    for (let record of this.impl.storage.boundHooks.list()) {
      let gatekeeper = this.impl.storage.gatekeepers.get(record.gatekeeperId);
      result.push({
        id: record.id,
        gatekeeperId: record.gatekeeperId,
        // Hooks recorded before multi-gadget support carry no gadgetId; they belong to the
        // default gadget, which necessarily exists in any workspace old enough to have them.
        gadgetId: (record.gadgetId ?? defaultGadgetId)!,
        resourceTitle: gatekeeper?.resourceTitle,
        resourceUrl: gatekeeper?.resourceUrl,
        description: record.description,
        enabled: record.enabled,
      });
    }

    return result;
  }

  async enableHook(id: number): Promise<void> {
    let record = this.impl.storage.boundHooks.get(id);
    if (!record) throw new Error("Invalid hook ID.");

    if (!record.enabled) {
      let props: GatekeeperHookLoopbackProps = {
        overseerId: this.impl.ctx.id.toString(),
        hookId: id,
      }

      // TODO(hooks): enable()/disable() race. controller.enable() is awaited RPC to the gatekeeper;
      // a concurrent disableHook() can finish its controller.disable() first, then this enable()
      // still lands and recreates gatekeeper-side state (e.g. a scheduler driver row + alarm).
      // Live firings stay safe because startHook() re-checks record.enabled, but the resurrected
      // row can keep consuming quota/alarms until cleaned up.
      await record.controller.enable(
          this.impl.ctx.exports.GatekeeperHookLoopback({props}) as unknown as
              Fetcher<HookInitiator<RpcTarget>>,
          {
            workspaceId: this.impl.ctx.id.toString(),
            ...(record.gadgetId !== undefined ? {gadgetId: record.gadgetId} : {}),
          });

      // Flip the record and handle the "use"-scope widening an enabled hook can cause.
      this.impl.enableHookRecord(record);
    }
  }

  async disableHook(id: number): Promise<void> {
    let record = this.impl.storage.boundHooks.get(id);
    if (!record) throw new Error("Invalid hook ID.");

    if (record.enabled) {
      await record.controller.disable();

      // Re-read after the await: a deleteHook/removeGatekeeper landing while disable() was in
      // flight already reached the goal state (no hook), and putting the captured record back
      // would resurrect it as a zombie -- deleting the record must stay the authoritative kill.
      let current = this.impl.storage.boundHooks.get(id);
      if (!current) return;
      current.enabled = false;
      this.impl.storage.boundHooks.put(current);
      stampBindHookAction(this.impl.storage, current.actionId, false);
    }
  }

  async deleteHook(id: number): Promise<void> {
    return this.impl.deleteHook(id);
  }

  // Resume a turn suspended on awaitDecision once approving `approvedId` leaves all of that turn's
  // awaited actions approved. Scoping to the current turn keeps older actions out of it: a rejected
  // one can't block future resumes, and approving one can't restart a newer turn.
  async #maybeResumeAfterActionDecision(chatId: number, approvedId: number): Promise<void> {
    let awaited: (ActionRecord & {type: "action"})[] = [];
    for (let msg of this.impl.storage.chats.list(
        {prefix: `${keyString(chatId)}.`, reverse: true})) {
      // Stop at whatever started the current turn: a user/gadget message or a gadget callback.
      // (agentNudge is mid-turn, so it isn't a boundary.)
      if (msg.type === "agentCallback") break;
      if (msg.type === "message" &&
          (msg.author.type === "user" || msg.author.type === "gadget")) {
        break;
      }
      if (msg.type === "action") {
        let record = this.impl.storage.actions.get(msg.actionId);
        if (record && record.type === "action" &&
            record.caller.from === "agent" && record.description.awaitDecision) {
          awaited.push(record);
        }
      }
    }
    awaited.reverse();  // Present titles chronologically.

    // Only resume when every awaited action in the turn has been decided and all were approved.
    if (!awaited.some(r => r.id === approvedId)) return;    // Approved an older turn's action.
    if (awaited.some(r => r.state === "pending")) return;   // Still waiting on a decision.
    if (awaited.some(r => r.state === "rejected")) return;  // Denial leaves the turn ended.

    // Persist one note for replay; raw action cards are not surfaced to the LLM. Concurrent
    // approvals could both pass the gate above and append duplicate notes (the DO input gate is
    // open across these awaits), but that's cosmetic — #resumeSuspendedAgent still starts one turn.
    let titleList = awaited.map(r => `"${r.description.title}"`).join(", ");
    let summary =
        `The changes you submitted have been approved and applied: ${titleList}. ` +
        `Reads now reflect them.`;
    let author = await this.#getClientProfile();
    this.impl.addChatMessages(chatId, author, [{type: "message", message: summary}]);

    await this.#resumeSuspendedAgent(chatId);
  }

  async rejectAction(id: number): Promise<void> {
    let action = this.impl.storage.actions.get(id);
    if (!action) {
      throw new Error(`No such action: ${id}`);
    }

    if (action.state !== "pending") {
      throw new Error(`Action is not pending: ${id}`);
    }

    if (action.type !== "action") {
      throw new Error(`Can't reject an observation: ${id}`);
    }

    let gatekeeper = this.impl.getGatekeeperFacet(action.gatekeeperId);

    // Resolve the rejecter's identity before notifying the gatekeeper, so a failed profile fetch
    // can't leave the action rejected with the gatekeeper but still "pending" in storage.
    let profile = await this.#getClientProfile();

    await gatekeeper.rejectAction(action.action);

    action.state = "rejected";
    action.appliedAt = new Date();
    action.resolvedBy = profile;
    // A rejected push's pending-push marks are removed in the same durable step as the state
    // change (nothing was transmitted, so nothing became proven). No-op for pushless actions.
    this.impl.storage.transaction(() => {
      this.impl.gitCache.clearPushMarks(action.id);
      this.impl.storage.actions.put(action);
    });
    this.impl.traceAgentActionApproval(action, "denied");

    // Deny leaves the turn ended, like denyConnectionRequest. The rejected record also prevents a
    // sibling approval from resuming this turn. Like an approval, though, clearing this manual gate
    // may unblock later auto-eligible pending actions, whose turns do resume.
    this.impl.ctx.waitUntil(this.#drainAutoApprovalsAndResume(action.gatekeeperId));
  }

  // Enable auto-approval of actions carrying `actionKind` on the given gatekeeper. Stores the
  // opt-in rule (one of the two gates required to auto-apply -- the action's own `autoApprovable`
  // verdict is the other) with the kind's display label, and immediately drains any pending
  // actions that this newly unblocks. Auto-approval rules are workspace-wide per gatekeeper.
  async setAutoApprovedActionKind(gatekeeperId: WorkpieceId, actionKind: ActionKind)
      : Promise<void> {
    let gatekeeper = this.impl.storage.gatekeepers.get(gatekeeperId);
    if (!gatekeeper) {
      throw new Error(`No such gatekeeper: ${gatekeeperId}`);
    }

    let profile = await this.#getClientProfile();
    this.impl.storage.autoApproveTags.put({
      gatekeeperId,
      actionKind,
      enabledBy: profile,
    });
    // Apply the currently-visible pending action(s) with this tag right away.
    this.impl.ctx.waitUntil(this.#drainAutoApprovalsAndResume(gatekeeperId));
  }

  // Remove the auto-approval rule for `tag` on the given gatekeeper, so future matching actions
  // require manual approval again.
  async removeAutoApprovedActionKind(gatekeeperId: WorkpieceId, tag: string): Promise<void> {
    this.impl.storage.autoApproveTags.delete(`${gatekeeperId}:${tag}`);
  }

  // List the enabled auto-approval rules.
  async listAutoApprovedActionKinds()
      : Promise<Array<{ gatekeeperId: WorkpieceId; actionKind: ActionKind }>> {
    return [...this.impl.storage.autoApproveTags.list()].map(rule => ({
      gatekeeperId: rule.gatekeeperId,
      actionKind: rule.actionKind,
    }));
  }

  async listPreApprovableActions(): Promise<PreApprovableAction[]> {
    // Surface actions from every gatekeeper bound by some gadget (the connections the UI shows).
    let boundIds = new Set<WorkpieceId>();
    for (let gadget of this.impl.storage.gadgets.list()) {
      if (gadget.type !== "gadget") continue;  // worktrees have no binding edges
      for (let edge of Object.values(gadget.bindings)) {
        boundIds.add(edge.target);
      }
    }

    // TODO: a single gatekeeper failing (e.g. a rejected RPC) currently fails the whole catalog,
    // since we let getAutoApprovableActions() reject. Eventually we should isolate per-gatekeeper
    // failures and surface them to the UI (e.g. return the actions we could gather plus a list of
    // gatekeepers we couldn't reach) so one bad connection doesn't hide everyone else's actions.
    let perGatekeeper = [...boundIds]
        .map(id => this.impl.storage.gatekeepers.get(id))
        .filter(gk => gk !== undefined)
        .map(async (gk): Promise<PreApprovableAction[]> => {
      let facet = this.impl.getGatekeeperFacet(gk.id);
      let kinds = await facet.getAutoApprovableActions();
      return kinds.map(actionKind => ({
        gatekeeperId: gk.id,
        // resourceTitle is a denormalized cache of the gatekeeper's describe().title, populated in a
        // second step after the record is first persisted (see addGatekeeper). It can be absent if
        // that describe() failed, or for records predating the field, so fall back to a placeholder.
        resourceTitle: gk.resourceTitle || "(title unavailable)",
        vendorId: gk.creationSpec?.type === "gatekeeper" ? gk.creationSpec.vendorId : undefined,
        actionKind,
        alreadyEnabled:
            this.impl.storage.autoApproveTags.get(`${gk.id}:${actionKind.tag}`) !== undefined,
      }));
    });

    return (await Promise.all(perGatekeeper)).flat();
  }

  // Find a pending connectionRequest message by id. The request id encodes the chat id as a prefix
  // (`${chatId}:...`) so we only scan that thread's messages.
  #findConnectionRequest(requestId: string): AiChatMessage & {type: "connectionRequest"} {
    let colonIdx = requestId.indexOf(":");
    if (colonIdx < 0) throw new Error(`Malformed connection request id: ${requestId}`);
    let chatId = Number(requestId.slice(0, colonIdx));
    if (!Number.isFinite(chatId)) throw new Error(`Malformed connection request id: ${requestId}`);

    for (let msg of this.impl.storage.chats.list({prefix: `${keyString(chatId)}.`})) {
      if (msg.type === "connectionRequest" && msg.requestId === requestId) {
        return msg as AiChatMessage & {type: "connectionRequest"};
      }
    }
    throw new Error(`No such connection request: ${requestId}`);
  }

  // Restart a suspended agent turn after its outcome is recorded in chat history (accepted
  // connection, or all awaited actions approved). Denials intentionally don't call this.
  async #resumeSuspendedAgent(chatId: number): Promise<void> {
    await this.impl.waitForChatMessagePreparation(chatId);
    let meta = this.impl.storage.chatMeta.get(chatId);
    if (!meta) return;  // Chat deleted.
    if (meta.activeAgent) return;  // Already running; it'll pick up the change on its next read.

    // Recover the model this thread was using. getChatContext(null) does NOT resolve a model, so we
    // find the id from the most recent agent-authored message (its author.id is the model id).
    let modelId: string | null = null;
    for (let msg of this.impl.storage.chats.list({prefix: `${keyString(chatId)}.`, reverse: true})) {
      if (msg.author.type === "agent") {
        modelId = msg.author.id;
        break;
      }
    }

    let userMeta = await retryOnDoReset(
        () => this.#clientUser.getChatContext(modelId), this.impl.logger);
    if (!userMeta.aiModel) return;  // No model resolved; nothing to resume.

    let preparation = this.impl.waitForChatMessagePreparation(chatId);
    if (preparation) {
      await preparation;
      return this.#resumeSuspendedAgent(chatId);
    }

    // Re-read after the await: another concurrent accept may have started the agent in the
    // meantime. Avoid starting a second agent loop for the same chat.
    let fresh = this.impl.storage.chatMeta.get(chatId);
    if (!fresh || fresh.activeAgent) return;

    fresh.activeAgent = userMeta.aiModel.profile;
    fresh.lastActive = this.impl.getChatTimestamp();
    this.impl.storage.chatMeta.put(fresh);

    this.impl.startAgent(chatId, userMeta.aiModel, userMeta.profile,
                         this.#clientUser.id.toString());
  }

  async acceptConnectionRequest(
      requestId: string, result: {gatekeeperId: number}): Promise<void> {
    let msg = this.#findConnectionRequest(requestId);
    if (msg.state !== "pending") {
      throw new Error(`Connection request is not pending: ${requestId}`);
    }

    msg.state = "accepted";
    // The gatekeeper is surfaced to the agent as a named binding in the chat's env, under the
    // name recorded on the request (see the connectionRequest history case in agent.ts).
    msg.gatekeeperId = result.gatekeeperId;
    // Bump the timestamp so clients that were offline during the decision still receive the
    // mutated card on reconnect (the catch-up scan is ordered by timestamp).
    msg.timestamp = this.impl.getChatTimestamp();
    this.impl.storage.chats.put(msg);  // fires the subscriber update() → re-delivers the card

    // Don't resume until every connection request from this turn was accepted. Scanning newest
    // first bounds the lookup to the current turn and usually finds a pending sibling immediately.
    for (let sibling of this.impl.storage.chats.list(
        {prefix: `${keyString(msg.chatId)}.`, reverse: true})) {
      if (sibling.type === "connectionRequest" && sibling.state !== "accepted") return;
      if (sibling.type === "agentCallback" ||
          (sibling.type === "message" &&
           (sibling.author.type === "user" || sibling.author.type === "gadget"))) {
        break;
      }
    }
    await this.#resumeSuspendedAgent(msg.chatId);
  }

  async denyConnectionRequest(requestId: string): Promise<void> {
    let msg = this.#findConnectionRequest(requestId);
    if (msg.state !== "pending") {
      throw new Error(`Connection request is not pending: ${requestId}`);
    }

    msg.state = "denied";
    msg.timestamp = this.impl.getChatTimestamp();
    this.impl.storage.chats.put(msg);  // fires the subscriber update() → re-delivers the card

    // Intentionally do NOT resume the agent on deny. The agent's turn already ended when it made the
    // request; leaving it ended lets the user say what they want done instead, rather than forcing
    // the agent to guess from a bare "denied" signal. The denial is recorded in history and the
    // agent sees it the next time the user sends a message (see the connectionRequest history case).
  }

  async subscribeToActions(subscriber: RpcStub<ActionsSubscriber>, startAfter?: Date)
      : Promise<RpcStub<{}>> {
    let actions = this.impl.storage.actions;

    subscriber = subscriber.dup();  // keep stub after return
    let subscribed = false;
    let disposed = false;
    subscriber.onRpcBroken(_ => unsubscribe());

    let dbSubscriber = {
      add(record: ActionRecord) {
        subscriber.entry(actionRecordToLog(record)).catch(unsubscribe);
      },
      update(_oldRecord: ActionRecord, newRecord: ActionRecord): void {
        subscriber.entry(actionRecordToLog(newRecord)).catch(unsubscribe);
      },
      remove(_record: ActionRecord): void {
        // Required by typed-storage's Subscriber interface; actions are append-only today.
      }
    }

    function unsubscribe() {
      if (disposed) return;
      disposed = true;
      if (subscribed) actions.unsubscribe(dbSubscriber);
      subscriber[Symbol.dispose]();
    };

    actions.subscribe(dbSubscriber);
    subscribed = true;

    // The subscription delivers live deltas only; clients query current pending state via
    // listActions({filter: "pending"}) after initiating the subscribe (see api.ts).
    if (startAfter !== undefined) {
      // Resubscribe after a disconnect: sweep byLastChanged for everything changed since the
      // client's last-seen time -- O(changed during the gap), not O(log). The bound is
      // inclusive: the frozen clock stamps whole batches with one instant, so an exclusive bound
      // would drop the last-seen record's siblings, while re-delivery is just a harmless upsert.
      // The end key is fixed up front; a record changing mid-replay re-sorts past it and arrives
      // via the live subscription instead. Each page's delivery is awaited, so a failure rejects
      // the subscribe call before ready() and a huge gap can't queue unbounded callbacks.
      try {
        let newest = [...actions.byLastChanged.list({reverse: true, limit: 1})].at(0);
        if (newest !== undefined) {
          let end = actionLastChangedKey({...newest, id: newest.id + 1});
          // keyString(t) is a prefix of every key with that timestamp, so `start` is inclusive
          // of the whole cutoff instant.
          let from: ListOptions<string> = {start: keyString(startAfter.valueOf())};
          for (;;) {
            if (disposed) throw new Error("Action subscriber failed during replay");
            let page = [...actions.byLastChanged.list(
                {...from, end, limit: ACTION_REPLAY_PAGE_SIZE})];
            await Promise.all(page.map(record => subscriber.entry(actionRecordToLog(record))));
            if (page.length < ACTION_REPLAY_PAGE_SIZE) break;
            from = {startAfter: actionLastChangedKey(page.at(-1)!)};
          }
        }
      } catch (err) {
        unsubscribe();
        throw err;  // rejecting the subscribe call is the client's error signal
      }
    }

    if (!disposed) subscriber.ready().catch(unsubscribe);

    // @ts-expect-error Bugs in native RPC types make this not work currently.
    return this.#subscriptionLease(new NativeRpcStub<{}>({
      [Symbol.dispose]() {
        unsubscribe();
      }
    }));
  }

  async listChats(): Promise<AiChatMetadata[]> {
    return [...this.impl.storage.chatMeta.list({reverse: true})]
        .map(meta => this.impl.chatMetaForClient(meta));
  }

  async listModels(): Promise<AiChatAuthorInfo[]> {
    return retryOnDoReset(() => this.#clientUser.listModels(), this.impl.logger);
  }

  async listSlashCommands(): Promise<SlashCommandChoice[]> {
    await this.slashCommandsReady;
    return this.impl.listSlashCommands();
  }

  async uploadChatAttachment(
    attachment: ChatAttachmentUpload,
    modelId: string | null,
  ): Promise<ChatAttachmentHandle> {
    let provider: AiModelConfig["provider"] | undefined;
    if (modelId !== null) {
      provider = (await retryOnDoReset(
          () => this.#clientUser.getChatContext(modelId), this.impl.logger))
          .aiModel?.config.provider;
    }
    attachment = validateChatAttachmentUpload(
      attachment,
      provider,
    );

    this.impl.sweepStagedChatAttachments();

    let id = crypto.randomUUID();
    this.impl.storage.chatAttachmentContent.put({
      fileId: id,
      data: new Uint8Array(attachment.content),
      state: {
        type: "staged",
        uploadedAt: Date.now(),
        mimeType: attachment.mimeType,
        name: attachment.name,
      },
    });
    return {id};
  }

  // Fetch the bytes of a committed chat attachment over the authenticated RPC connection. The
  // caller already has its canonical metadata from the ChatAttachmentRef in the message.
  async getChatAttachmentContent(chatId: number, id: string): Promise<Uint8Array> {
    let content = this.impl.storage.chatAttachmentContent.get(validateChatAttachmentId(id));
    if (!content || content.state.type !== "committed" || content.state.chatId !== chatId) {
      throw new Error("Chat attachment not found.");
    }
    return content.data;
  }

  async deleteChatAttachment(id: string): Promise<void> {
    id = validateChatAttachmentId(id);
    let content = this.impl.storage.chatAttachmentContent.get(id);
    if (content?.state.type === "staged") {
      this.impl.storage.chatAttachmentContent.delete(id);
    }
  }

  // Compaction boundaries delimit the pages: the newest page is the tail replay still scans, and each
  // earlier page is the span one checkpoint summarized. A thread that was never compacted has a
  // single page.
  async getChatHistory(chatId: number, beforeSequence?: number): Promise<AiChatHistoryPage> {
    let checkpoint = beforeSequence === undefined
        ? this.impl.getActiveChatCompaction(chatId)
        : this.impl.getChatCompactionBelow(chatId, beforeSequence);
    let result = [...this.impl.storage.chats.list({
      prefix: `${keyString(chatId)}.`,
      start: checkpoint && compactionKey(chatId, checkpoint.compactedTo),
      end: beforeSequence === undefined ? undefined : compactionKey(chatId, beforeSequence),
    })];
    return {
      messages: result.map((msg) => this.#getChatMessageForClient(msg)),
      compacted: checkpoint && {
        to: checkpoint.compactedTo,
        summary: checkpoint.summary,
        proposedChange: checkpoint.proposedChange,
      },
    };
  }

  async getChatMessage(chatId: number, sequence: number): Promise<AiChatMessage | undefined> {
    let msg = this.impl.storage.chats.get(`${keyString(chatId)}.${keyString(sequence)}`);
    return msg && this.#getChatMessageForClient(msg);
  }

  #getChatMessageForClient(msg: AiChatMessage): AiChatMessage {
    if (msg.type === "action") {
      let record = this.impl.storage.actions.get(msg.actionId);
      if (record) {
        msg.actionLog = actionRecordToLog(record);
      }
    }
    return this.impl.hydrateChatMessageForClient(msg);
  }

  async subscribeToChat(subscriber: RpcStub<AiChatSubscriber>, startAfter?: Date)
      : Promise<RpcStub<{}>> {
    let chats = this.impl.storage.chats;
    let chatMeta = this.impl.storage.chatMeta;
    let changedChatMetadata: AiChatMetadata[] = [];
    let replayCount = 0;

    subscriber = subscriber.dup();  // keep stub after return
    this.impl.addChatSubscriber(subscriber);
    subscriber.onRpcBroken(_ => unsubscribe());

    // Send the server-instance generation first, before any catch-up callbacks, so the client can
    // detect a full DO restart and discard stale provisional stream state.
    subscriber.streamGeneration(this.impl.streamGeneration).catch(unsubscribe);

    let impl = this.impl;
    let metaSubscriber = {
      add(record: AiChatMetadata) {
        subscriber.metadata(impl.chatMetaForClient(record)).catch(unsubscribe);
      },
      update(oldRecord: AiChatMetadata, newRecord: AiChatMetadata): void {
        subscriber.metadata(impl.chatMetaForClient(newRecord)).catch(unsubscribe);
      },
      remove(record: AiChatMetadata): void {
        subscriber.deleted(record.id);
      }
    }

    let self = this;
    function deliverMessage(record: AiChatMessage) {
      subscriber.message(self.#getChatMessageForClient(record)).catch(unsubscribe);
    }

    let msgSubscriber = {
      add(record: AiChatMessage) {
        deliverMessage(record);
      },
      update(oldRecord: AiChatMessage, newRecord: AiChatMessage): void {
        // Chat messages are normally immutable, but connectionRequest messages are mutated in
        // place when the user accepts/denies. Re-deliver so the client (which indexes by
        // sequence) replaces the cached message and re-renders the card.
        deliverMessage(newRecord);
      },
      remove(record: AiChatMessage): void {
        // Never happens.
      }
    }

    let disposed = false;
    function unsubscribe() {
      if (disposed) return;
      disposed = true;
      chats.unsubscribe(msgSubscriber);
      chatMeta.unsubscribe(metaSubscriber);
      self.impl.removeChatSubscriber(subscriber);
      subscriber[Symbol.dispose]();
    };

    if (startAfter !== undefined) {
      // Catch up on metadata changes.
      for (let meta of chatMeta.byLastActive.list({startAfter: startAfter.valueOf()})) {
        changedChatMetadata.push(meta);
        ++replayCount;
      }
    }

    if (startAfter !== undefined) {
      // Catch up on messages.
      for (let msg of chats.byTimestamp.list({startAfter: startAfter.valueOf()})) {
        deliverMessage(msg);
        ++replayCount;
      }
      // Messages establish the durable state that the corresponding metadata describes.
      for (let meta of changedChatMetadata) {
        subscriber.metadata(impl.chatMetaForClient(meta)).catch(unsubscribe);
      }
    }

    // Replay every currently retained (not-yet-materialized) change row so the subscriber can
    // reconstruct uncommitted chat content without a separate fetch. Rows a "changes" message
    // has absorbed are not replayed -- the message's watermark covers them -- and the rows are
    // delivered after the message catch-up above, matching their position in the stream (rows
    // are strictly newer than every materialized message of their generation). Delivered
    // unconditionally (no startAfter filtering): the client dedupes by (generation, revision).
    for (let row of this.impl.storage.chatChanges.list()) {
      if (row.retired) continue;
      subscriber.changeApplied(row.chatId, row.generation, row.revision, row.author, row.change,
                               row.submission).catch(unsubscribe);
      ++replayCount;
    }

    this.impl.logger.debug("chat subscription replay completed", {
      event: "chat.subscription.replay.completed",
      size: replayCount,
    });

    chatMeta.subscribe(metaSubscriber);
    chats.subscribe(msgSubscriber);

    // @ts-expect-error Bugs in native RPC types make this not work currently.
    return this.#subscriptionLease(new NativeRpcStub<{}>({
      [Symbol.dispose]() {
        unsubscribe();
      }
    }));
  }

  async newChat(initialMessage: string | SlashCommandRequest, chosenModelId: string | null,
                capsules?: CapsuleSpecifier[], attachments?: ChatAttachmentHandle[],
                formats?: MessageFormatRef[]): Promise<number> {
    let userMeta = await retryOnDoReset(
        () => this.#clientUser.getChatContext(chosenModelId), this.impl.logger);
    return this.impl.newChat(this.#clientUser, userMeta, initialMessage, capsules, attachments,
                             undefined, undefined, formats);
  }

  async sendChatMessage(
      chatId: number, message: string | SlashCommandRequest, chosenModelId: string | null,
      capsules?: CapsuleSpecifier[], attachments?: ChatAttachmentHandle[],
      formats?: MessageFormatRef[]): Promise<void> {
    let userMeta = await retryOnDoReset(
        () => this.#clientUser.getChatContext(chosenModelId), this.impl.logger);
    return this.impl.sendChatMessage(
        this.#clientUser, userMeta, chatId, message, capsules, attachments, undefined, formats);
  }

  async setChatTitle(chatId: number, title: string): Promise<void> {
    let meta = this.impl.storage.chatMeta.get(chatId);
    if (!meta) {
      throw new Error("No such chatId: " + chatId);
    }
    meta.lastActive = this.impl.getChatTimestamp();
    meta.title = title;
    this.impl.storage.chatMeta.put(meta);
  }

  async mergeChanges(chatId: number): Promise<MergeChangesResult> {
    let userMeta = await retryOnDoReset(
        () => this.#clientUser.getChatContext(null), this.impl.logger);
    return await this.impl.withChatLock(chatId,
        () => this.impl.mergeChanges(chatId, userMeta, this.#clientUser.id.toString()));
  }

  async revertChanges(chatId: number, revertFrom: number): Promise<void> {
    if (!Number.isInteger(revertFrom) || revertFrom < 0) {
      throw new Error("Invalid revertFrom.");
    }

    let author = await this.#getClientProfile();
    await this.impl.withChatLock(chatId,
        () => this.impl.revertChanges(chatId, revertFrom, author));
  }

  async deleteChat(chatId: number): Promise<void> {
    let startedAt = Date.now();
    let response = this.impl.storage.gadgetResponseDeliveries.undeliveredByChatId.get(chatId);
    if (response?.status === "waiting") {
      this.impl.deliverExternalMessageResponse(response, "The chat was deleted before the agent responded.");
    }

    // Delete the chat's workpiece registry footprint: provisional gadgets, all of its worktrees,
    // and provisional binding edges.
    await this.impl.removeChatWorkpieces(chatId);
    this.impl.storage.chatMeta.delete(chatId);
    this.impl.storage.chatContext.delete(chatId);
    // Buffer the keys first: deleting invalidates the list cursor.
    let checkpoints = Array.from(
        this.impl.storage.chatCompactions.list({prefix: `${keyString(chatId)}.`}),
        checkpoint => compactionKey(chatId, checkpoint.compactedTo));
    for (let key of checkpoints) this.impl.storage.chatCompactions.delete(key);

    // The chat's change stream: rows (retired included), the straggler-bridge boundary, and the
    // per-client dedupe records (which live exactly as long as the chat -- see submitCodeChange).
    this.impl.deleteAllChatChanges(chatId);
    for (let record of Array.from(this.impl.storage.chatChangeClients.list(
        {prefix: `${keyString(chatId)}.`}))) {
      this.impl.storage.chatChangeClients.delete(
          `${keyString(record.chatId)}.${record.userId}:${record.clientId}`);
    }

    // Any pre-conversion legacy drafts (see ChatDraftUpdateRecord).
    for (let draft of Array.from(this.impl.storage.chatDraftUpdates.list(
        {prefix: `${keyString(chatId)}.`}))) {
      this.impl.storage.chatDraftUpdates.delete(
          `${keyString(draft.chatId)}.${keyString(draft.timestamp.valueOf())}`);
    }

    // Delete the chat's messages and the attachment content referenced by them. Attachment metadata
    // is canonical in each message's ChatAttachmentRef, so no separate attachment index is needed.
    this.impl.ctx.storage.transactionSync(() => {
      for (let msg of this.impl.storage.chats.list({prefix: `${keyString(chatId)}.`})) {
        if (msg.type === "message") {
          for (let attachment of msg.attachments ?? []) {
            let content = this.impl.storage.chatAttachmentContent.get(attachment.id);
            if (content?.state.type === "committed" && content.state.chatId === chatId) {
              this.impl.storage.chatAttachmentContent.delete(attachment.id);
            }
          }
        }
        this.impl.storage.chats.delete(`${keyString(msg.chatId)}.${keyString(msg.sequence)}`);
      }
    });

    // Clean up agentCallbackArgs for this chat, and any calls to its agent not yet delivered.
    for (let entry of this.impl.storage.agentCallbackArgs.list(
        {prefix: `${keyString(chatId)}.`})) {
      this.impl.storage.agentCallbackArgs.delete(
          `${keyString(entry.chatId)}.${keyString(entry.sequence)}`);
    }
    for (let entry of Array.from(this.impl.storage.pendingAgentCalls.list(
        {prefix: `${keyString(chatId)}.`}))) {
      this.impl.storage.pendingAgentCalls.delete(
          `${keyString(entry.chatId)}.${keyString(entry.callId)}`);
    }

    // Clean up the chat's model-facing snapshots.
    for (let entry of this.impl.storage.chatModelData.list(
        {prefix: `${keyString(chatId)}.`})) {
      this.impl.storage.chatModelData.delete(
          `${keyString(entry.chatId)}.${keyString(entry.sequence)}`);
    }

    // Defensively drop any resume record so a deleted chat is never resumed. (Aborting the agent
    // below also clears this via the tracked promise's finally, but the chat may have no live
    // agent in memory, e.g. after a restart before resumption ran.)
    this.impl.storage.activeAgents.delete(chatId);

    // Clean up all in-memory live state for this chat.
    this.impl.destroyLiveChat(chatId);

    this.impl.logger.info("deleted chat", {
      event: "chat.delete.completed", chatId, durationMs: Date.now() - startedAt,
    });
  }

  async stopAgent(chatId: number): Promise<void> {
    this.impl.cancelAgent(chatId);
  }

  async retryAgent(chatId: number, modelId: string): Promise<void> {
    let userMeta = await retryOnDoReset(
        () => this.#clientUser.getChatContext(modelId), this.impl.logger);

    let meta = this.impl.assertChatNotActive(chatId);
    if (!userMeta.aiModel) {
      throw new Error("No AI model available.");
    }

    let result = this.impl.materializeChatChanges(chatId, meta);
    if (result) meta = result.meta;

    meta.activeAgent = userMeta.aiModel.profile;
    meta.lastActive = this.impl.getChatTimestamp();
    this.impl.storage.chatMeta.put(meta);

    this.impl.startAgent(chatId, userMeta.aiModel, userMeta.profile,
                         this.#clientUser.id.toString());
  }

  async finalizeChatDraft(chatId: number): Promise<void> {
    let meta = this.impl.assertChatNotActive(chatId);
    this.impl.materializeChatChanges(chatId, meta);
  }

  async discardChatDraftChanges(chatId: number): Promise<void> {
    // Under the chat lock: the discard drops unlogged pins, and interleaving one of the
    // lock-holding operations' awaits could otherwise drop a pin whose seed a message they are
    // about to record (e.g. a mainline merge) is rooted in.
    await this.impl.withChatLock(chatId, async () => this.impl.discardChatDraftChanges(chatId));
  }

  async subscribeToConsoleLogs(subscriber: RpcStub<ConsoleLogSubscriber>): Promise<RpcStub<{}>> {
    return this.#subscriptionLease(await this.impl.subscribeToConsoleLogs(subscriber));
  }

  // --- Blueprint management ---

  async listBlueprints(): Promise<BlueprintGadgetSummary[]> {
    let result: BlueprintGadgetSummary[] = [];
    for (let record of Array.from(this.impl.storage.blueprints.list())) {
      result.push({
        id: record.id,
        title: record.metadata.title,
        description: record.metadata.description,
        version: record.metadata.version,
        codeVersionDate: await this.#blueprintCodeDate(record),
        screenshotUrl: blueprintScreenshotUrl(record.id, record.metadata),
        dirty: record.dirty,
      });
    }
    return result;
  }

  // The timestamp of the code exported into a blueprint: the exported commit's author date, or
  // for legacy (pre-git-storage) records the legacy log entry's, falling back to the metadata's
  // own last-updated time.
  async #blueprintCodeDate(record: BlueprintGadgetRecord): Promise<Date> {
    if (record.commitId !== undefined) {
      return (await this.impl.gitStore.readCommitLog(record.commitId, {depth: 1}))[0].timestamp;
    }
    if (record.codeVersion !== undefined) {
      let codeUpdate = this.impl.storage.code.get(record.codeVersion);
      if (codeUpdate) return codeUpdate.timestamp;
    }
    return record.metadata.lastUpdated;
  }

  async updateBlueprint(blueprintId: string, options: {
    title?: string;
    description?: string;
    updateCode?: boolean;
    updateBindings?: boolean;
    screenshot?: BlueprintScreenshotUpload | null;
  }): Promise<void> {
    let record = this.impl.storage.blueprints.get(blueprintId);
    if (!record) throw new Error("No such blueprint.");

    if (options.title === undefined && options.description === undefined && !options.updateCode && !options.updateBindings && options.screenshot === undefined) {
      throw new Error("At least one update option must be provided.");
    }

    if (options.title !== undefined) {
      record.metadata.title = options.title;
    }
    if (options.description !== undefined) {
      record.metadata.description = options.description;
    }

    let codeSnapshot: Uint8Array | undefined;
    if (options.updateCode || options.updateBindings) {
      // Re-collect binding metadata from the source gadget (validates annotations). Records
      // written before multi-gadget support carry no gadgetId; they export the default gadget.
      let gadgetId = this.impl.resolveGadgetId(record.gadgetId);
      record.metadata.bindings = this.impl.collectBindingMetadata(gadgetId);
      if (options.updateCode) {
        let commitId = await this.impl.assertPublishableCommit(
            this.impl.getGadgetRecord(gadgetId).commitId);
        record.commitId = commitId;
        delete record.codeVersion;
        record.metadata.version++;
        codeSnapshot = await this.impl.snapshotCode(commitId);
      }
    }

    let screenshot = options.screenshot === undefined
      ? undefined
      : options.screenshot === null ? null : validateBlueprintScreenshotUpload(options.screenshot);

    record.metadata.lastUpdated = new Date();

    await this.impl.propagateBlueprint(record, codeSnapshot, screenshot);
  }

  async deleteBlueprint(blueprintId: string): Promise<void> {
    let record = this.impl.storage.blueprints.get(blueprintId);
    if (!record) throw new Error("No such blueprint.");

    try {
      await this.impl.deleteBlueprintPropagation(record);
    } catch (err) {
      // If deletion fails partway through, mark as dirty so the user can retry.
      record.dirty = true;
      this.impl.storage.blueprints.put(record);
      throw err;
    }
  }

  async retryBlueprintPublish(blueprintId: string): Promise<void> {
    let record = this.impl.storage.blueprints.get(blueprintId);
    if (!record) throw new Error("No such blueprint.");
    if (!record.dirty) return;  // nothing to retry

    // Reconstruct the code snapshot at the originally exported commit, not the current code.
    if (record.commitId === undefined) {
      // A record with `codeVersion` instead predates git-backed code storage; one with neither
      // shouldn't exist, but either way the fix is the same.
      throw new Error("This blueprint predates git-backed code storage. Republish its code " +
          "with updateBlueprint instead of retrying.");
    }
    let codeSnapshot = await this.impl.snapshotCode(record.commitId);
    await this.impl.propagateBlueprint(record, codeSnapshot);
  }

  // --- Collaborator management ---
  //
  // The sharing/permission logic lives in SharingManager (./sharing). These methods handle only
  // the RPC-bound pieces (resolving profiles via User DOs) and delegate the rest.

  async listObserverRequirements(
      role: CollaboratorRole): Promise<ObserverBindingNeed[]> {
    return this.impl.listObserverRequirements(role);
  }

  async listCollaborators(): Promise<CollaboratorInfo[]> {
    return (await this.impl.getSharingManager()).listCollaborators();
  }

  async addCollaborator(username: string, role: CollaboratorRole, note?: string)
      : Promise<CollaboratorInfo | null> {
    // Look up the user DO to check if the account exists.
    let userDoId = this.impl.users.idFromName(username);
    let userDo = this.impl.users.get(userDoId);
    let profile = await userDo.whoamiIfExists();
    if (!profile) {
      return null;
    }

    return (await this.impl.getSharingManager()).addCollaborator({
      caller: this.#sharingCaller(),
      profile,
      role,
      note,
    });
  }

  async previewRemoveCollaborator(profileId: string): Promise<AffectedCollaborator[]> {
    return (await this.impl.getSharingManager())
        .previewRemoveCollaborator(this.#sharingCaller(), profileId);
  }

  async removeCollaborator(profileId: string, keepUsers: string[]): Promise<AffectedCollaborator[]> {
    let affected = (await this.impl.getSharingManager())
        .removeCollaborator(this.#sharingCaller(), profileId, keepUsers);
    // Schedule the restart in the same synchronous step as the sharing mutation: the revoked
    // collaborator's live sessions must not outlive the cleanup below, which crosses gatekeeper
    // and User-DO round trips that can stall or hang. Only restart if someone actually lost
    // access or was downgraded (kept users are already excluded) -- a no-op removal, e.g.
    // severing a share-link edge nobody relied on, shouldn't disconnect everyone.
    if (affected.length > 0) {
      this.impl.scheduleAccessRestart(
          "Gadget restarted to revoke access for a removed collaborator.");
    }
    // The reset's ~100ms delay gives the best-effort cleanup below a head start; whatever it cut
    // off self-heals (a leftover observer registration is lazily cleaned at exclusion time or by
    // a later open, a stale cached workspace listing just yields a denied open).
    // Tear down observer records for anyone who lost access (see tearDownLostObservers)...
    await this.impl.tearDownLostObservers(affected);
    // ...and likewise update or remove their cached workspace listing.
    await this.impl.refreshAffectedCollaboratorListings(affected);
    return affected;
  }

  async previewRevokeShareLink(linkId: string): Promise<AffectedCollaborator[]> {
    return (await this.impl.getSharingManager())
        .previewRevokeShareLink(this.#sharingCaller(), linkId);
  }

  async revokeShareLink(linkId: string, keepUsers: string[]): Promise<AffectedCollaborator[]> {
    let affected = (await this.impl.getSharingManager())
        .revokeShareLink(this.#sharingCaller(), linkId, keepUsers);
    // Restart first, then best-effort cleanup, for the reasons given in removeCollaborator.
    if (affected.length > 0) {
      this.impl.scheduleAccessRestart(
          "Gadget restarted to revoke access for a revoked share link.");
    }
    await this.impl.tearDownLostObservers(affected);
    await this.impl.refreshAffectedCollaboratorListings(affected);
    return affected;
  }

  // --- Share link management ---

  async createShareLink(role: CollaboratorRole, note?: string)
      : Promise<{ key: string; linkId: string }> {
    return (await this.impl.getSharingManager())
        .createShareLink({ caller: this.#sharingCaller(), role, note });
  }

  async newShareLinkKey(linkId: string): Promise<{ key: string }> {
    return (await this.impl.getSharingManager())
        .newShareLinkKey({ caller: this.#sharingCaller(), linkId });
  }

  async listShareLinks(): Promise<ShareLinkInfo[]> {
    let sharing = await this.impl.getSharingManager();

    // Collect all records synchronously to release the kv.list() iterator before any await
    // points below. Only one kv.list() iterator can be active at a time, and concurrent RPC
    // calls (e.g. listCollaborators) may start their own.
    let records = sharing.listShareLinkRecords();

    let result: ShareLinkInfo[] = [];
    // Cache profile lookups.
    let profileCache = new Map<string, AiChatAuthorInfo>();

    for (let record of records) {
      let createdBy = profileCache.get(record.createdBy);
      if (!createdBy) {
        // Check if the creator is the owner (requires an RPC to the owner's DO).
        let ownerProfileId = await this.impl.getOwnerProfileId();
        if (ownerProfileId === record.createdBy) {
          createdBy = await retryOnDoReset(() => this.#owner.whoami(), this.impl.logger);
        }
        // Check if the creator is a collaborator (resolved locally).
        if (!createdBy) {
          createdBy = sharing.getCreatorProfile(record.createdBy);
        }
        // Fallback.
        if (!createdBy) {
          createdBy = { type: "user", id: record.createdBy, name: record.createdBy };
        }
        profileCache.set(record.createdBy, createdBy);
      }
      result.push({
        linkId: record.id,
        note: record.note,
        created: record.created,
        createdBy,
        role: record.role ?? "build",
      });
    }
    return result;
  }

  async updateShareLink(linkId: string, note?: string): Promise<void> {
    (await this.impl.getSharingManager())
        .updateShareLink(this.#sharingCaller(), linkId, note);
  }
}

// Restricted capability handed to "use"-role collaborators. It implements the full `Overseer`
// interface but permits only the handful of methods needed to render and interact with the
// gadgets' deployed UIs: getMetadata() (restricted to id/title/owner), a restricted
// subscribeToMetadata(), subscribeToPresence(), subscribeToWorkpieces(), and getGadget()
// (returning a restricted, mainline-only UseGadgetClientInterface). Presence includes active
// viewers' names, profile IDs, and roles. Every other
// method throws "Unauthorized", with a few exceptions: subscribeToConsoleLogs() and
// subscribeToActions() return inert subscriptions (they never deliver data), and
// listActions() returns an empty terminal page, rather than denying.
// The editor calls all of these speculatively from its top-level hooks, before it has switched to
// the use-only view; an inert result lets those calls resolve quietly instead of surfacing
// as spurious client-side errors, while still revealing nothing to the "use" collaborator.
//
// Default-deny is enforced at compile time: because this class `implements Overseer`, adding any
// new method to the interface will fail to compile here until a developer consciously decides
// whether "use" callers may invoke it.
@validateRpc()
class UseOverseerInterface extends RpcTarget implements Overseer {
  constructor(private impl: OverseerImpl,
              private clientProfileId: string,
              private clientUserId: string,
              private notifyClosed: NativeRpcStub<() => void>) {
    super();
    this.#leaveSession = this.impl.joinSession("use");
    this.#leavePresence = joinSessionPresence(
        this.impl, this.clientProfileId, "use",
        () => retryOnDoReset(() => this.#clientUser.whoami(), this.impl.logger));
    this.#leaveOutputsFanout = this.impl.joinOutputsFanout(this.clientUserId);
  }

  // Fresh stub per call; see OverseerClientInterface.#clientUser.
  get #owner(): DurableObjectStub<UserDurableObject> {
    if (!this.impl.ownerId) throw new Error("Workspace has been deleted.");
    return wrapDoStubForTelemetry(
        this.impl.users.get(this.impl.users.idFromString(this.impl.ownerId)),
        this.impl.logger);
  }

  get #clientUser(): DurableObjectStub<UserDurableObject> {
    return wrapDoStubForTelemetry(
        this.impl.users.get(this.impl.users.idFromString(this.clientUserId)),
        this.impl.logger);
  }

  #leaveSession: () => void;
  #leavePresence: () => void;
  #leaveOutputsFanout: () => void;

  [Symbol.dispose]() {
    this.#leaveSession();
    this.#leavePresence();
    this.#leaveOutputsFanout();
    this.notifyClosed();
    this.notifyClosed[Symbol.dispose]();
  }

  // Throws "Unauthorized" for any method not available to "use" collaborators.
  #deny(): never {
    throw new Error("Unauthorized: this collaborator only has permission to use the gadget's UI.");
  }

  // Count a subscription handle toward #hasCollaboratorSession for its own lifetime, exactly as
  // OverseerClientInterface.#subscriptionLease does for "build" sessions -- a client can dispose
  // this interface while retaining the subscription. Applied uniformly, including to the inert
  // subscriptions: every export minted into a collaborator session counts, rather than
  // per-subscription reasoning about which could carry data.
  #subscriptionLease(subscription: RpcStub<{}>): RpcStub<{}> {
    let leave = this.impl.joinSession("use");
    // @ts-expect-error Bugs in native RPC types make this not work currently.
    return new NativeRpcStub<{}>({
      [Symbol.dispose]() {
        leave();
        subscription[Symbol.dispose]();
      }
    });
  }

  // --- Allowed methods ---

  async getMetadata(): Promise<GadgetMetadata> {
    return {
      id: this.impl.ctx.id.toString(),
      title: this.impl.storage.title.get(),
      owner: await retryOnDoReset(() => this.#owner.whoami(), this.impl.logger),
      role: "use",
      defaultGadgetId: this.impl.defaultGadgetId,
    };
  }

  async subscribeToMetadata(
      callback: RpcStub<(metadata: GadgetMetadata) => void>)
      : Promise<RpcStub<{}>> {
    callback = callback.dup();  // keep stub after return

    // Fetch owner info first so the title read and subscription below have no await in between.
    let owner = await retryOnDoReset(() => this.#owner.whoami(), this.impl.logger);

    let metadata: GadgetMetadata = {
      id: this.impl.ctx.id.toString(),
      title: this.impl.storage.title.get(),
      owner,
      role: "use",
      defaultGadgetId: this.impl.defaultGadgetId,
    };

    let titleSubscriber = {
      update(value: string) {
        metadata.title = value;
        callback(metadata).catch(unsubscribe);
      }
    };

    let unsubscribe = () => {
      this.impl.storage.title.unsubscribe(titleSubscriber);
      callback[Symbol.dispose]();
    };

    this.impl.storage.title.subscribe(titleSubscriber);

    callback(metadata).catch(unsubscribe);

    // @ts-expect-error Bugs in native RPC types make this not work currently.
    return this.#subscriptionLease(new NativeRpcStub<{}>({
      [Symbol.dispose]() {
        unsubscribe();
      }
    }));
  }

  async subscribeToPresence(
      subscriber: RpcStub<PresenceSubscriber>): Promise<RpcStub<{}>> {
    return this.#subscriptionLease(this.impl.addPresenceSubscriber(subscriber));
  }

  // The gadget list is visible to "use" collaborators (v1 shares the whole workspace), and each
  // gadget is exposed through a restricted UseGadgetClientInterface that only permits rendering
  // its deployed UI. Gadgets still provisional to a chat are withheld: they are proposals within
  // the owner's chats, and their mainline code is empty anyway. Worktrees are withheld likewise,
  // being chat-private (and readable only through the build-only commit reads).
  async subscribeToWorkpieces(subscriber: RpcStub<WorkpiecesSubscriber>): Promise<RpcStub<{}>> {
    return this.#subscriptionLease(this.impl.subscribeToWorkpieces(subscriber, false));
  }

  async getGadget(id: WorkpieceId): Promise<RpcStub<GadgetClient>> {
    if (this.impl.getGadgetRecord(id).pending) {  // also validates it exists
      throw new Error(`No such gadget: ${id}`);
    }
    // @ts-expect-error An RpcTarget implementing the interface works in place of a stub, but the
    //     type system doesn't know this.
    return new UseGadgetClientInterface(this.impl, id, this.clientUserId);
  }

  // --- Denied methods (build-only) ---

  async setTitle(_title: string): Promise<void> { this.#deny(); }
  async setPinned(_pinned: boolean): Promise<void> { this.#deny(); }
  async deleteSelf(): Promise<void> { this.#deny(); }
  async createGadget(_title: string): Promise<RpcStub<GadgetClient>> { this.#deny(); }
  async submitCodeChange(_chatId: number, _submission: CodeChangeSubmission)
      : Promise<{generation: number, revision: number}> {
    this.#deny();
  }
  async listTree(_commitId: string): Promise<TreeNode[]> { this.#deny(); }
  async readFilesAtCommit(_commitId: string, _paths: string[])
      : Promise<[path: string, FileAtCommit][]> {
    this.#deny();
  }
  async getCommitLog(_fromCommit: string, _depth?: number): Promise<CommitInfo[]> {
    this.#deny();
  }

  async updateChatFromMainline(_chatId: number): Promise<{conflictPaths: string[]}> {
    this.#deny();
  }
  async listPreApprovableActions(): Promise<PreApprovableAction[]> { this.#deny(); }
  async getGatekeeperById(_id: number): Promise<GatekeeperClient<any>> { this.#deny(); }
  async newGatekeeper(_accountId: number, _resourceUrl: string)
      : Promise<GatekeeperClient<any> | null> { this.#deny(); }
  async newAiModelGatekeeper(_modelId: string): Promise<GatekeeperClient<any>> { this.#deny(); }
  async newAgentSpawnerGatekeeper(_config: AgentSpawnerConfig): Promise<GatekeeperClient<any>> {
    this.#deny();
  }
  // Pending actions are queried eagerly for the badge; resolved history is demand-loaded. Return
  // an empty terminal page so this speculative read does not fail for "use" collaborators.
  async listActions(_options?: {beforeId?: number, filter?: ActionHistoryFilter})
      : Promise<ActionHistoryPage> {
    return {entries: []};
  }
  async approveAction(_id: number): Promise<void> { this.#deny(); }
  async rejectAction(_id: number): Promise<void> { this.#deny(); }
  async listHooks(): Promise<BoundHookInfo[]> { this.#deny(); }
  async enableHook(_id: number): Promise<void> { this.#deny(); }
  async disableHook(_id: number): Promise<void> { this.#deny(); }
  async deleteHook(_id: number): Promise<void> { this.#deny(); }
  async setAutoApprovedActionKind(_gatekeeperId: WorkpieceId, _actionKind: ActionKind)
      : Promise<void> { this.#deny(); }
  async removeAutoApprovedActionKind(_gatekeeperId: WorkpieceId, _tag: string): Promise<void> { this.#deny(); }
  async listAutoApprovedActionKinds()
      : Promise<Array<{ gatekeeperId: WorkpieceId; actionKind: ActionKind }>> {
    this.#deny();
  }
  async acceptConnectionRequest(_requestId: string, _result: {gatekeeperId: number}): Promise<void> { this.#deny(); }
  async denyConnectionRequest(_requestId: string): Promise<void>  { this.#deny(); }
  async subscribeToActions(
      subscriber: RpcStub<ActionsSubscriber>, _startAfter?: Date): Promise<RpcStub<{}>> {
    // Inert: "use" sessions have no visibility into the action log. Signal a settled, empty log
    // (so the client doesn't sit in a perpetual "loading" state) and never deliver entries.
    let sub = subscriber.dup();
    sub.ready().catch(() => {});
    // @ts-expect-error Bugs in native RPC types make this not work currently.
    return this.#subscriptionLease(new NativeRpcStub<{}>({
      [Symbol.dispose]() {
        sub[Symbol.dispose]();
      }
    }));
  }
  async listChats(): Promise<AiChatMetadata[]> { this.#deny(); }
  async listModels(): Promise<AiChatAuthorInfo[]> { this.#deny(); }
  async getChatHistory(_chatId: number, _beforeSequence?: number): Promise<AiChatHistoryPage> {
    this.#deny();
  }
  async getChatMessage(_chatId: number, _sequence: number): Promise<AiChatMessage | undefined> { this.#deny(); }
  async listSlashCommands(): Promise<SlashCommandChoice[]> { this.#deny(); }
  async subscribeToChat(
      _subscriber: RpcStub<AiChatSubscriber>, _startAfter?: Date): Promise<RpcStub<{}>> {
    this.#deny();
  }
  async newChat(_initialMessage: string | SlashCommandRequest, _modelId: string | null,
                 _capsules?: CapsuleSpecifier[], _attachments?: ChatAttachmentHandle[]): Promise<number> {
    this.#deny();
  }
  async sendChatMessage(_chatId: number, _message: string | SlashCommandRequest,
                        _modelId: string | null,
                        _capsules?: CapsuleSpecifier[], _attachments?: ChatAttachmentHandle[]): Promise<void> {
    this.#deny();
  }
  async uploadChatAttachment(
    _attachment: ChatAttachmentUpload,
    _modelId: string | null,
  ): Promise<ChatAttachmentHandle> { this.#deny(); }
  async getChatAttachmentContent(_chatId: number, _id: string): Promise<Uint8Array> { this.#deny(); }
  async deleteChatAttachment(_id: string): Promise<void> { this.#deny(); }
  async setChatTitle(_chatId: number, _title: string): Promise<void> { this.#deny(); }
  async mergeChanges(_chatId: number): Promise<MergeChangesResult> {
    this.#deny();
  }
  async revertChanges(_chatId: number, _revertFrom: number): Promise<void> { this.#deny(); }
  async finalizeChatDraft(_chatId: number): Promise<void> { this.#deny(); }
  async discardChatDraftChanges(_chatId: number): Promise<void> { this.#deny(); }
  async deleteChat(_chatId: number): Promise<void> { this.#deny(); }
  async stopAgent(_chatId: number): Promise<void> { this.#deny(); }
  async retryAgent(_chatId: number, _modelId: string): Promise<void> { this.#deny(); }
  async subscribeToConsoleLogs(_subscriber: RpcStub<ConsoleLogSubscriber>): Promise<RpcStub<{}>> {
    // Inert: "use" sessions never receive console logs. The inbound subscriber stub is left
    // undup'd, so the RPC system disposes it when this call returns.
    // @ts-expect-error Bugs in native RPC types make this not work currently.
    return this.#subscriptionLease(new NativeRpcStub<{}>({
      [Symbol.dispose]() {}
    }));
  }
  async listBlueprints(): Promise<BlueprintGadgetSummary[]> { this.#deny(); }
  async updateBlueprint(_blueprintId: string, _options: {
    title?: string;
    description?: string;
    updateCode?: boolean;
    updateBindings?: boolean;
    screenshot?: BlueprintScreenshotUpload | null;
  }): Promise<void> { this.#deny(); }
  async deleteBlueprint(_blueprintId: string): Promise<void> { this.#deny(); }
  async retryBlueprintPublish(_blueprintId: string): Promise<void> { this.#deny(); }
  async listObserverRequirements(
      _role: CollaboratorRole): Promise<ObserverBindingNeed[]> { this.#deny(); }
  async listCollaborators(): Promise<CollaboratorInfo[]> { this.#deny(); }
  async addCollaborator(_username: string, _role: CollaboratorRole, _note?: string)
      : Promise<CollaboratorInfo | null> { this.#deny(); }
  async removeCollaborator(_profileId: string, _keepUsers: string[])
      : Promise<AffectedCollaborator[]> { this.#deny(); }
  async previewRemoveCollaborator(_profileId: string): Promise<AffectedCollaborator[]> {
    this.#deny();
  }
  async createShareLink(_role: CollaboratorRole, _note?: string)
      : Promise<{ key: string; linkId: string }> {
    this.#deny();
  }
  async newShareLinkKey(_linkId: string): Promise<{ key: string }> { this.#deny(); }
  async listShareLinks(): Promise<ShareLinkInfo[]> { this.#deny(); }
  async updateShareLink(_linkId: string, _note?: string): Promise<void> { this.#deny(); }
  async revokeShareLink(_linkId: string, _keepUsers: string[]): Promise<AffectedCollaborator[]> {
    this.#deny();
  }
  async previewRevokeShareLink(_linkId: string): Promise<AffectedCollaborator[]> { this.#deny(); }
}

// Capability representing one gadget workpiece, handed to "build"-role sessions via
// Overseer.createGadget()/getGadget().
//
// `joinedAs` counts this capability toward #hasCollaboratorSession for its lifetime (passed for
// collaborator mints, omitted for the owner's and for internal construction): a client can dispose
// the parent interface while retaining this one, and a retained capability that escaped the count
// would let a scope widening find no session to sever.
@validateRpc()
class GadgetClientImpl extends RpcTarget implements GadgetClient {
  #leaveSession?: () => void;

  constructor(private impl: OverseerImpl, private id: WorkpieceId,
      private clientUserId: string, private joinedAs?: SessionKind) {
    super();
    if (joinedAs) this.#leaveSession = impl.joinSession(joinedAs);
  }

  [Symbol.dispose]() {
    this.#leaveSession?.();
  }

  // Fresh stub per call; see OverseerClientInterface.#clientUser.
  get #clientUser(): DurableObjectStub<UserDurableObject> {
    return wrapDoStubForTelemetry(
        this.impl.users.get(this.impl.users.idFromString(this.clientUserId)),
        this.impl.logger);
  }

  async getId(): Promise<WorkpieceId> {
    return this.id;
  }

  async getTitle(): Promise<string> {
    return this.impl.getGadgetRecord(this.id).title;
  }

  async setTitle(title: string): Promise<void> {
    let record = this.impl.getGadgetRecord(this.id);
    record.title = title;
    this.impl.storage.gadgets.put(record);
  }

  async remove(): Promise<void> {
    return this.impl.removeWorkpiece(this.id);
  }

  async getUiBundle(chatId?: number): Promise<UiBundle | null> {
    return this.impl.getGadgetUiBundle(this.id, chatId);
  }

  async connectToGadget(chatId?: number): Promise<RpcStub<any>> {
    this.impl.recordGadgetAnalytics({
      event_name: "gadget_interaction",
      user_id: this.#clientUser.id.toString(),
      chat_id: chatId,
      interaction_type: "gadget_ui_connected",
    });
    // The facet stub counts exactly as this capability does (joinedAs): it can outlive this
    // object, and it is the very stub a hook-enable widening's data flows through.
    return this.impl.getGadgetFacet(this.id, chatId, this.joinedAs);
  }

  async getExportFormats(chatId?: number): Promise<GadgetExportFormat[]> {
    return this.impl.getGadgetExportFormats(this.id, chatId);
  }

  async export(formatId: string, chatId?: number): Promise<ReadableStream<Uint8Array>> {
    return this.impl.exportGadget(this.id, formatId, chatId);
  }

  async listBindings(chatId?: number): Promise<GadgetBindingInfo[]> {
    let record = this.impl.getGadgetRecord(this.id);
    // Edges pending in other chats are those chats' unaccepted proposals, so they aren't listed.
    return this.impl.visibleBindings(record, chatId).map(([name, edge]) => {
      let gatekeeper = this.impl.storage.gatekeepers.get(edge.target);
      return {
        name,
        target: edge.target,
        resourceTitle: gatekeeper?.resourceTitle || "(title unavailable)",
        vendorId: gatekeeper?.creationSpec?.type === "gatekeeper"
            ? gatekeeper.creationSpec.vendorId
            : undefined,
        ...(edge.pending ? {chatId: edge.pending.chatId} : {}),
      };
    });
  }

  async getBinding(name: string): Promise<GatekeeperClient<any> | null> {
    let record = this.impl.getGadgetRecord(this.id);
    let edge = record.bindings[name];
    if (!edge || edge.pending || !this.impl.storage.gatekeepers.get(edge.target)) return null;
    // The child capability counts exactly as this one does: it can outlive this object.
    return new GatekeeperClientImpl(
        this.impl, edge.target, this.impl.getGatekeeperFacet(edge.target),
        this.clientUserId, this.joinedAs);
  }

  async bind(name: string, target: WorkpieceId, chatId?: number): Promise<void> {
    if (chatId === undefined) {
      this.impl.bindWorkpiece(this.id, name, target);
      return;
    }

    // Binding with a chat open is provisional to that chat, like code edits: write the pending
    // edge and the "changes" message that records (and sequence-stamps) it in one synchronous
    // step, so this path has no crash window (mirroring user-initiated gadget creation).
    if (!this.impl.storage.chatMeta.get(chatId)) {
      throw new Error(`No such chat: ${chatId}`);
    }
    let author = await retryOnDoReset(() => this.#clientUser.whoami(), this.impl.logger);
    this.impl.bindWorkpiece(this.id, name, target, chatId);
    this.impl.addChatMessages(chatId, author, [{
      type: "changes",
      addedBindings: [{gadgetId: this.id, name, target}],
    }]);
  }

  async bindWithSuggestedName(target: WorkpieceId, chatId?: number): Promise<string> {
    let record = this.impl.getGadgetRecord(this.id);
    let existing = this.impl.visibleBindings(record, chatId)
        .find(([, edge]) => edge.target === target);
    if (existing) {
      return existing[0];
    }

    // The target is client-supplied, so refuse one blocked pending a scope-widening restart
    // before reaching its facet (metadata-only, but every client-reachable route is gated).
    this.impl.assertGatekeeperUsable(target);
    let description = await this.impl.getGatekeeperFacet(target).describe();
    let suggestedName = description.suggestedBindingName;
    let i = 1;
    // Re-read the record after the describe() await, in case bindings changed meanwhile. Dedupe
    // against ALL edges, including other chats' pending ones (which occupy their names).
    record = this.impl.getGadgetRecord(this.id);
    while (record.bindings[suggestedName] !== undefined) {
      suggestedName = `${description.suggestedBindingName}_${++i}`;
    }
    await this.bind(suggestedName, target, chatId);
    return suggestedName;
  }

  async unbind(name: string): Promise<void> {
    this.impl.unbindWorkpiece(this.id, name);
  }

  async renameBinding(oldName: string, newName: string): Promise<void> {
    this.impl.renameBinding(this.id, oldName, newName);
  }

  #getBindingEdge(name: string): {record: GadgetRecord, edge: BindingRecord} {
    let record = this.impl.getGadgetRecord(this.id);
    let edge = record.bindings[name];
    if (!edge) throw new Error(`No such binding: ${name}`);
    return {record, edge};
  }

  async getBlueprintAnnotation(name: string): Promise<BlueprintBindingAnnotation | null> {
    let {edge} = this.#getBindingEdge(name);
    let annotation = edge.blueprintAnnotation;
    if (!annotation) return null;
    let gatekeeper = this.impl.storage.gatekeepers.get(edge.target);
    return {
      title: annotation.title ||
          (gatekeeper ? defaultBlueprintBindingTitle(gatekeeper, name) : name),
      description: annotation.description ?? "",
      suggestValue: annotation.suggestValue,
    };
  }

  async setBlueprintAnnotation(name: string, annotation: BlueprintBindingAnnotation)
      : Promise<void> {
    let {record, edge} = this.#getBindingEdge(name);
    let gatekeeper = this.impl.storage.gatekeepers.get(edge.target);
    edge.blueprintAnnotation = {
      title: annotation.title.trim() ||
          (gatekeeper ? defaultBlueprintBindingTitle(gatekeeper, name) : name),
      description: annotation.description,
      suggestValue: annotation.suggestValue,
    };
    this.impl.storage.gadgets.put(record);
  }

  async createBlueprint(title?: string, description?: string,
                        screenshotUpload?: BlueprintScreenshotUpload)
      : Promise<BlueprintGadgetSummary> {
    if (!this.impl.ownerId) throw new Error("Workspace not initialized.");

    // NOTE: It is INTENTIONAL that collaborators can publish blueprints on behalf of the owner.
    //   We may in the future create different collaborator permission levels, in which case we'd
    //   need an auth check here and the following methods.

    let gadget = this.impl.getGadgetRecord(this.id);
    if (gadget.pending) {
      // A provisional gadget's files live only in its chat's proposed changes; snapshotting its
      // (empty) mainline code would produce a useless blueprint.
      throw new Error("This gadget is a provisional creation in a chat. Accept the chat's " +
          "changes before creating a blueprint from it.");
    }

    // Generate 128-bit random ID as hex.
    let idBytes = new Uint8Array(16);
    crypto.getRandomValues(idBytes);
    let id = idBytes.toHex();

    // Collect binding metadata (validates all annotations are configured).
    let bindings = this.impl.collectBindingMetadata(this.id);

    // Get gadget owner's profile for the author field.
    let owner = this.impl.users.get(this.impl.users.idFromString(this.impl.ownerId));
    let ownerProfile = await owner.whoami();

    // The blueprint exports the gadget's committed code, keyed by its head commit. (Re-read the
    // record after the awaits above so the head is current.) A blueprint of a code-less gadget
    // would be useless, so refuse rather than publish an empty archive.
    let commitId = await this.impl.assertPublishableCommit(
        this.impl.getGadgetRecord(this.id).commitId);
    let now = new Date();

    let metadata: BlueprintMetadata = {
      title: title || gadget.title,
      description: description || "",
      author: ownerProfile,
      created: now,
      version: 1,
      lastUpdated: now,
      bindings,
    };

    // Republishing preserves the format: a blueprint made from a Document still produces
    // Documents.
    if (gadget.output) {
      metadata.output = gadget.output;
    }

    let record: BlueprintGadgetRecord = {
      id,
      metadata,
      gadgetId: this.id,
      commitId,
    };

    let screenshot = screenshotUpload ? validateBlueprintScreenshotUpload(screenshotUpload) : undefined;

    // Snapshot the committed code and propagate to User DO, KV, R2.
    let codeSnapshot = await this.impl.snapshotCode(commitId);
    await this.impl.propagateBlueprint(record, codeSnapshot, screenshot);

    this.impl.recordGadgetAnalytics({
      event_name: "blueprint_created",
      user_id: this.#clientUser.id.toString(),
      blueprint_id: id,
    });

    // Derive codeVersionDate from the exported commit.
    let codeVersionDate =
        (await this.impl.gitStore.readCommitLog(commitId, {depth: 1}))[0].timestamp;

    return {
      id,
      title: metadata.title,
      description: metadata.description,
      version: metadata.version,
      codeVersionDate,
      screenshotUrl: blueprintScreenshotUrl(id, metadata),
      dirty: record.dirty,
    };
  }
}

// Restricted GadgetClient handed to "use"-role collaborators: it permits only what is needed to
// render and interact with the gadget's deployed UI, mainline-only. Like UseOverseerInterface,
// `implements GadgetClient` enforces default-deny at compile time: any new GadgetClient method
// fails to compile here until a developer decides whether "use" callers may invoke it.
@validateRpc()
class UseGadgetClientInterface extends RpcTarget implements GadgetClient {
  // Only ever minted for "use" collaborators, so it always counts toward #hasCollaboratorSession:
  // a client can dispose their UseOverseerInterface while retaining this, and a retained
  // capability that escaped the count would let a scope widening find no session to sever.
  #leaveSession: () => void;

  constructor(private impl: OverseerImpl, private id: WorkpieceId,
      private clientUserId: string) {
    super();
    this.#leaveSession = impl.joinSession("use");
  }

  [Symbol.dispose]() {
    this.#leaveSession();
  }

  // Fresh stub per call; see OverseerClientInterface.#clientUser.
  get #clientUser(): DurableObjectStub<UserDurableObject> {
    return wrapDoStubForTelemetry(
        this.impl.users.get(this.impl.users.idFromString(this.clientUserId)),
        this.impl.logger);
  }

  #deny(): never {
    throw new Error("Unauthorized: this collaborator only has permission to use the gadget's UI.");
  }

  // --- Allowed methods ---

  async getId(): Promise<WorkpieceId> {
    return this.id;
  }

  async getTitle(): Promise<string> {
    return this.impl.getGadgetRecord(this.id).title;
  }

  async getUiBundle(chatId?: number): Promise<UiBundle | null> {
    if (chatId !== undefined) {
      this.#deny();
    }
    return this.impl.getGadgetUiBundle(this.id);
  }

  async connectToGadget(chatId?: number): Promise<RpcStub<any>> {
    if (chatId !== undefined) {
      this.#deny();
    }

    this.impl.recordGadgetAnalytics({
      event_name: "gadget_interaction",
      user_id: this.#clientUser.id.toString(),
      interaction_type: "gadget_ui_connected",
    });
    // The facet stub counts as a "use" session for its own lifetime, like this interface: it can
    // outlive this object, and it is the very stub a hook-enable widening's data flows through.
    return this.impl.getGadgetFacet(this.id, undefined, "use");
  }

  async getExportFormats(chatId?: number): Promise<GadgetExportFormat[]> {
    if (chatId !== undefined) this.#deny();
    return this.impl.getGadgetExportFormats(this.id);
  }

  async export(id: string, chatId?: number): Promise<ReadableStream<Uint8Array>> {
    if (chatId !== undefined) this.#deny();
    return this.impl.exportGadget(this.id, id);
  }

  // --- Denied methods (build-only) ---

  async setTitle(_title: string): Promise<void> { this.#deny(); }
  async remove(): Promise<void> { this.#deny(); }
  async listBindings(): Promise<GadgetBindingInfo[]> { this.#deny(); }
  async getBinding(_name: string): Promise<GatekeeperClient<any> | null> { this.#deny(); }
  async bind(_name: string, _target: WorkpieceId): Promise<void> { this.#deny(); }
  async bindWithSuggestedName(_target: WorkpieceId): Promise<string> { this.#deny(); }
  async unbind(_name: string): Promise<void> { this.#deny(); }
  async renameBinding(_oldName: string, _newName: string): Promise<void> { this.#deny(); }
  async getBlueprintAnnotation(_name: string): Promise<BlueprintBindingAnnotation | null> {
    this.#deny();
  }
  async setBlueprintAnnotation(_name: string, _annotation: BlueprintBindingAnnotation)
      : Promise<void> { this.#deny(); }
  async createBlueprint(_title?: string, _description?: string,
                        _screenshot?: BlueprintScreenshotUpload): Promise<BlueprintGadgetSummary> {
    this.#deny();
  }
}

@validateRpc()
class GatekeeperClientImpl<Session extends RpcCompatible<Session>>
    extends RpcTarget implements GatekeeperClient<Session> {
  // See GadgetClientImpl: `joinedAs` counts a collaborator's retained capability toward
  // #hasCollaboratorSession; omitted for the owner's and for internal construction.
  // `actorUserId` (hex user DO ID of the client holding this capability) feeds analytics only.
  #leaveSession?: () => void;

  constructor(private impl: OverseerImpl, private id: number,
      private facet: Fetcher<Gatekeeper<Session>>,
      private actorUserId: string,
      joinedAs?: SessionKind) {
    super();
    if (joinedAs) this.#leaveSession = impl.joinSession(joinedAs);
  }

  [Symbol.dispose]() {
    this.#leaveSession?.();
  }

  async remove(): Promise<void> {
    let record = this.impl.storage.gatekeepers.get(this.id);
    this.impl.removeGatekeeper(this.id);
    this.impl.recordGadgetAnalytics({
      event_name: "connection_removed",
      user_id: this.actorUserId,
      gatekeeper_id: this.id,
      connection_type: connectionTypeFromCreationSpec(record?.creationSpec?.type),
      vendor_id: record?.creationSpec?.type === "gatekeeper" ? record.creationSpec.vendorId : undefined,
    });
  }

  async getId(): Promise<number> {
    return this.id;
  }

  #getRecord(): GatekeeperRecord {
    let record = this.impl.storage.gatekeepers.get(this.id);
    if (!record) throw new Error("No such gatekeeper.");
    return record;
  }

  async getTitle(): Promise<string> {
    return this.#getRecord().resourceTitle || "(title unavailable)";
  }

  async setTitle(title: string): Promise<void> {
    // This changes only the display title used locally within this workspace (resourceTitle is a
    // denormalized copy of the remote resource's title), never the remote resource.
    let record = this.#getRecord();
    record.resourceTitle = title;
    this.impl.storage.gatekeepers.put(record);
  }

  async describe(): Promise<ResourceDescription> {
    return this.facet.describe();
  }

  async openSession(): Promise<RpcStub<Session>> {
    return this.impl.openGatekeeperSession(this.id, this.facet, {from: "user"});
  }

  async getCreationSpec(): Promise<GatekeeperCreationSpec> {
    let record = this.#getRecord();
    if (!record.creationSpec) {
      throw new Error("This gatekeeper has no creation spec (created before blueprint support).");
    }
    return record.creationSpec;
  }
}

// ObservationAuthorizer handed to a slash-command provider. Scoped to one Gatekeeper; observations
// only (no actions or hooks).
@validateRpc()
class SlashCommandAuthorizerImpl extends NativeRpcTarget implements ObservationAuthorizer {
  constructor(private impl: OverseerImpl, private gatekeeperId: number,
              private caller: GatekeeperCaller) {
    super();
  }

  authorizeObservation(description: ObservationDescription): Promise<void> {
    return this.impl.authorizeObservation(this.gatekeeperId, description, this.caller);
  }

  async getGitCache(): Promise<GitCache> {
    return new GitCacheImpl(this.impl.gitCache, this.gatekeeperId);
  }
}

// Re-resolve a hook's record and refuse unless it is still enabled and its connection usable.
// Deleting or disabling the record is the authoritative kill (removeGatekeeper, deleteHook,
// disableHook), and the capabilities startHook issues are held outside this DO -- in other DOs
// (e.g. a scheduler driver), across resets -- so each call through them checks the record *now*
// rather than trusting the moment of issue. The gatekeeperId check additionally keeps a
// quarantined connection refused on the hook routes: the enable that armed a hook may itself be
// the widening that scheduled a restart, and a shrink-then-rewiden leaves stale firings pointing
// at a connection pending re-verification (see #gatekeepersPendingRestart).
function requireLiveHook(impl: OverseerImpl, hookId: number): BoundHookRecord {
  let record = impl.storage.boundHooks.get(hookId);
  if (!record?.enabled) throw new Error("Hook has been deleted or disabled.");
  impl.assertGatekeeperUsable(record.gatekeeperId);
  return record;
}

// The callback startHook returns to each firing: a wrapper that re-resolves the stored callback
// through requireLiveHook on every call, so it dies with the hook -- the per-firing revocation
// the session contract on Gatekeeper.bindHook documents. The stored record.callback itself never
// leaves the DO again: it is a persistent stub (it survives row deletion and DO resets), so once
// issued it could never be revoked, and a holder would keep a live write channel into the gadget
// after a disable/delete shrank every collaborator's verification scope.
//
// The wrapper covers the root callback only. Capabilities a callback method *returns* reach the
// firing as independent stubs (the bindHook contract permits hooks to pass and return them) and
// are not re-checked per call. That is deliberate: the holder is a gatekeeper bound by the session
// contract, and this is a guard against a stale firing by mistake, not a revocable membrane.
function makeHookFiringCallback(impl: OverseerImpl, hookId: number): NativeRpcStub<RpcTarget> {
  // The proxy target must be callable for the `apply` trap to ever fire (a Proxy over a
  // non-callable target is itself non-callable), and the bindHook contract allows the bound
  // callback to be a function type, invoked by calling the firing's callback directly. An arrow
  // function also has no `prototype` own-property to conflict with the wildcard `get` below.
  // TODO: Same workerd bug as startGatekeeperHook: a Proxy returned as an RpcTarget is judged
  //   non-pipelineable, so wrap it in a stub manually.
  return new NativeRpcStub(new Proxy((() => {}) as unknown as RpcTarget, {
    // Both traps are async so a refusal is a rejection of that call, not a synchronous throw
    // escaping into the RPC machinery that invokes the function (workerd reports that as
    // uncaught, too).
    async apply(_target, _thisArg, args: unknown[]) {
      let record = requireLiveHook(impl, hookId);
      return Reflect.apply(record.callback as any, undefined, args);
    },
    get(_target, prop) {
      // All wildcard properties of a stub appear as functions, so `then` must come back
      // undefined (this is not a thenable) and symbols are never RPC methods -- the same
      // dispositions as getGadgetFacet's proxy over the gadget facet.
      if (typeof prop === "symbol" || prop === "then") return undefined;
      return async (...args: unknown[]) => {
        let record = requireLiveHook(impl, hookId);
        return Reflect.apply((record.callback as any)[prop], record.callback, args);
      };
    },
    getPrototypeOf() {
      return RpcTarget.prototype;
    },
  }));
}

@validateRpc()
class ApprovalQueueImpl extends RpcTarget implements ApprovalQueue {
  // `hookId` is set only on the queue startHook returns with each firing: that queue is held by
  // the gatekeeper across awaits (even other DOs), so like the firing's callback it revalidates
  // the hook per call -- otherwise a firing raced by a disable/delete could keep authorizing
  // observations against a scope the shrink already excluded someone from (or set
  // containsRestrictedData). Session queues (openGatekeeperSession) pass no hookId: they are
  // bounded by the facet's in-DO lifetime, which the session chokepoints already gate.
  constructor(private impl: OverseerImpl, private gatekeeperId: number,
              private caller: GatekeeperCaller, private hookId?: number) {
    super();
  }

  authorizeObservation(description: ObservationDescription): Promise<void> {
    if (this.hookId !== undefined) requireLiveHook(this.impl, this.hookId);
    return this.impl.authorizeObservation(this.gatekeeperId, description, this.caller);
  }

  async getGitCache(): Promise<GitCache> {
    return new GitCacheImpl(this.impl.gitCache, this.gatekeeperId);
  }

  submitAction(action: number, description: ActionDescription): Promise<void> {
    if (this.hookId !== undefined) requireLiveHook(this.impl, this.hookId);
    return this.impl.submitAction(this.gatekeeperId, action, description, this.caller);
  }

  bindHook<Hook extends RpcTarget>(
        controller: Fetcher<HookController<Hook>>, callback: NativeRpcStub<Hook>,
        description: HookDescription): Promise<void> {
    if (this.hookId !== undefined) requireLiveHook(this.impl, this.hookId);
    return this.impl.bindHook(this.gatekeeperId, controller, callback, description, this.caller);
  }
}
