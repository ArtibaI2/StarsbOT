export function isGetgemsSale(item: unknown): boolean {
  if (!item || typeof item !== 'object') return false;
  const sale = (item as { sale?: { market?: { name?: unknown } } }).sale;
  const marketName = sale?.market?.name;
  return typeof marketName === 'string' && marketName.toLowerCase().includes('getgems');
}

export function newestFirst<T extends { timestamp: number }>(events: readonly T[]): T[] {
  return [...events].sort((a, b) => b.timestamp - a.timestamp);
}
