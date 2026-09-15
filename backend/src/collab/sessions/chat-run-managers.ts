import type express from 'express';

export type SplitChatProcessOutputResult = {
  finalContent: string;
  processContent: string;
  processStreaming: boolean;
};

export function isStreamingClientOpen(res: express.Response): boolean {
  return !res.writableEnded && !res.destroyed;
}
