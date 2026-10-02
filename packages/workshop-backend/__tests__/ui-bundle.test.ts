import { describe, it, expect } from "vitest";
import type { UiBundle } from "@gadgets/workshop-shared/api";
import { buildUiBundle, MAX_UI_LENGTH } from "../src/ui-bundle";

function bundle(files: Record<string, string>): UiBundle {
  return buildUiBundle(new Map(Object.entries(files)))!;
}

// The message a rewritten `import()` of a bad path rejects with, read back out of its `data:` URL.
function dynamicImportMessage(code: string): string {
  let url = JSON.parse(code.match(/import\(("data:[^"]*")\)/)![1]!) as string;
  let thrower = decodeURIComponent(url.slice("data:text/javascript,".length));
  return JSON.parse(thrower.match(/^throw new Error\((.*)\);$/)![1]!) as string;
}

describe("buildUiBundle", () => {
  it("ships a single-file UI as it is, and nothing without client.js", () => {
    expect(bundle({"client.js": "gadget.ready();", "server.js": "export class Gadget {}"}))
        .toEqual({jsCode: "gadget.ready();"});
    expect(buildUiBundle(new Map([["server.js", "export class Gadget {}"]]))).toBeNull();
  });

  it("rewrites relative imports and ships only what client.js reaches", () => {
    expect(bundle({
      "client.js": `import { List } from "./ui/list.js";\nlet home = () => import('./pages/home.js');`,
      "ui/list.js": `import { fmt } from "../lib/fmt.js";\nexport * from "../client.js";`,
      "pages/home.js": "export let page = 1;",
      "lib/fmt.js": "export let fmt = String;",
      "server.js": `import { key } from "./lib/secret.js";`,
      "lib/secret.js": "export let key = 'SECRET';",
      "unused.js": "export let unused = 1;",
    })).toEqual({
      jsCode: `import { List } from "gadget:ui/list.js";\n` +
          `let home = () => import("gadget:pages/home.js");`,
      modules: [
        {path: "ui/list.js",
          code: `import { fmt } from "gadget:lib/fmt.js";\nexport * from "gadget:client.js";`},
        {path: "pages/home.js", code: "export let page = 1;"},
        {path: "lib/fmt.js", code: "export let fmt = String;"},
      ],
    });
  });

  it("canonicalizes paths, so two spellings of one file are one module", () => {
    expect(bundle({
      "client.js": `import "./b.js";\nimport "./a/../b.js";`,
      "b.js": "export let state = {};",
    })).toEqual({
      jsCode: `import "gadget:b.js";\nimport "gadget:b.js";`,
      modules: [{path: "b.js", code: "export let state = {};"}],
    });
  });

  it("fails on a static import of a missing file, naming importer, specifier and path", () => {
    let result = bundle({
      "client.js": `import "./ui/list.js";`,
      "ui/list.js": `export let a = 1;\n\nimport { b } from "./parts/../missing.js";`,
    });
    expect(result.modules).toBeUndefined();
    let [diagnostic] = result.diagnostics!;
    expect(diagnostic).toMatchObject({severity: "fatal", path: "ui/list.js", line: 3, column: 20});
    expect(diagnostic!.message).toContain("ui/list.js:3");
    expect(diagnostic!.message).toContain(`"./parts/../missing.js"`);
    expect(diagnostic!.message).toContain("ui/missing.js");
    expect(result.jsCode).toBe(`throw new Error(${JSON.stringify(diagnostic!.message)});`);
  });

  it("makes a string-literal import() of a missing file reject with the same message", () => {
    let result = bundle({"client.js": `button.onclick = () => import("./pages/../gone.js");`});
    expect(result.diagnostics).toBeUndefined();
    let message = dynamicImportMessage(result.jsCode);
    expect(message).toContain("client.js:1");
    expect(message).toContain(`"./pages/../gone.js"`);
    expect(message).toContain("gone.js");
  });

  it("refuses server.js and ships none of it", () => {
    let result = bundle({
      "client.js": `import { Gadget } from "./server.js";\nimport("./server.js");`,
      "server.js": "export class Gadget { secret = 'SECRET'; }",
    });
    expect(result.modules).toBeUndefined();
    expect(result.diagnostics).toMatchObject([{severity: "fatal", path: "client.js", line: 1}]);
    expect(result.diagnostics![0]!.message).toContain("server.js");
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("fails on a bare import, telling the agent the RPC names are globals", () => {
    let result = bundle({"client.js": `import { RpcTarget } from "capnweb";`});
    expect(result.diagnostics).toMatchObject([{severity: "fatal", path: "client.js", line: 1}]);
    let message = result.diagnostics![0]!.message;
    expect(message).toContain("capnweb");
    expect(message).toContain("RpcTarget");
    expect(message).toContain("global");
  });

  it("fails on an internal gadget: key, even in a dynamic import", () => {
    let result = bundle({
      "client.js": `import("gadget:ui/list.js");`,
      "ui/list.js": "export let a = 1;",
    });
    expect(result.modules).toBeUndefined();
    expect(result.diagnostics).toMatchObject([{severity: "fatal", path: "client.js", line: 1}]);
  });

  it("fails on a path with a quote or a space, static or dynamic", () => {
    let result = bundle({
      "client.js": `import "./ui/it's.js";\nimport("./ui/my list.js");`,
      "ui/it's.js": "export let a = 1;",
      "ui/my list.js": "export let b = 1;",
    });
    expect(result.modules).toBeUndefined();
    expect(result.diagnostics).toMatchObject([
      {severity: "fatal", path: "client.js", line: 1},
      {severity: "fatal", path: "client.js", line: 2},
    ]);
  });

  it("fails when the shipped code is over the total cap, naming the limit and the size", () => {
    let big = "//" + "x".repeat(MAX_UI_LENGTH);
    let client = `import "./big.js";`;
    let result = bundle({"client.js": client, "big.js": big});
    expect(result.modules).toBeUndefined();
    expect(result.diagnostics).toMatchObject(
        [{severity: "fatal", path: "client.js", line: 1, column: 1}]);
    let message = result.diagnostics![0]!.message;
    expect(message).toContain(String(MAX_UI_LENGTH));
    expect(message).toContain(String(big.length + `import "gadget:big.js";`.length));
  });

  it("warns about a computed import() of a relative path and leaves it alone", () => {
    let client = "let name = 'home';\nimport(`./pages/${name}.js`);";
    expect(bundle({"client.js": client, "pages/home.js": ""})).toEqual({
      jsCode: client,
      diagnostics: [expect.objectContaining({severity: "warning", path: "client.js", line: 2})],
    });
  });

  it("ships a module it can't scan unchanged and unfollowed, with a warning", () => {
    let view = `import "./other.js";\nlet v = <div>hi</div>;`;
    expect(bundle({
      "client.js": `import "./view.js";`,
      "view.js": view,
      "other.js": "export let a = 1;",
    })).toEqual({
      jsCode: `import "gadget:view.js";`,
      modules: [{path: "view.js", code: view}],
      diagnostics: [expect.objectContaining({severity: "warning", path: "view.js", line: 2})],
    });
  });
});
