import { isLatestModelAlias, type AiChatAuthorInfo } from "@gadgets/workshop-shared/api";

const LAST_SELECTED_MODEL_KEY = "lastSelectedModel";

/** Sentinel used for UI values and localStorage so an explicit null choice can persist. */
export const NO_AGENT_OPTION_VALUE = "__gadgets_no_agent__";

export function getStoredSelectedModel(
  models: AiChatAuthorInfo[],
): string | null {
  const storedModel = localStorage.getItem(LAST_SELECTED_MODEL_KEY);

  if (storedModel === NO_AGENT_OPTION_VALUE) {
    return null;
  }

  if (storedModel && models.some((model) => model.id === storedModel)) {
    return storedModel;
  }

  // Default: Return the first configured model, or null if none are configured.
  return models[0]?.id ?? null;
}

export function persistSelectedModel(modelId: string | null): void {
  localStorage.setItem(
    LAST_SELECTED_MODEL_KEY,
    modelId ?? NO_AGENT_OPTION_VALUE,
  );
}

export function toModelSelectValue(modelId: string | null): string {
  return modelId ?? NO_AGENT_OPTION_VALUE;
}

export function fromModelSelectValue(value: string): string | null {
  return value === NO_AGENT_OPTION_VALUE ? null : value;
}

/** Heading over the "Latest" aliases, which pickers list before the models they follow. */
export const LATEST_MODELS_HEADING = "Follows updates";

/** Splits a model list into its "Latest" aliases and its concrete models, keeping list order. */
export function partitionLatestModels(models: readonly AiChatAuthorInfo[]): {
  latest: AiChatAuthorInfo[];
  fixed: AiChatAuthorInfo[];
} {
  return {
    latest: models.filter((model) => isLatestModelAlias(model.id)),
    fixed: models.filter((model) => !isLatestModelAlias(model.id)),
  };
}
