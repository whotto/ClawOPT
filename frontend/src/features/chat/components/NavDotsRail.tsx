// 左侧用户消息导航点。
import type { ChatController } from '../hooks/useChatController';

type NavDotsRailProps = Pick<
  ChatController,
  'navDots' | 'hoveredDot' | 'setHoveredDot' | 'activeNavDot' | 'scrollToUserMsg'
> & { showMessageListSkeleton: boolean };

export function NavDotsRail(c: NavDotsRailProps) {
  const {
    navDots, hoveredDot, setHoveredDot, activeNavDot, scrollToUserMsg, showMessageListSkeleton,
  } = c;
  return (
    <>
      {!showMessageListSkeleton && navDots.length > 0 && (
        <div className="hidden md:block absolute inset-y-0 left-0 w-0 z-[60] pointer-events-none">
          <div className="relative h-full">
            {navDots.map((dot) => (
              <div key={dot.id} className="absolute left-0 -translate-x-1/2 z-10" style={{ top: `${Math.max(2, Math.min(98, dot.top))}%` }} onMouseEnter={() => setHoveredDot(dot.id)} onMouseLeave={() => setHoveredDot(null)}>
                <button
                  onClick={() => scrollToUserMsg(dot.id)}
                  className={`pointer-events-auto rounded-full transition-all duration-200 hover:scale-150 relative ${activeNavDot === dot.id ? 'w-3 h-3 bg-blue-500' : 'w-2.5 h-2.5 bg-gray-400 hover:bg-blue-400'}`}
                />
                {hoveredDot === dot.id && (
                  <div className="absolute left-full ml-3 top-1/2 -translate-y-1/2 w-max max-w-[280px] px-3 py-2 bg-gray-800 text-white text-[12px] rounded-lg leading-relaxed pointer-events-none animate-in fade-in duration-150 z-50">
                    <div className="min-w-[120px] max-w-[280px] space-y-0.5">
                      <div className="truncate text-white">{dot.summary.primary}</div>
                      {dot.summary.secondary && (
                        <div className="truncate text-gray-200">{dot.summary.secondary}</div>
                      )}
                    </div>
                    <div className="absolute top-1/2 -translate-y-1/2 left-[-4px] w-0 h-0 border-t-4 border-b-4 border-r-4 border-t-transparent border-b-transparent border-r-gray-800" />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
