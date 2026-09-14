// 首屏与向前翻页时的骨架屏。
export function MessageListSkeleton() {
  const items = [
    { align: 'left', lines: ['w-32', 'w-[22rem]', 'w-[16rem]'], showAvatar: true },
    { align: 'right', lines: ['w-[18rem]', 'w-[12rem]'], showAvatar: false },
    { align: 'left', lines: ['w-24', 'w-[20rem]', 'w-[14rem]'], showAvatar: true },
    { align: 'right', lines: ['w-[16rem]', 'w-[10rem]'], showAvatar: false },
  ] as const;

  return (
    <div className="space-y-6 animate-pulse" aria-hidden="true">
      <div className="flex justify-center mb-8">
        <div className="h-7 w-36 rounded-full border border-gray-200 bg-[#f5f6f7]" />
      </div>
      {items.map((item, index) => (
        <div key={index} className={`flex w-full ${item.align === 'right' ? 'justify-end' : 'justify-start'}`}>
          <div className={`flex max-w-[min(42rem,88%)] items-start gap-3 ${item.align === 'right' ? 'flex-row-reverse' : ''}`}>
            {item.showAvatar && <div className="mt-1 h-9 w-9 rounded-full border border-gray-200 bg-[#f1f3f4] flex-shrink-0" />}
            <div className={`rounded-3xl border border-gray-200 bg-[#fafafa] px-4 py-3 ${item.align === 'right' ? 'min-w-[14rem] bg-[#f8f9fb]' : 'min-w-[16rem]'}`}>
              <div className="space-y-2.5">
                {item.lines.map((widthClass, lineIndex) => (
                  <div key={lineIndex} className={`h-3 rounded-full bg-gray-200/90 ${widthClass}`} />
                ))}
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function HistoryLoadMoreSkeleton() {
  return (
    <div className="flex justify-center pt-1 pb-2 animate-pulse" aria-hidden="true">
      <div className="w-full max-w-2xl rounded-2xl border border-gray-200 bg-[#fafafa] px-4 py-3">
        <div className="mx-auto mb-3 h-3 w-28 rounded-full bg-gray-200/90" />
        <div className="space-y-2">
          <div className="h-2.5 w-full rounded-full bg-gray-200/80" />
          <div className="h-2.5 w-4/5 rounded-full bg-gray-100" />
        </div>
      </div>
    </div>
  );
}
