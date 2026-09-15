type TextSnapshotProtectionOptions = {
  allowShorterReplacement?: boolean;
};

function normalizeComparableText(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function selectPreferredTextSnapshot(
  currentText: string | null | undefined,
  candidateText: string | null | undefined,
  options?: TextSnapshotProtectionOptions,
): string {
  const current = typeof currentText === 'string' ? currentText : '';
  const candidate = typeof candidateText === 'string' ? candidateText : '';
  const normalizedCurrent = normalizeComparableText(current);
  const normalizedCandidate = normalizeComparableText(candidate);

  if (!normalizedCandidate) {
    return current;
  }

  if (!normalizedCurrent) {
    return candidate;
  }

  if (candidate === current) {
    return candidate;
  }

  if (normalizedCandidate === normalizedCurrent) {
    return candidate.length >= current.length ? candidate : current;
  }

  if (normalizedCandidate.startsWith(normalizedCurrent)) {
    return candidate;
  }

  if (normalizedCurrent.startsWith(normalizedCandidate)) {
    return options?.allowShorterReplacement ? candidate : current;
  }

  if (normalizedCandidate.length > normalizedCurrent.length) {
    return candidate;
  }

  return options?.allowShorterReplacement ? candidate : current;
}

export function shouldReplaceTextSnapshot(
  currentText: string | null | undefined,
  candidateText: string | null | undefined,
  options?: TextSnapshotProtectionOptions,
): boolean {
  const current = typeof currentText === 'string' ? currentText : '';
  const candidate = typeof candidateText === 'string' ? candidateText : '';
  return selectPreferredTextSnapshot(current, candidate, options) === candidate;
}
