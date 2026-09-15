/**
 * 预览请求的序号守卫：新请求开始即中止上一个，并让上一个的所有回调失效。
 * 慢的旧请求（大文件、转换中的 PDF）晚到时不得覆盖新文件的预览——关闭预览或换文件时同样作废。
 */
export type PreviewRequest = {
  readonly sequence: number;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
};

export function createPreviewRequestGuard() {
  let sequence = 0;
  let controller: AbortController | null = null;
  return {
    begin(): PreviewRequest {
      controller?.abort();
      const own = new AbortController();
      controller = own;
      sequence += 1;
      const mine = sequence;
      return {
        sequence: mine,
        signal: own.signal,
        isCurrent: () => mine === sequence && !own.signal.aborted,
      };
    },
    cancel(): void {
      controller?.abort();
      controller = null;
      sequence += 1;
    },
  };
}
