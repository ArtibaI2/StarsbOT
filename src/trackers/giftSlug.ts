/**
 * Helpers for resolving Telegram gift slugs.
 *
 * The on-chain `TokenName` payload is usually identical to the Fragment slug
 * (`plushpepe-1330`), but occasionally it contains a typo (`joyfullbundle-5831`
 * while Fragment serves `joyfulbundle-5831`). The collection name from the
 * contract is a reliable fallback source for the canonical slug.
 */

/** Normalize a human-readable collection name into a Fragment slug. */
export function normalizeGiftSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Build an ordered list of candidate slugs for an on-chain token name.
 * The raw token name is always tried first so well-formed payloads are not
 * penalized by an extra request.
 */
export function giftSlugCandidates(tokenName: string, collectionName?: string): string[] {
  const candidates = new Set<string>();
  const raw = tokenName.trim();
  if (raw) candidates.add(raw);

  const match = raw.match(/^(.*)-(\d+)$/);
  const num = match?.[2];
  if (num && collectionName) {
    const normalized = normalizeGiftSlug(collectionName);
    if (normalized && normalized !== 'telegramgift') {
      candidates.add(`${normalized}-${num}`);
    }
  }

  return [...candidates];
}
