// 临时 id → 库里的 id（发送 / 重新生成收到 `ids` 帧时）。纯函数，带单测。
//
// 为什么单独成函数：原来在 setMessages 的更新函数里直接读外层的 `let resolvedId`，而紧接着的同步代码就把它改成了真 id——
// React 稍后才执行更新函数，读到的已经是新值，于是一条也换不掉，消息一直挂着临时 id（真机：工作区改动卡片、工具摘要卡、
// 计划卡都按数字 id 拉数据，刚跑完的那一轮全部不显示，刷新才出来）。调用方必须在调度更新**之前**把旧 id 取成常量传进来。

export type MessageIdSwap = { from: string; to: string; parentId?: string };

export function swapMessageIds<T extends { id: string; parentId?: string }>(messages: T[], swaps: ReadonlyArray<MessageIdSwap>): T[] {
  const byFrom = new Map(swaps.filter((swap) => swap.from && swap.to && swap.from !== swap.to).map((swap) => [swap.from, swap]));
  if (byFrom.size === 0) return messages;
  let changed = false;
  const next = messages.map((message) => {
    const swap = byFrom.get(message.id);
    if (!swap) return message;
    changed = true;
    return swap.parentId === undefined ? { ...message, id: swap.to } : { ...message, id: swap.to, parentId: swap.parentId };
  });
  return changed ? next : messages;
}
