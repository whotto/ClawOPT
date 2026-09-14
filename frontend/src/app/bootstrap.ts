// 壳层轮询共用的常量。

export const BOOTSTRAP_REQUEST_TIMEOUT_MS = 8000;

// 鉴权探测原来每 3 秒一次：一个标签页一天 2.9 万次请求，跨境链路上每次 300ms 起。
// 改口令后要立刻登出的诉求，30 秒加「切回标签页时立即探测」就够了。
export const AUTH_CHECK_POLL_MS = 30000;
export const MODELS_POLL_MS = 30000;

export const isPageVisible = () => document.visibilityState !== 'hidden';
