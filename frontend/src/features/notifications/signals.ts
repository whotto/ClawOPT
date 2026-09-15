// 提醒的副作用：提示音（WebAudio 现合成，不带音频文件）与系统通知（Notification API）。

type AudioContextCtor = typeof AudioContext;

let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext);
  if (!Ctor) return null;
  try {
    audioContext ??= new Ctor();
    return audioContext;
  } catch {
    return null;
  }
}

/** 完成：两个上行音；审批：同一个音连响两下（更像「请注意」）。浏览器没有用户手势时 resume 会失败，静默放弃。 */
export function playNotificationTone(kind: 'completion' | 'approval'): void {
  const context = getAudioContext();
  if (!context) return;
  const notes = kind === 'completion' ? [660, 880] : [740, 740];
  const start = () => {
    const now = context.currentTime;
    notes.forEach((frequency, index) => {
      const at = now + index * 0.16;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, at);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.18, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.14);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.15);
    });
  };
  if (context.state === 'suspended') {
    context.resume().then(start, () => {});
  } else {
    start();
  }
}

export type OsPermission = 'granted' | 'denied' | 'default' | 'unsupported';

export function osNotificationPermission(): OsPermission {
  if (typeof window === 'undefined' || typeof window.Notification === 'undefined') return 'unsupported';
  return window.Notification.permission as OsPermission;
}

/** 只从用户手势里调用（设置页按钮）。 */
export async function requestOsNotificationPermission(): Promise<OsPermission> {
  if (osNotificationPermission() === 'unsupported') return 'unsupported';
  try {
    return (await window.Notification.requestPermission()) as OsPermission;
  } catch {
    return osNotificationPermission();
  }
}

export function showOsNotification(input: { title: string; body: string; tag: string; onClick?: () => void }): boolean {
  if (osNotificationPermission() !== 'granted') return false;
  try {
    const notification = new window.Notification(input.title, { body: input.body, tag: input.tag });
    notification.onclick = () => {
      try { window.focus(); } catch {}
      input.onClick?.();
      notification.close();
    };
    return true;
  } catch {
    return false;
  }
}
