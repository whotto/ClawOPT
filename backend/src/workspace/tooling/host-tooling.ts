import { ensureManagedLocalAudioRuntimeReady } from './audio-transcription';
import { ensureManagedDocumentToolingReady } from './document-tooling';

export function warmManagedHostToolingInBackground() {
  void ensureManagedLocalAudioRuntimeReady().catch((error) => {
    console.error('Failed to prepare managed local audio transcription runtime:', error);
  });
  void ensureManagedDocumentToolingReady().catch((error) => {
    console.error('Failed to prepare managed document tooling runtime:', error);
  });
}
