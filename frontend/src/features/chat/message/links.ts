
export const EXTERNAL_LINK_CLASS_NAME = 'text-[#1a73e8] no-underline hover:underline decoration-1 underline-offset-2 break-all transition-colors hover:text-[#1557b0]';
const URL_WITH_PROTOCOL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
const URL_WITHOUT_PROTOCOL_PATTERN = /^(localhost|(?:\d{1,3}\.){3}\d{1,3}|(?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?(?:[/?#][^\s]*)?$/i;

export function escapeRegExpForPattern(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeNavigableHref(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return null;

  const candidate = URL_WITH_PROTOCOL_PATTERN.test(trimmed)
    ? trimmed
    : URL_WITHOUT_PROTOCOL_PATTERN.test(trimmed)
      ? `http://${trimmed}`
      : '';

  if (!candidate) return null;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString();
    }
  } catch {}

  return null;
}
