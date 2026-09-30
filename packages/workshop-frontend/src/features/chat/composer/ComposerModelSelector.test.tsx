// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import { ComposerModelSelector } from "./ComposerModelSelector";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const models: AiChatAuthorInfo[] = [
  { type: "agent", id: "claude-opus-5-5", name: "Claude Opus 5.5" },
];

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function renderTriggerLabel(selectedModel: string | null, selectedModelName?: string): string {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(
    <ComposerModelSelector
      models={models}
      selectedModel={selectedModel}
      selectedModelName={selectedModelName}
      onModelChange={() => {}}
    />,
  ));
  return container.querySelector('[aria-label="Select model"]')!.textContent!;
}

describe("ComposerModelSelector", () => {
  it("labels an offered model by its listed name", () => {
    expect(renderTriggerLabel("claude-opus-5-5", "Stale name")).toBe("Claude Opus 5.5");
  });

  // An existing chat can still be on a model the picker has since hidden.
  it("labels a model the list doesn't offer by the chat's own name for it", () => {
    expect(renderTriggerLabel("claude-opus-5", "Claude Opus 5")).toBe("Claude Opus 5");
  });

  it("falls back to the raw id when no name is known", () => {
    expect(renderTriggerLabel("claude-opus-5")).toBe("claude-opus-5");
  });
});
