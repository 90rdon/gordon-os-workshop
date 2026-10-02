// The default build compiles wasm at runtime, which Workers forbid. The `/js` build exports only
// `parse`; its types also declare `init`, which would fail when the module links.
import { parse, type ImportSpecifier } from "es-module-lexer/js";
import type { UiBundle, UiDiagnostic } from "@gadgets/workshop-shared/api";
import { MAX_FILE_TEXT_LENGTH } from "@gadgets/workshop-shared/code-change";
import { uiModuleKey } from "@gadgets/workshop-shared/ui-page";

/**
 * The most code a UI may ship, summed over its modules in UTF-16 units. The whole UI travels in
 * one RPC message and one `srcdoc`.
 */
export const MAX_UI_LENGTH = 8 * MAX_FILE_TEXT_LENGTH;

// A path with one of these can't be written safely into a quoted specifier, or V8 ignores the
// `sourceURL` naming it (whitespace).
const UNSAFE_PATH = /["'`\\\s\p{Cc}]/u;

/**
 * Collects the UI modules `client.js` reaches through relative static imports and string-literal
 * `import()`, rewriting each such specifier to the module's `uiModuleKey`, and reports imports
 * that break the UI import rules as diagnostics. Anyone who can use the gadget receives the
 * bundle, so nothing `client.js` doesn't reach is included. A pure function of the gadget's file
 * tree. Returns null when there's no `client.js`.
 */
export function buildUiBundle(files: ReadonlyMap<string, string>): UiBundle | null {
  if (!files.has("client.js")) return null;
  let diagnostics: UiDiagnostic[] = [];
  let shipped = new Map<string, string>();
  // Iterating a Set visits values added during the loop, so this is also the walk's queue.
  let reached = new Set(["client.js"]);
  for (let path of reached) {
    let code = files.get(path)!;
    let position = positionsIn(code);
    let messageAt = (offset: number, problem: string) =>
        `${path}:${position(offset).line}: ${problem}`;
    let report = (severity: UiDiagnostic["severity"], offset: number, problem: string) => {
      let message = messageAt(offset, problem);
      diagnostics.push({severity, path, ...position(offset), message});
    };

    let imports: readonly ImportSpecifier[] = [];
    try {
      [imports] = parse(code);
    } catch (err) {
      // Shipped as written, so the browser reports the real SyntaxError at the right place.
      let offset = err instanceof Error && "idx" in err && typeof err.idx === "number" ? err.idx : 0;
      report("warning", offset,
          "this file couldn't be scanned for imports, so none of them are bundled. " +
          "The browser reports the syntax error when the UI loads.");
    }

    let rewritten = "";
    let copied = 0;
    let replace = (s: number, e: number, text: string) => {
      rewritten += code.slice(copied, s) + text;
      copied = e;
    };
    // `s`/`e` cover a static import's specifier without its quotes, and a dynamic one's with them.
    for (let {n: spec, s, e, d} of imports) {
      if (d === -2) continue;  // import.meta
      let dynamic = d >= 0;
      if (spec === undefined) {
        let expression = code.slice(s, e);
        if (/^["'`]\.\.?\//.test(expression)) {
          report("warning", s, `import(${expression}) has a computed specifier, so it isn't ` +
              `bundled and fails when it runs. Import each file with a string literal, like ` +
              `import("./pages/home.js").`);
        }
        continue;
      }
      let quoted = JSON.stringify(spec);
      if (spec.startsWith(uiModuleKey(""))) {
        report("fatal", s, `${quoted} can't be imported: import the gadget's own files by ` +
            `relative path, like "./ui/list.js".`);
        continue;
      }
      if (spec.startsWith("data:")) continue;
      if (!spec.startsWith("./") && !spec.startsWith("../")) {
        // A dynamic one is left for the browser to reject when it runs.
        if (!dynamic) {
          report("fatal", s, `${quoted} can't be imported: UI code can import only the ` +
              `gadget's own .js files, by relative path like "./ui/list.js", and data: URLs. ` +
              `gadget, RpcTarget and RpcStub are globals in every UI module; don't import them.`);
        }
        continue;
      }

      let resolved = resolve(path, spec);
      let problem: string;
      if (resolved === null) {
        problem = `${quoted} points outside the gadget's files.`;
      } else if (UNSAFE_PATH.test(resolved)) {
        report("fatal", s, `${quoted} resolves to ${JSON.stringify(resolved)}; an imported ` +
            `path can't contain quotes, backslashes, whitespace or control characters.`);
        continue;
      } else if (!resolved.endsWith(".js")) {
        problem = `${quoted} resolves to ${resolved}, which can't be imported: only .js files can.`;
      } else if (resolved === "server.js") {
        problem = `${quoted} resolves to server.js, which runs only on the server and can't be ` +
            `imported by UI code.`;
      } else if (!files.has(resolved)) {
        problem = `${quoted} resolves to ${resolved}, which doesn't exist.`;
      } else {
        let key = uiModuleKey(resolved);
        replace(s, e, dynamic ? JSON.stringify(key) : key);
        reached.add(resolved);
        continue;
      }

      if (dynamic) {
        // The import() may never run, so rather than failing the UI it rejects with the message
        // when it does. No file content ships.
        let thrower = `throw new Error(${JSON.stringify(messageAt(s, problem))});`;
        replace(s, e, JSON.stringify(`data:text/javascript,${encodeURIComponent(thrower)}`));
      } else {
        report("fatal", s, problem);
      }
    }
    shipped.set(path, rewritten + code.slice(copied));
  }

  let size = 0;
  for (let code of shipped.values()) size += code.length;
  if (size > MAX_UI_LENGTH) {
    diagnostics.push({severity: "fatal", path: "client.js", line: 1, column: 1,
        message: `The UI's modules total ${size} characters, over the limit of ${MAX_UI_LENGTH}.`});
  }

  let fatal = diagnostics.find(diagnostic => diagnostic.severity === "fatal");
  if (fatal) return {jsCode: `throw new Error(${JSON.stringify(fatal.message)});`, diagnostics};
  let bundle: UiBundle = {jsCode: shipped.get("client.js")!};
  let modules = [...shipped].slice(1).map(([path, code]) => ({path, code}));
  if (modules.length > 0) bundle.modules = modules;
  if (diagnostics.length > 0) bundle.diagnostics = diagnostics;
  return bundle;
}

// Resolves a `./` or `../` specifier against the importing file's directory, or returns null if
// it leaves the gadget root. Not `new URL()`, which clamps `..` at the root and percent-encodes.
function resolve(importer: string, spec: string): string | null {
  let segments = importer.split("/").slice(0, -1);
  for (let segment of spec.split("/")) {
    if (segment === "..") {
      if (segments.pop() === undefined) return null;
    } else if (segment !== ".") {
      segments.push(segment);
    }
  }
  return segments.join("/");
}

// Offsets must not decrease, as the lexer reports imports in source order.
function positionsIn(code: string): (offset: number) => {line: number, column: number} {
  let line = 1;
  let lineStart = 0;
  let next = code.indexOf("\n");
  return offset => {
    while (next >= 0 && next < offset) {
      line++;
      lineStart = next + 1;
      next = code.indexOf("\n", lineStart);
    }
    return {line, column: offset - lineStart + 1};
  };
}
