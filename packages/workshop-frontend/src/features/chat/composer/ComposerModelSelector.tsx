import { DropdownMenu } from "@cloudflare/kumo";
import { CaretDown, Check } from "@phosphor-icons/react";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import { LATEST_MODELS_HEADING, partitionLatestModels } from "../../../modelSelection";

const ITEM_CLASS = "!h-auto rounded-xl !px-2 !py-1.5 text-[12px] leading-4 font-normal tracking-[-0.15px] text-kumo-subtle transition-colors data-highlighted:bg-kumo-tint/70 data-highlighted:text-kumo-default";

type ComposerModelSelectorProps = {
  models: readonly AiChatAuthorInfo[];
  selectedModel: string | null;
  /**
   * Shown for `selectedModel` when `models` doesn't offer it, such as a hidden model an existing
   * chat last ran on. The raw model id is shown when this is absent too.
   */
  selectedModelName?: string;
  onModelChange: (modelId: string | null) => void;
};

export const ComposerModelSelector = ({
  models,
  selectedModel,
  selectedModelName,
  onModelChange,
}: ComposerModelSelectorProps) => {
  const selectedModelLabel = selectedModel == null
    ? "No agent"
    : models.find((model) => model.id === selectedModel)?.name ??
      selectedModelName ?? selectedModel;

  const { latest, fixed } = partitionLatestModels(models);
  const renderModel = (model: AiChatAuthorInfo) => (
    <DropdownMenu.Item
      key={model.id}
      onClick={() => onModelChange(model.id)}
      className={ITEM_CLASS}
    >
      <span className="min-w-0 flex-1 truncate">{model.name}</span>
      {selectedModel === model.id && (
        <Check
          size={12}
          weight="bold"
          className="ml-3 flex-shrink-0 text-kumo-inactive"
        />
      )}
    </DropdownMenu.Item>
  );

  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <button
            type="button"
            className="group inline-flex h-10 min-w-0 max-w-[110px] cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[14px] leading-5 text-kumo-subtle transition-[background-color,color,transform] duration-150 ease-out hover:bg-kumo-tint hover:text-kumo-default focus-visible:bg-kumo-tint focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.97] data-[popup-open]:bg-kumo-tint data-[popup-open]:text-kumo-default sm:h-8 sm:max-w-[180px] sm:text-[13px]"
            aria-label="Select model"
          >
            <span className="min-w-0 truncate">{selectedModelLabel}</span>
            <CaretDown
              size={12}
              weight="bold"
              className="flex-shrink-0 text-kumo-inactive transition-transform duration-150 ease-out group-data-[popup-open]:rotate-180"
            />
          </button>
        }
      />
      <DropdownMenu.Content className="themed-floating-shadow-lg !z-[1100] !min-w-[190px] rounded-2xl border border-kumo-line/70 bg-kumo-base p-1">
        {latest.length > 0 && (
          <>
            <DropdownMenu.Group>
              <DropdownMenu.Label className="!px-2 text-[11px] text-kumo-inactive">
                {LATEST_MODELS_HEADING}
              </DropdownMenu.Label>
              {latest.map(renderModel)}
            </DropdownMenu.Group>
            <div className="my-1 border-t border-kumo-line/70" />
          </>
        )}
        {fixed.map(renderModel)}
        <div className="my-1 border-t border-kumo-line/70" />
        <DropdownMenu.Item
          onClick={() => onModelChange(null)}
          className={ITEM_CLASS}
        >
          <span className="min-w-0 flex-1 truncate">No agent</span>
          {selectedModel == null && (
            <Check
              size={12}
              weight="bold"
              className="ml-3 flex-shrink-0 text-kumo-inactive"
            />
          )}
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
};
