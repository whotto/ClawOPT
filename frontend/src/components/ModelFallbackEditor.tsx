import { useState } from 'react';
import { Reorder } from 'motion/react';
import { GripVertical, Search, X } from 'lucide-react';

type ModelOption = {
  id: string;
  alias?: string;
  primary?: boolean;
  input?: string[];
};

export type ModelFallbackMode = 'inherit' | 'custom' | 'disabled';

type ModelFallbackEditorProps = {
  availableModels: ModelOption[];
  mode: ModelFallbackMode;
  onModeChange: (mode: ModelFallbackMode) => void;
  selectedModelIds: string[];
  onSelectedModelIdsChange: (ids: string[]) => void;
  allowInherit?: boolean;
  excludedModelIds?: string[];
  title: string;
  description?: string;
  inheritLabel?: string;
  inheritHint?: string;
  customLabel: string;
  customHint?: string;
  disabledLabel: string;
  disabledHint: string;
  searchPlaceholder: string;
  availableTitle: string;
  selectedTitle: string;
  emptyAvailableText: string;
  emptySelectedText: string;
  defaultBadgeLabel: string;
  allModelsTabLabel?: string;
  visionBadgeLabel?: string;
  imageGenerationBadgeLabel?: string;
  selectionUiVariant?: 'grid' | 'model-picker';
  hideModeSelector?: boolean;
  className?: string;
};

function renderModelLabel(model: ModelOption) {
  if (model.alias && model.alias.trim() && model.alias.trim() !== model.id) {
    return {
      primary: model.alias.trim(),
      secondary: model.id,
    };
  }

  return {
    primary: model.id,
    secondary: '',
  };
}

function modelSupportsCapability(model: ModelOption, capability: string): boolean {
  return (model.input || []).some((item) => item.toLowerCase().replace(/[-\s]+/g, '_') === capability);
}

export default function ModelFallbackEditor({
  availableModels,
  mode,
  onModeChange,
  selectedModelIds,
  onSelectedModelIdsChange,
  allowInherit = false,
  excludedModelIds = [],
  title,
  description,
  inheritLabel = '',
  inheritHint = '',
  customLabel,
  customHint = '',
  disabledLabel,
  disabledHint,
  searchPlaceholder,
  availableTitle,
  selectedTitle,
  emptyAvailableText,
  emptySelectedText,
  defaultBadgeLabel,
  allModelsTabLabel = '',
  visionBadgeLabel = '',
  imageGenerationBadgeLabel = '',
  selectionUiVariant = 'grid',
  hideModeSelector = false,
  className = '',
}: ModelFallbackEditorProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [providerTab, setProviderTab] = useState('all');
  const [isPickerDropdownOpen, setIsPickerDropdownOpen] = useState(false);

  const selectedSet = new Set(selectedModelIds);
  const excludedSet = new Set(excludedModelIds.filter(Boolean));
  const providerTabs = [
    'all',
    ...Array.from(new Set(
      availableModels
        .map((model) => model.id.split('/')[0]?.trim())
        .filter((provider): provider is string => Boolean(provider)),
    )),
  ];
  const filteredAvailableModels = availableModels.filter((model) => {
    if (selectedSet.has(model.id) || excludedSet.has(model.id)) return false;
    if (providerTab !== 'all' && model.id.split('/')[0] !== providerTab) return false;
    if (!searchQuery.trim()) return true;

    const keyword = searchQuery.trim().toLowerCase();
    return model.id.toLowerCase().includes(keyword) || (model.alias || '').toLowerCase().includes(keyword);
  });

  const selectedModels = selectedModelIds
    .map((modelId) => availableModels.find((model) => model.id === modelId))
    .filter((model): model is ModelOption => Boolean(model));

  const showEditor = mode === 'custom';
  const useModelPickerStyle = selectionUiVariant === 'model-picker';
  const closePickerDropdown = () => {
    setIsPickerDropdownOpen(false);
    setSearchQuery('');
  };

  const renderAvailableModels = () => {
    if (useModelPickerStyle) {
      return (
        <div className="min-w-0 max-w-full space-y-3">
          <div className="relative">
            <div className="relative">
              <input
                type="text"
                value={isPickerDropdownOpen ? searchQuery : ''}
                onChange={(event) => {
                  setSearchQuery(event.target.value);
                  if (!isPickerDropdownOpen) {
                    setIsPickerDropdownOpen(true);
                  }
                }}
                onFocus={() => {
                  setSearchQuery('');
                  setIsPickerDropdownOpen(true);
                }}
                placeholder={searchPlaceholder}
                className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 pr-10 text-[15px] text-gray-900 placeholder:text-gray-400 outline-none transition-all focus:border-blue-500 focus:bg-white focus:ring-2 focus:ring-blue-500/20"
              />
              {isPickerDropdownOpen && searchQuery ? (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-gray-400 transition-all hover:bg-gray-100 hover:text-gray-600"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>

            {isPickerDropdownOpen ? (
              <>
                <div className="fixed inset-0 z-[10]" onClick={closePickerDropdown} />
                <div className="absolute left-0 right-0 top-full z-[20] mt-1 max-w-full overflow-hidden rounded-xl border border-gray-200 bg-white">
                  <div className="flex gap-1 overflow-x-auto border-b border-gray-100 px-2 pt-2 no-scrollbar">
                    {providerTabs.map((provider) => (
                      <button
                        key={provider}
                        type="button"
                        onClick={() => setProviderTab(provider)}
                        className={`flex-none whitespace-nowrap rounded-t-lg border-b-2 px-3 py-1.5 text-xs font-bold transition-colors ${
                          providerTab === provider
                            ? 'border-blue-600 bg-blue-50/50 text-blue-600'
                            : 'border-transparent text-gray-500 hover:bg-gray-50 hover:text-gray-700'
                        }`}
                      >
                        {provider === 'all' ? allModelsTabLabel : provider}
                      </button>
                    ))}
                  </div>

                  <div className="max-h-56 overflow-y-auto">
                    {filteredAvailableModels.length > 0 ? (
                      filteredAvailableModels.map((model) => {
                        const label = renderModelLabel(model);
                        return (
                          <button
                            key={model.id}
                            type="button"
                            onClick={() => {
                              onSelectedModelIdsChange([...selectedModelIds, model.id]);
                              closePickerDropdown();
                            }}
                            className="flex w-full items-center justify-between gap-2 px-4 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-blue-50"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-medium text-gray-900">{label.primary}</div>
                              {label.secondary ? (
                                <div className="truncate text-xs text-gray-500">{label.secondary}</div>
                              ) : null}
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                              {model.primary ? (
                                <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-600">
                                  {defaultBadgeLabel}
                                </span>
                              ) : null}
                              {visionBadgeLabel && model.input?.includes('image') ? (
                                <span className="rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-600">
                                  {visionBadgeLabel}
                                </span>
                              ) : null}
                              {imageGenerationBadgeLabel && modelSupportsCapability(model, 'image_generation') ? (
                                <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600">
                                  {imageGenerationBadgeLabel}
                                </span>
                              ) : null}
                            </div>
                          </button>
                        );
                      })
                    ) : (
                      <div className="flex min-h-24 items-center justify-center px-3 py-6 text-center text-sm text-gray-400">
                        {emptyAvailableText}
                      </div>
                    )}
                  </div>
                </div>
              </>
            ) : null}
          </div>
        </div>
      );
    }

    return (
      <div className="min-w-0 max-w-full space-y-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          {availableTitle}
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={searchPlaceholder}
            className="w-full rounded-xl border border-gray-200 bg-white py-2.5 pl-9 pr-4 text-sm text-gray-900 outline-none transition-all focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
          />
        </div>
        <div className="max-h-56 space-y-2 overflow-y-auto rounded-xl border border-gray-200 bg-white p-2">
          {filteredAvailableModels.length > 0 ? (
            filteredAvailableModels.map((model) => {
              const label = renderModelLabel(model);
              return (
                <button
                  key={model.id}
                  type="button"
                  onClick={() => onSelectedModelIdsChange([...selectedModelIds, model.id])}
                  className="flex w-full items-center justify-between gap-3 rounded-lg border border-transparent px-3 py-2.5 text-left transition-all hover:border-blue-100 hover:bg-blue-50/70"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-gray-900">{label.primary}</div>
                    {label.secondary ? (
                      <div className="truncate text-xs text-gray-500">{label.secondary}</div>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {model.primary ? (
                      <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold text-blue-700">
                        {defaultBadgeLabel}
                      </span>
                    ) : null}
                    {imageGenerationBadgeLabel && modelSupportsCapability(model, 'image_generation') ? (
                      <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600">
                        {imageGenerationBadgeLabel}
                      </span>
                    ) : null}
                  </div>
                </button>
              );
            })
          ) : (
            <div className="flex min-h-24 items-center justify-center px-3 py-6 text-center text-sm text-gray-400">
              {emptyAvailableText}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className={`min-w-0 max-w-full space-y-3 ${className}`}>
      {title || description ? (
        <div>
          {title ? (
            <div className="text-sm font-semibold text-gray-700">{title}</div>
          ) : null}
          {description ? (
            <div className="mt-1 text-xs text-gray-500 leading-relaxed">{description}</div>
          ) : null}
        </div>
      ) : null}

      {!hideModeSelector ? (
        <div className={`grid gap-2 ${allowInherit ? 'grid-cols-3' : 'grid-cols-2'}`}>
          {allowInherit ? (
            <button
              type="button"
              onClick={() => onModeChange('inherit')}
              className={`rounded-xl border px-3 py-2.5 text-sm transition-all ${
                mode === 'inherit'
                  ? 'border-blue-500 bg-blue-50 text-blue-700 font-semibold'
                  : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:text-gray-900'
              }`}
            >
              {inheritLabel}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => onModeChange('custom')}
            className={`rounded-xl border px-3 py-2.5 text-sm transition-all ${
              mode === 'custom'
                ? 'border-blue-500 bg-blue-50 text-blue-700 font-semibold'
                : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:text-gray-900'
            }`}
          >
            {customLabel}
          </button>
          <button
            type="button"
            onClick={() => onModeChange('disabled')}
            className={`rounded-xl border px-3 py-2.5 text-sm transition-all ${
              mode === 'disabled'
                ? 'border-blue-500 bg-blue-50 text-blue-700 font-semibold'
                : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:text-gray-900'
            }`}
          >
            {disabledLabel}
          </button>
        </div>
      ) : null}

      {mode === 'inherit' && allowInherit && inheritHint ? (
        <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-xs text-gray-500 leading-relaxed">
          {inheritHint}
        </div>
      ) : null}

      {mode === 'disabled' && disabledHint ? (
        <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-xs text-gray-500 leading-relaxed">
          {disabledHint}
        </div>
      ) : null}

      {showEditor ? (
        <div className={`${useModelPickerStyle ? 'min-w-0 max-w-full space-y-6 rounded-2xl border border-gray-200 bg-white p-4 sm:p-6' : 'min-w-0 max-w-full space-y-3 rounded-2xl border border-gray-200 bg-gray-50/60 p-3'}`}>
          {customHint ? (
            <div className={useModelPickerStyle ? 'text-sm text-gray-500 leading-relaxed' : 'text-xs text-gray-500 leading-relaxed'}>{customHint}</div>
          ) : null}

          <div className={`min-w-0 max-w-full grid ${useModelPickerStyle ? 'gap-6' : 'gap-3'} ${useModelPickerStyle ? '' : 'md:grid-cols-2'}`}>
            {useModelPickerStyle ? renderAvailableModels() : null}

            <div className={`${useModelPickerStyle ? 'space-y-3' : 'space-y-2'} min-w-0 max-w-full`}>
              {!useModelPickerStyle ? (
                <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                  {selectedTitle}
                </div>
              ) : null}
              {selectedModels.length > 0 ? (
                <Reorder.Group
                  axis="y"
                  values={selectedModelIds}
                  onReorder={onSelectedModelIdsChange}
                  className="min-w-0 max-w-full space-y-2"
                >
                  {selectedModels.map((model) => {
                    const label = renderModelLabel(model);
                    return (
                      <Reorder.Item key={model.id} value={model.id} className="w-full min-w-0 max-w-full cursor-grab active:cursor-grabbing">
                        <div className={`flex w-full min-w-0 max-w-full items-center gap-3 overflow-hidden rounded-xl border border-gray-200 bg-white cursor-grab transition-colors hover:bg-gray-50/80 active:cursor-grabbing ${useModelPickerStyle ? 'px-3 py-3 sm:px-4' : 'px-3 py-2.5'}`}>
                          <GripVertical className="h-4 w-4 shrink-0 text-gray-300" />
                          <div className="min-w-0 flex-1">
                            {label.secondary ? (
                              <div className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:items-end sm:gap-2">
                                <div className="min-w-0 truncate text-sm font-medium text-gray-900">{label.primary}</div>
                                <div className="min-w-0 truncate text-xs text-gray-500 sm:relative sm:-top-px">{label.secondary}</div>
                              </div>
                            ) : (
                              <div className="min-w-0 truncate text-sm font-medium text-gray-900">{label.primary}</div>
                            )}
                          </div>
                          <button
                            type="button"
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={() => onSelectedModelIdsChange(selectedModelIds.filter((id) => id !== model.id))}
                            className="cursor-pointer rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
                            title={model.id}
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                      </Reorder.Item>
                    );
                  })}
                </Reorder.Group>
              ) : (
                <div className="rounded-xl border border-dashed border-gray-200 bg-white px-4 py-6 text-center text-sm text-gray-400">
                  {emptySelectedText}
                  </div>
                )}
              </div>
            {!useModelPickerStyle ? renderAvailableModels() : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
