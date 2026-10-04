// Hand-rolled git object and packfile codec, used by the git cache (git-cache.ts).
//
// This is the *read-side* codec for the cache's lazy paths plus the pack codec for
// `GitCache.buildPack()`/`consumePack()`. It deliberately does not use isomorphic-git:
// - The lazy walker needs to parse objects it fetched by bare oid, attributing errors to the
//   object (e.g. a tree with a non-UTF-8 entry name must fail naming the tree), and to see all
//   five tree entry modes -- isomorphic-git's fs-shaped API fits neither well.
// - Pack *decoding* is hostile-input parsing (any gatekeeper can feed `consumePack()` anything),
//   so it must bound allocations and fail loudly. isomorphic-git's pack machinery is not
//   reachable from its exports map in 1.40 (verified), and the public `indexPack` route both
//   silently *skips* objects whose delta chain fails to resolve and trusts claimed sizes.
// isomorphic-git remains the engine for the existing full-materialization reads and all tree/
// commit *writes* (git-store.ts); tests cross-verify the two codecs over the same store.
//
// Everything here is pure computation over bytes (the pack decoder reads a stream): no storage,
// no RPC. Storing a mount pack inflates every object it carries and deflates it again, and both
// use workerd's native node:zlib: pako's deflate takes about twice the CPU of the native one, and
// its inflate allocates some 100 KiB per stream. Pack entries are concatenated zlib streams with
// no recorded lengths, so the decoder has to learn where each one ends -- inflateSync reports the
// input it consumed when asked for `info`, which DecompressionStream cannot do. Only writing a
// pack (buildPackBytes, the push path) still uses pako, the library isomorphic-git bundles.

import { constants, deflateSync, inflateSync } from "node:zlib";
import { deflate } from "pako";
import type { GitObjectType, GitOid } from "@gadgets/workshop-shared/gatekeeper";

const ENCODER = new TextEncoder();

/** Matches a full 40-hex SHA-1 git object name. */
const OID_REGEX = /^[0-9a-f]{40}$/;

/** Validates an externally-supplied oid before it is used as a storage key or in a walk. */
export function validateGitOid(oid: string): GitOid {
  if (!OID_REGEX.test(oid)) throw new Error(`Invalid git object id: ${JSON.stringify(oid)}`);
  return oid;
}

const GIT_OBJECT_TYPES: readonly GitObjectType[] = ["commit", "tree", "blob", "tag"];

/** Validates an externally-supplied object type string. */
export function validateGitObjectType(type: string): GitObjectType {
  if (!(GIT_OBJECT_TYPES as readonly string[]).includes(type)) {
    throw new Error(`Invalid git object type: ${JSON.stringify(type)}`);
  }
  return type as GitObjectType;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Concatenates byte arrays. */
export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let pos = 0;
  for (let part of parts) {
    out.set(part, pos);
    pos += part.byteLength;
  }
  return out;
}

// =======================================================================================
// Loose objects
//
// A loose object is zlib(`<type> <size>\0` + payload); its oid is the SHA-1 of the *inflated*
// whole. These helpers are the raw codec behind GitObjectRecord.data (see
// storage-schema/overseer-storage.ts) -- byte-compatible with what isomorphic-git reads and
// writes there, though the compressed bytes need not be bit-identical (the store is keyed by
// oid; readers inflate).

/** Computes the oid of an object from its type and headerless payload. */
export async function gitObjectOid(type: GitObjectType, payload: Uint8Array): Promise<GitOid> {
  let header = ENCODER.encode(`${type} ${payload.byteLength}\0`);
  let digest = await crypto.subtle.digest("SHA-1", concatBytes([header, payload]));
  return toHex(new Uint8Array(digest));
}

/**
 * Encodes a loose object record's `data` bytes from a type and headerless payload, deflated at
 * zlib's fastest level: git's own default for loose objects (`core.looseCompression`), and this
 * deflate is the largest single cost of storing a pack.
 */
export function encodeLooseObject(type: GitObjectType, payload: Uint8Array): Uint8Array {
  let header = ENCODER.encode(`${type} ${payload.byteLength}\0`);
  return deflateSync(concatBytes([header, payload]), { level: constants.Z_BEST_SPEED });
}

/** Decodes a loose object record's `data` bytes into its type and headerless payload. */
export function decodeLooseObject(data: Uint8Array): { type: GitObjectType, payload: Uint8Array } {
  let whole: Uint8Array;
  try {
    // inflateSync returns a Buffer, a Uint8Array subclass whose slice() aliases rather than
    // copies; the payload handed out is a plain Uint8Array over the same bytes.
    let inflated = inflateSync(data);
    whole = new Uint8Array(inflated.buffer, inflated.byteOffset, inflated.byteLength);
  } catch (err) {
    throw new Error(`corrupt loose git object: ${String(err)}`, { cause: err });
  }
  let nul = whole.indexOf(0);
  if (nul < 0 || nul > 31) throw new Error("corrupt loose git object: missing header");
  let header = new TextDecoder().decode(whole.subarray(0, nul));
  let space = header.indexOf(" ");
  if (space < 0) throw new Error("corrupt loose git object: malformed header");
  let type = validateGitObjectType(header.slice(0, space));
  let size = Number(header.slice(space + 1));
  let payload = whole.subarray(nul + 1);
  if (!Number.isSafeInteger(size) || size !== payload.byteLength) {
    throw new Error("corrupt loose git object: header size does not match payload");
  }
  return { type, payload };
}

// =======================================================================================
// Tree objects
//
// A tree payload is a sequence of `<mode> <name>\0<20-byte oid>` entries. All five modes a real
// repo can contain are recognized; nothing else is (an unknown mode is a parse error, not a
// silent skip, so a misparse can never misattribute content).

/** The five tree entry modes git writes, exactly as serialized (no leading zero on trees). */
export type GitTreeEntryMode = "100644" | "100755" | "40000" | "120000" | "160000";

const TREE_ENTRY_MODES: readonly GitTreeEntryMode[] =
    ["100644", "100755", "40000", "120000", "160000"];

/** The object type a tree entry of the given mode references. */
export function treeEntryObjectType(mode: GitTreeEntryMode): GitObjectType {
  return mode === "40000" ? "tree" : mode === "160000" ? "commit" : "blob";
}

/**
 * A structurally-parsed tree entry whose name is still raw bytes. Produced by `scanGitTree()`,
 * which (unlike `parseGitTree()`) tolerates names that are not valid UTF-8 -- for callers that
 * only follow oids (referent recording, the push marking walk) and must not fail on a tree that
 * merely *contains* an exotic name.
 */
export interface RawGitTreeEntry {
  mode: GitTreeEntryMode;
  nameBytes: Uint8Array;
  oid: GitOid;
}

/** A fully-parsed tree entry. See `parseGitTree()` for the name decoding contract. */
export interface GitTreeEntry {
  mode: GitTreeEntryMode;
  name: string;
  oid: GitOid;
}

/** Parses a tree payload structurally, leaving entry names as raw bytes. */
export function scanGitTree(payload: Uint8Array, treeOid?: GitOid): RawGitTreeEntry[] {
  let where = treeOid ?? "(unidentified)";
  let entries: RawGitTreeEntry[] = [];
  let pos = 0;
  while (pos < payload.byteLength) {
    let space = payload.indexOf(0x20, pos);
    if (space < 0 || space - pos > 6) throw new Error(`corrupt tree object ${where}: bad mode`);
    let mode = new TextDecoder().decode(payload.subarray(pos, space));
    if (!(TREE_ENTRY_MODES as readonly string[]).includes(mode)) {
      throw new Error(`corrupt tree object ${where}: unsupported entry mode ${mode}`);
    }
    let nul = payload.indexOf(0, space + 1);
    if (nul < 0 || nul === space + 1) throw new Error(`corrupt tree object ${where}: bad name`);
    if (nul + 21 > payload.byteLength) {
      throw new Error(`corrupt tree object ${where}: truncated entry`);
    }
    entries.push({
      mode: mode as GitTreeEntryMode,
      nameBytes: payload.subarray(space + 1, nul),
      oid: toHex(payload.subarray(nul + 1, nul + 21)),
    });
    pos = nul + 21;
  }
  return entries;
}

/**
 * Parses a tree payload including entry names, which are decoded as *strict* UTF-8: an invalid
 * name fails the whole parse with an error naming the tree and the offending bytes. Strictness
 * is a correctness property, not pedantry -- a lossy decode (replacement characters) could alias
 * two distinct byte names to one string path, making an edit silently target the wrong entry,
 * whereas names that pass strict decode re-encode to their exact original bytes and can never
 * alias. Non-UTF-8 names are vanishingly rare in practice; if one is ever hit for real, decide
 * the accommodation then.
 */
export function parseGitTree(payload: Uint8Array, treeOid?: GitOid): GitTreeEntry[] {
  // ignoreBOM keeps a leading BOM as content: stripping it would make the decode lossy, which
  // is exactly the aliasing this strict decode exists to prevent.
  let decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  return scanGitTree(payload, treeOid).map(entry => {
    let name: string;
    try {
      name = decoder.decode(entry.nameBytes);
    } catch {
      throw new Error(
          `tree object ${treeOid ?? "(unidentified)"} contains an entry name that is not ` +
          `valid UTF-8 (bytes ${toHex(entry.nameBytes)}); such trees are not supported`);
    }
    return { mode: entry.mode, name, oid: entry.oid };
  });
}

// =======================================================================================
// Commit objects

/** The oids a commit object references. */
export interface GitCommitRefs {
  tree: GitOid;
  parents: GitOid[];
}

/**
 * Extracts the tree and parent oids from a commit payload. Only the header section (everything
 * before the first blank line) is examined; continuation lines (leading space, e.g. within a
 * `gpgsig` header) are skipped, and the message is never decoded.
 */
export function parseGitCommitRefs(payload: Uint8Array, commitOid?: GitOid): GitCommitRefs {
  let where = commitOid ?? "(unidentified)";
  let tree: GitOid | undefined;
  let parents: GitOid[] = [];
  let decoder = new TextDecoder();
  let pos = 0;
  while (pos < payload.byteLength) {
    let eol = payload.indexOf(0x0a, pos);
    if (eol < 0) eol = payload.byteLength;
    if (eol === pos) break;                    // blank line: end of headers
    if (payload[pos] !== 0x20) {               // skip continuation lines
      let line = decoder.decode(payload.subarray(pos, eol));
      if (line.startsWith("tree ")) {
        if (tree !== undefined) throw new Error(`corrupt commit object ${where}: multiple trees`);
        tree = validateGitOid(line.slice(5));
      } else if (line.startsWith("parent ")) {
        parents.push(validateGitOid(line.slice(7)));
      }
    }
    pos = eol + 1;
  }
  if (tree === undefined) throw new Error(`corrupt commit object ${where}: missing tree header`);
  return { tree, parents };
}

// =======================================================================================
// Packfiles
//
// Format: "PACK" + u32 version (2) + u32 object count, then per object a varint header
// ((type << 4) | size, MSB-continued) followed by a zlib stream of the payload -- or, for delta
// entries (ofs-delta / ref-delta), the base reference followed by a zlib stream of delta
// instructions -- and finally a SHA-1 trailer over everything before it.

/** One object carried by (or destined for) a packfile. */
export interface PackableObject {
  type: GitObjectType;
  payload: Uint8Array;
}

const PACK_TYPE_CODES: Partial<Record<GitObjectType, number>> =
    { commit: 1, tree: 2, blob: 3, tag: 4 };
const PACK_CODE_TYPES: Record<number, GitObjectType> =
    { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };
const OFS_DELTA = 6;
const REF_DELTA = 7;

/**
 * Composes an undeltified packfile (with the standard SHA-1 trailer) carrying the given objects,
 * as a chunk list ready to stream. Deltification and thin packs are future internals; every
 * receiver accepts whole objects. (Output format verified against real `git index-pack --strict`
 * + `git fsck` over the fixture repo, in addition to the round-trip tests.)
 */
export async function buildPackBytes(objects: readonly PackableObject[]): Promise<Uint8Array[]> {
  let chunks: Uint8Array[] = [];
  let header = new Uint8Array(12);
  header.set(ENCODER.encode("PACK"), 0);
  new DataView(header.buffer).setUint32(4, 2);
  new DataView(header.buffer).setUint32(8, objects.length);
  chunks.push(header);
  for (let object of objects) {
    let typeCode = PACK_TYPE_CODES[object.type];
    if (typeCode === undefined) throw new Error(`cannot pack object of type ${object.type}`);
    chunks.push(packEntryHeader(typeCode, object.payload.byteLength));
    chunks.push(deflate(object.payload));
  }

  chunks.push(new Uint8Array(await crypto.subtle.digest("SHA-1", concatBytes(chunks))));
  return chunks;
}

// Encodes a pack entry header: 4 bits of size and the 3-bit type code in the first byte, then
// 7 bits of size per continuation byte, little-endian, MSB = "more".
function packEntryHeader(typeCode: number, size: number): Uint8Array {
  let bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  while (size > 0) {
    bytes.push(first | 0x80);
    first = size & 0x7f;
    size = Math.floor(size / 128);
  }
  bytes.push(first);
  return new Uint8Array(bytes);
}

/** Options for `decodePackStream()`. */
export interface DecodePackOptions {
  /** Hard cap on the pack's total byte size, enforced as the bytes arrive. */
  maxPackSize: number;

  /**
   * Hard cap on any single inflated object or delta result. This bounds allocations against a
   * hostile pack: claimed sizes are enforced *during* inflation, before the bytes materialize.
   */
  maxObjectSize: number;

  /**
   * Supplies a delta's base by oid. The decoder retains no objects, so this must return any it
   * has already yielded (see `decodePackStream()` on ordering) as well as any the caller already
   * has. Undefined makes the delta a hard error.
   */
  resolveBase: (oid: GitOid) => PackableObject | undefined;
}

/**
 * Decodes a packfile stream into its objects and their oids, in pack order, in one pass that
 * retains none of them. This is hostile-input parsing: every size is enforced during inflation,
 * the object count and trailer SHA-1 must both check out, and any unresolved delta or trailing
 * garbage is a hard error -- an object can be misdescribed by its source, but it cannot make this
 * function allocate unboundedly or silently drop entries. Each oid is computed from the object's
 * bytes, but the pack as a whole verifies only when the generator completes, so an object acted
 * on earlier may belong to a pack that then fails.
 *
 * One pass means a delta must follow its base. Ofs-deltas point backward by format, and
 * `git pack-objects` writes ref-delta bases first too, so every pack upload-pack sends for a fetch
 * without `have`s -- the only kind this codec serves -- qualifies.
 */
export async function* decodePackStream(
    pack: ReadableStream<Uint8Array>, options: DecodePackOptions)
    : AsyncGenerator<PackableObject & { oid: GitOid }> {
  using reader = new PackReader(pack, options.maxPackSize);
  let header = await reader.bytes(12);
  if (new TextDecoder().decode(header.subarray(0, 4)) !== "PACK") {
    throw new Error("invalid packfile: bad magic");
  }
  let view = new DataView(header.buffer);
  let version = view.getUint32(4);
  if (version !== 2) throw new Error(`invalid packfile: unsupported version ${version}`);
  let count = view.getUint32(8);

  let oidAt = new Map<number, GitOid>();  // by entry offset, for ofs-delta bases
  for (let i = 0; i < count; i++) {
    let entryStart = reader.offset;

    // Entry header: type + size varint.
    let byte = await reader.byte();
    let typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    for (let multiplier = 16; byte & 0x80; multiplier *= 128) {
      // No size under the cap has a digit this high. Left to run, the multiplier overflows and
      // the size becomes NaN, which every comparison below would let through.
      if (multiplier > options.maxObjectSize) {
        throw new Error(
            `invalid packfile: entry size exceeds the ${options.maxObjectSize}-byte limit`);
      }
      byte = await reader.byte();
      size += (byte & 0x7f) * multiplier;
    }
    if (size > options.maxObjectSize) {
      throw new Error(
          `invalid packfile: entry of ${size} bytes exceeds the ` +
          `${options.maxObjectSize}-byte limit`);
    }

    let baseOid: GitOid | undefined;
    if (typeCode === OFS_DELTA) {
      // Negative-offset varint (note the "+1" accumulation quirk of the format).
      byte = await reader.byte();
      let offset = byte & 0x7f;
      while (byte & 0x80) {
        byte = await reader.byte();
        offset = (offset + 1) * 128 + (byte & 0x7f);
      }
      baseOid = oidAt.get(entryStart - offset);
      if (baseOid === undefined) {
        throw new Error("invalid packfile: ofs-delta references no entry boundary");
      }
    } else if (typeCode === REF_DELTA) {
      baseOid = toHex(await reader.bytes(20));
    } else if (PACK_CODE_TYPES[typeCode] === undefined) {
      throw new Error(`invalid packfile: unsupported object type code ${typeCode}`);
    }

    let type = PACK_CODE_TYPES[typeCode];
    let payload = await reader.inflate(size);
    if (baseOid !== undefined) {
      let base = options.resolveBase(baseOid);
      if (base === undefined) {
        throw new Error(`invalid packfile: delta base ${baseOid} is unavailable`);
      }
      type = base.type;
      payload = applyGitDelta(payload, base.payload, options.maxObjectSize);
    }
    let oid = await gitObjectOid(type, payload);
    oidAt.set(entryStart, oid);
    yield { oid, type, payload };
  }

  let digest = await reader.endBody();
  let trailer = toHex(await reader.bytes(20));
  if (await reader.more()) {
    throw new Error("invalid packfile: trailing garbage after declared objects");
  }
  if (trailer !== digest) throw new Error("invalid packfile: trailer SHA-1 mismatch");
}

// What inflateSync returns when asked for `info`: the output, and the engine whose
// `bytesWritten` is how much of the input the zlib stream took. (@types/node declares the result
// a Buffer whatever the options.)
interface InflatedEntry {
  buffer: Uint8Array;
  engine: { bytesWritten: number };
}

const PACK_READ_SIZE = 64 << 10;

// decodePackStream's reads, in order, from a window over the bytes that have arrived and are not
// yet consumed, hashing every byte before `endBody()` (the trailer's SHA-1 input) as it leaves
// the window. Reads are BYOB, which a gatekeeper facet's pack stream supports once Workers RPC
// has carried it to the overseer (verified for the gatekeepers' pull-based stream shape): a
// default reader gets 4 KiB chunks there, and each read after one of the caller's storage writes
// costs an implicit commit (a TypeScript-size pack took 7.0 s of reads instead of 2.8 s, in
// workerd). Each read waits for a full buffer, because a BYOB read otherwise returns as soon as
// one of the source's chunks arrives, and GitHub sends a pack mostly in 8 KiB pieces.
class PackReader {
  #reader: ReadableStreamBYOBReader;
  #maxSize: number;
  #digest = new crypto.DigestStream("SHA-1");
  #hash: WritableStreamDefaultWriter<ArrayBuffer | ArrayBufferView> | undefined =
      this.#digest.getWriter();
  // Unread bytes are #window[#pos, #end); those before #pos are consumed and not yet hashed.
  #window = new Uint8Array(0);
  #pos = 0;
  #end = 0;
  #received = 0;
  #ended = false;

  constructor(stream: ReadableStream<Uint8Array>, maxSize: number) {
    this.#reader = stream.getReader({ mode: "byob" });
    this.#maxSize = maxSize;
  }

  /** The pack offset of the next unread byte. */
  get offset(): number {
    return this.#received - this.#end + this.#pos;
  }

  /** Whether any bytes remain, buffering at least one if so. */
  async more(): Promise<boolean> {
    return await this.#fill(1) > 0;
  }

  async byte(): Promise<number> {
    if (await this.#fill(1) === 0) throw new Error("invalid packfile: truncated");
    return this.#window[this.#pos++];
  }

  async bytes(n: number): Promise<Uint8Array> {
    if (await this.#fill(n) < n) throw new Error("invalid packfile: truncated");
    return this.#window.slice(this.#pos, this.#pos += n);
  }

  // Inflates the zlib stream at the read position. `size` comes from the (untrusted) entry
  // header; it was pre-checked against the object-size cap, and bounds the output here, so a
  // lying header cannot cause a larger allocation than it claimed.
  //
  // inflateSync needs the whole stream in one piece, and nothing records its length. It is first
  // given what is already buffered, up to what zlib itself could turn `size` bytes into or one
  // read's worth if that is less: an entry that has arrived is then decoded without waiting on
  // the pack behind it. While the stream is unfinished the input grows, to that first amount and
  // then doubling, up to `longest`: an eighth over `size`, with a read's slack for a small
  // object.
  //
  // `longest` is a limit on memory, not a rule of the format. The window holds an entry's whole
  // stream, and a stream may be any length for its output (short stored blocks, empty ones), so
  // without it one entry could buffer as much as the pack cap allows. No deflater git servers
  // use goes past it, but a valid stream that does is refused.
  async inflate(size: number): Promise<Uint8Array> {
    let longest = size + (size >>> 3) + PACK_READ_SIZE;
    let first = Math.min(size + (size >>> 12) + (size >>> 14) + 13, PACK_READ_SIZE);
    for (let want = Math.min(first, this.#end - this.#pos || first);;) {
      let buffered = await this.#fill(want);
      let input = this.#window.subarray(this.#pos, this.#pos + Math.min(buffered, want));
      let inflated: InflatedEntry;
      try {
        inflated = inflateSync(input, { info: true, maxOutputLength: size || 1 }) as
            unknown as InflatedEntry;
      } catch (err) {
        let code = err instanceof Error && "code" in err ? err.code : undefined;
        if (code === "Z_BUF_ERROR") {
          if (buffered < want) throw new Error("invalid packfile: truncated", { cause: err });
          if (want === longest) {
            throw new Error(
                `packfile entry of ${size} bytes has more than ${longest} bytes of compressed ` +
                `data, over the limit for one entry`, { cause: err });
          }
          want = want < first ? first : Math.min(2 * want, longest);
          continue;
        }
        let detail = err instanceof Error ? err.message : String(err);
        throw new Error(
            code === "ERR_BUFFER_TOO_LARGE"
                ? "invalid packfile: object larger than its declared size"
                : `invalid packfile: corrupt object data (${detail})`,
            { cause: err });
      }
      let { buffer, engine } = inflated;
      if (buffer.byteLength !== size) {
        // The output cap above cannot be 0, so a stream declared empty gets this far with a byte.
        let how = buffer.byteLength < size ? "smaller" : "larger";
        throw new Error(`invalid packfile: object ${how} than its declared size`);
      }
      this.#pos += engine.bytesWritten;
      // zlib inflates into 16 KiB chunks, and a result that fits one comes back as a view on
      // the whole chunk: copied, so an object the caller holds retains only its own bytes.
      return buffer.byteLength < buffer.buffer.byteLength
          ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer);
    }
  }

  /** Ends the hashed body at the read position, returning its SHA-1 (hex). */
  async endBody(): Promise<string> {
    let hash = this.#hash!;
    this.#hash = undefined;
    await hash.write(this.#window.subarray(0, this.#pos));
    await hash.close();
    return toHex(new Uint8Array(await this.#digest.digest));
  }

  // Cancels the source (a no-op once it has ended). Not awaited: a cancel can wait behind the
  // source's in-flight read.
  [Symbol.dispose](): void {
    this.#reader.cancel().catch(() => {});
  }

  // Buffers at least `n` unread bytes, or all that remain, and returns how many are buffered.
  async #fill(n: number): Promise<number> {
    while (this.#end - this.#pos < n && !this.#ended) {
      let next = await this.#reader.readAtLeast(PACK_READ_SIZE, new Uint8Array(PACK_READ_SIZE));
      if (next.done) {
        this.#ended = true;
        break;
      }
      this.#received += next.value.byteLength;
      if (this.#received > this.#maxSize) {
        throw new Error(`packfile exceeds the ${this.#maxSize}-byte limit`);
      }
      if (this.#end + next.value.byteLength > this.#window.byteLength) {
        // Out of room. What has been consumed goes to the hash and is dropped; the rest moves
        // to a window that doubles while this fill keeps reading, and stops at what it asked for.
        await this.#hash?.write(this.#window.subarray(0, this.#pos));
        let unread = this.#window.subarray(this.#pos, this.#end);
        let window = new Uint8Array(
            Math.min(2 * (unread.byteLength + next.value.byteLength), n + PACK_READ_SIZE));
        window.set(unread);
        this.#window = window;
        this.#end = unread.byteLength;
        this.#pos = 0;
      }
      this.#window.set(next.value, this.#end);
      this.#end += next.value.byteLength;
    }
    return this.#end - this.#pos;
  }
}

/**
 * Applies a git delta (the inflated payload of an ofs-/ref-delta pack entry) to its base,
 * producing the target object payload. Sizes and every copy range are validated; the result is
 * capped at `maxSize` before it is allocated.
 */
export function applyGitDelta(delta: Uint8Array, base: Uint8Array, maxSize: number): Uint8Array {
  let pos = 0;
  let readVarint = (): number => {
    let value = 0;
    let factor = 1;
    let byte: number;
    do {
      if (pos >= delta.byteLength) throw new Error("invalid delta: truncated size");
      byte = delta[pos++];
      value += (byte & 0x7f) * factor;
      factor *= 128;
    } while (byte & 0x80);
    return value;
  };

  let baseSize = readVarint();
  if (baseSize !== base.byteLength) throw new Error("invalid delta: base size mismatch");
  let targetSize = readVarint();
  if (targetSize > maxSize) {
    throw new Error(`invalid delta: result of ${targetSize} bytes exceeds the ${maxSize}-byte limit`);
  }

  let target = new Uint8Array(targetSize);
  let written = 0;
  while (pos < delta.byteLength) {
    let op = delta[pos++];
    if (op & 0x80) {
      // Copy from base: bits 0-3 select offset bytes, bits 4-6 select size bytes.
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i++) {
        if (op & (1 << i)) {
          if (pos >= delta.byteLength) throw new Error("invalid delta: truncated copy op");
          offset += delta[pos++] * 2 ** (8 * i);
        }
      }
      for (let i = 0; i < 3; i++) {
        if (op & (0x10 << i)) {
          if (pos >= delta.byteLength) throw new Error("invalid delta: truncated copy op");
          size += delta[pos++] * 2 ** (8 * i);
        }
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.byteLength || written + size > targetSize) {
        throw new Error("invalid delta: copy out of range");
      }
      target.set(base.subarray(offset, offset + size), written);
      written += size;
    } else if (op > 0) {
      // Insert literal bytes.
      if (pos + op > delta.byteLength || written + op > targetSize) {
        throw new Error("invalid delta: insert out of range");
      }
      target.set(delta.subarray(pos, pos + op), written);
      pos += op;
      written += op;
    } else {
      throw new Error("invalid delta: reserved zero op");
    }
  }
  if (written !== targetSize) throw new Error("invalid delta: result size mismatch");
  return target;
}
