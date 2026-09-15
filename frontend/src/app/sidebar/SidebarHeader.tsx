export default function SidebarHeader({ openclawVersion, appVersion }: { openclawVersion: string; appVersion: string }) {
  return (
    <div className="pt-4 pb-6 px-6">
      <div className="mb-1 flex items-baseline gap-2 whitespace-nowrap leading-none">
        <div className="text-2xl font-black text-gray-900 tracking-tighter leading-tight">ClawOPT</div>
        {appVersion ? (
          <div className="text-[0.8rem] font-medium text-gray-800 leading-none">{appVersion}</div>
        ) : null}
      </div>
      <div className="flex items-baseline gap-2 whitespace-nowrap leading-none">
        <div className="text-[0.9rem] font-medium text-gray-400 leading-tight">Powered by OpenClaw</div>
        {openclawVersion ? (
          <div className="text-[0.8rem] font-medium text-gray-400 leading-none">{openclawVersion}</div>
        ) : null}
      </div>
    </div>
  );
}
