export type GroupIdValidationKey =
  | 'groups.idRequired'
  | 'groups.idContainsWhitespace'
  | 'groups.idInvalid'
  | 'groups.idAlreadyExists';

const GROUP_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function getGroupIdValidationKey(
  rawValue: string,
  existingIds: string[],
  options: {
    currentId?: string | null;
    requireValue?: boolean;
  } = {}
): GroupIdValidationKey | null {
  const normalizedValue = rawValue.trim();
  const requireValue = options.requireValue !== false;

  if (!normalizedValue) {
    return requireValue ? 'groups.idRequired' : null;
  }

  if (/\s/.test(rawValue)) {
    return 'groups.idContainsWhitespace';
  }

  if (
    normalizedValue === '.'
    || normalizedValue === '..'
    || normalizedValue.includes('/')
    || normalizedValue.includes('\\')
    || !GROUP_ID_PATTERN.test(normalizedValue)
  ) {
    return 'groups.idInvalid';
  }

  if (existingIds.includes(normalizedValue) && normalizedValue !== (options.currentId || '')) {
    return 'groups.idAlreadyExists';
  }

  return null;
}
