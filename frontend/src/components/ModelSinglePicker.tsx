import { useState } from 'react';

type ModelOption = {
  id: string;
  alias?: string;
  primary?: boolean;
  input?: string[];
};

type ModelSinglePickerProps = {
  availableModels: ModelOption[];
  selectedModelId: string;
  onSelectedModelIdChange: (id: string) => void;
  placeholder: string;
  emptyText: string;
  allModelsTabLabel: string;
  defaultBadgeLabel: string;
  visionBadgeLabel?: string;
  imageGenerationBadgeLabel?: string;
  disabled?: boolean;
  className?: string;
};

function getModelDisplayName(model?: ModelOption | null): string {
  if (!model) return '';
  return model.alias?.trim() || model.id;
}

function modelSupportsCapability(model: ModelOption, capability: string): boolean {
  return (model.input || []).some((item) => item.toLowerCase().replace(/[-\s]+/g, '_') === capability);
}

export default function ModelSinglePicker({
  availableModels,
  selectedModelId,
  onSelectedModelIdChange,
  placeholder,
  emptyText,
  allModelsTabLabel,
  defaultBadgeLabel,
  visionBadgeLabel = '',
  imageGenerationBadgeLabel = '',
  disabled = false,
  className = '',
}: ModelSinglePickerProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [providerTab, setProviderTab] = useState('all');
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);

  const selectedModel = availableModels.find((model) => model.id === selectedModelId) || null;
  const providerTabs = [
    'all',
    ...Array.from(new Set(
      availableModels
        .map((model) => model.id.split('/')[0]?.trim())
        .filter((provider): provider is string => Boolean(provider)),
    )),
  ];

  const filteredModels = availableModels.filter((model) => {
    if (providerTab !== 'all' && model.id.split('/')[0] !== providerTab) return false;
    if (!searchQuery.trim()) return true;

    const keyword = searchQuery.trim().toLowerCase();
    return model.id.toLowerCase().includes(keyword) || (model.alias || '').toLowerCase().includes(keyword);
  });

  const closeDropdown = () => {
    setIsDropdownOpen(false);
    setSearchQuery('');
  };

  return (
    <div className={`relative w-full min-w-0 max-w-full ${className}`}>
      <input
        type="text"
        value={isDropdownOpen ? searchQuery : getModelDisplayName(selectedModel)}
        onChange={(event) => {
          setSearchQuery(event.target.value);
          if (!isDropdownOpen) {
            setIsDropdownOpen(true);
          }
        }}
        onFocus={() => {
          if (disabled) return;
          setSearchQuery('');
          setIsDropdownOpen(true);
        }}
        placeholder={placeholder}
        disabled={disabled}
        className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-[15px] text-gray-900 placeholder:text-gray-400 outline-none transition-all focus:border-blue-500 focus:bg-white focus:ring-2 focus:ring-blue-500/20 disabled:cursor-not-allowed disabled:text-gray-400"
      />

      {isDropdownOpen && !disabled ? (
        <>
          <div className="fixed inset-0 z-[10]" onClick={closeDropdown} />
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
              {filteredModels.length > 0 ? (
                filteredModels.map((model) => (
                  <button
                    key={model.id}
                    type="button"
                    onClick={() => {
                      onSelectedModelIdChange(model.id);
                      closeDropdown();
                    }}
                    className={`flex w-full items-center justify-between gap-2 px-4 py-2 text-left text-sm transition-colors hover:bg-blue-50 ${
                      selectedModelId === model.id ? 'bg-blue-50 text-blue-600' : 'text-gray-700'
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {getModelDisplayName(model)}
                    </span>
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
                ))
              ) : (
                <div className="flex min-h-24 items-center justify-center px-3 py-6 text-center text-sm text-gray-400">
                  {emptyText}
                </div>
              )}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
