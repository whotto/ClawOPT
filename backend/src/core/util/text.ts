export function normalizeCliText(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

export function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
