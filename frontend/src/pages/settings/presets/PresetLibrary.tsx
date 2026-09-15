import PackExportSection from './PackExportSection';
import PackImportSection from './PackImportSection';
import PresetCatalogSection from './PresetCatalogSection';
import { usePresetLibrary } from './usePresetLibrary';

interface PresetLibraryProps {
  onAgentsChanged?: () => void;
}

export default function PresetLibrary({ onAgentsChanged }: PresetLibraryProps) {
  const ctx = usePresetLibrary(onAgentsChanged);
  const { section, sectionTabs, setSection } = ctx;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2 border-b border-gray-200 pb-3">
        {sectionTabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setSection(tab.id)}
            className={`inline-flex items-center gap-2 px-4 py-2 text-sm rounded-xl border transition-all ${
              section === tab.id
                ? 'font-semibold text-gray-900 bg-amber-50 border-orange-300'
                : 'font-normal text-gray-600 bg-white border-gray-200 hover:bg-gray-50'
            }`}
          >
            <tab.Icon className="w-4 h-4" />
            {tab.label}
          </button>
        ))}
      </div>

      <PresetCatalogSection ctx={ctx} />

      <PackImportSection ctx={ctx} />

      <PackExportSection ctx={ctx} />
    </div>
  );
}
