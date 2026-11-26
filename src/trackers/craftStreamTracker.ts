import https from 'https';
import axios from 'axios';
import { db } from '../storage/database.js';
import { UniqueCraftEvent } from '../types/gift.js';
import { newestFirst } from './marketplace.js';
import { validateProfileGift } from './profileValidator.js';
import { giftSlugCandidates } from './giftSlug.js';
import { tonApi, TonApiRateLimitError } from './tonApiClient.js';
import { nextCraftCursor } from './craftCursor.js';

export type CraftEventCallback = (craft: UniqueCraftEvent) => Promise<void>;

// High-performance HTTPS agent with Keep-Alive to eliminate TLS handshake latency
const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 50,
});

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'ru,en;q=0.9',
};

// The official Fragment Gift Minter contract that processes EVERY Telegram gift upgrade
const FRAGMENT_GIFT_MINTER_ADDRESS = '0:158136239adb15dd59df90c641f9efd312cfeb8664f218f4c3e5fce9d95e6c07';

export class CraftStreamTracker {
  private intervalSec: number;
  private timer: NodeJS.Timeout | null = null;
  private isChecking = false;
  private onCraftCallbacks: CraftEventCallback[] = [];
  private botStartedAtSec = Math.floor(Date.now() / 1000);

  /** Fragment metadata is immutable per slug; cache it to avoid refetching. */
  private metaCache = new Map<string, { at: number; data: any | null }>();
  private static readonly META_TTL_MS = 10 * 60 * 1000;
  private static readonly META_CACHE_LIMIT = 300;

  constructor(intervalSec = 3) {
    this.intervalSec = Math.max(2, intervalSec);
  }

  public onCraft(callback: CraftEventCallback): void {
    this.onCraftCallbacks.push(callback);
  }

  public start(): void {
    if (this.timer) return;
    console.log(`✨ [UpgradeStream] Started monitoring ALL gift upgrades in real-time (every ${this.intervalSec}s)`);
    this.check();
    this.timer = setInterval(() => this.check(), this.intervalSec * 1000);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('🛑 [UpgradeStream] Stopped.');
    }
  }

  public async check(): Promise<void> {
    if (this.isChecking) return;
    this.isChecking = true;

    try {
      db.updateLastCheck('craft');
      await this.pollMinterEvents();
    } catch (err: any) {
      // Rate limits are handled and logged once by the shared TON API gate.
      if (!(err instanceof TonApiRateLimitError)) {
        console.error('⚠️ [UpgradeStream] Polling error:', err?.message || err);
      }
    } finally {
      this.isChecking = false;
    }
  }

  /** TON API caps the event page size at 100. */
  private static readonly EVENT_PAGE_LIMIT = 100;
  /** Extra pages drained per cycle so bursts cannot scroll out of reach. */
  private static readonly EVENT_MAX_PAGES = 3;

  private buildEventsPath(beforeLt?: number): string {
    const params = new URLSearchParams();
    params.set('limit', String(CraftStreamTracker.EVENT_PAGE_LIMIT));
    // `before_lt` walks the feed backwards, so a burst larger than one page is
    // drained page by page instead of letting newer events replace older ones.
    if (beforeLt !== undefined) {
      params.set('before_lt', String(beforeLt));
    }
    return `/accounts/${FRAGMENT_GIFT_MINTER_ADDRESS}/events?${params.toString()}`;
  }

  /**
   * Reads the newest minter events and, when the stored cursor is further back
   * than one page, walks back with `before_lt` until the cursor is reached or
   * EVENT_MAX_PAGES is exhausted. A rate limit stops pagination and keeps the
   * pages already fetched; the cursor only moves once those events are processed.
   */
  private async fetchMinterEvents(cursor?: number): Promise<any[]> {
    let collected: any[] = [];
    let beforeLt: number | undefined;

    for (let page = 0; page < CraftStreamTracker.EVENT_MAX_PAGES; page++) {
      if (tonApi.isCoolingDown()) break;

      let res: any;
      try {
        res = await tonApi.get(this.buildEventsPath(beforeLt));
      } catch (err) {
        if (err instanceof TonApiRateLimitError) break;
        throw err;
      }

      const batch: any[] = Array.isArray(res?.events) ? res.events : [];
      if (batch.length === 0) break;

      batch.sort((a, b) => Number(a?.lt) - Number(b?.lt));
      collected = [...batch, ...collected];

      const oldest = Number(batch[0]?.lt);
      if (!Number.isFinite(oldest)) break;
      if (cursor === undefined) break;
      if (oldest <= cursor) break;
      if (batch.length < CraftStreamTracker.EVENT_PAGE_LIMIT) break;
      beforeLt = oldest;
    }

    return cursor === undefined
      ? collected
      : collected.filter((ev) => Number(ev?.lt) > cursor);
  }

  private advanceCursor(
    previous: number | undefined,
    fetchedLts: number[],
    failedLts: number[]
  ): void {
    const next = nextCraftCursor(previous, fetchedLts, failedLts);
    if (next !== undefined && next !== previous) {
      db.setCraftCursorLt(next);
    }
  }

  /**
   * Polls Fragment Gift Minter contract events for real-time gift upgrades.
   * Strictly filters out events older than 60s and events that happened before bot startup.
   */
  private async pollMinterEvents(): Promise<void> {
    if (tonApi.isCoolingDown()) return;

    const storedCursor = db.getCraftCursorLt();
    const isBaseline = !db.isCraftBaselineSet();
    const events = await this.fetchMinterEvents(storedCursor);
    const fetchedLts = events
      .map((ev) => Number(ev.lt))
      .filter((lt) => Number.isFinite(lt));

    const nowSec = Math.floor(Date.now() / 1000);

    interface UpgradeCandidate {
      craftKey: string;
      tokenName: string;
      collectionName: string;
      senderAddress: string;
      timestamp: number;
      nftItemAddress?: string;
      ageSec: number;
      eventLt: number;
    }

    const candidates: UpgradeCandidate[] = [];

    const maxAgeSec = Math.max(90, this.intervalSec * 4);
    const minTimestampSec = this.botStartedAtSec - 30;

    for (const ev of events) {
      const eventId = ev.event_id;
      if (!eventId) continue;
      if (db.isCraftSeen(eventId)) continue;

      const eventTimestamp = Number(ev.timestamp || 0);
      const ageSec = Math.max(0, nowSec - eventTimestamp);
      const eventLt = Number(ev.lt);

      // 1. LATENCY FILTER: Scale window with poll interval so TON indexing +
      // one retry cycle never drops a valid fresh upgrade.
      if (ageSec > maxAgeSec) {
        db.markCraftSeen(eventId);
        continue;
      }

      // 2. Discard events that took place before bot started (e.g. on container restart)
      if (eventTimestamp < minTimestampSec) {
        db.markCraftSeen(eventId);
        continue;
      }

      // If initial baseline snapshot, do not emit historical items
      if (isBaseline) {
        db.markCraftSeen(eventId);
        continue;
      }

      for (const act of ev.actions || []) {
        if (
          act.type === 'SmartContractExec' &&
          act.SmartContractExec?.operation === 'TelemintDeployV2'
        ) {
          const sc = act.SmartContractExec;
          const payload = sc.payload || '';

          const tokenMatch = payload.match(/TokenName:\s*([^\s\n]+)/);
          const senderMatch = payload.match(/RewriteSenderAddress:\s*([^\s\n]+)/);

          if (!tokenMatch) continue;

          const tokenName = tokenMatch[1].trim();
          const senderAddress = senderMatch ? senderMatch[1].trim() : '';

          // Deduplicate per gift, not per event: an event can carry several
          // actions, and a failed enrichment must stay retryable.
          const craftKey = `${eventId}:${tokenName}`;
          if (db.isCraftSeen(craftKey)) continue;

          let nftItemAddress = '';
          for (const a of ev.actions || []) {
            if (a.type === 'NftItemTransfer' && a.NftItemTransfer?.nft) {
              nftItemAddress = a.NftItemTransfer.nft;
              break;
            }
          }

          candidates.push({
            craftKey,
            tokenName,
            collectionName: sc.contract?.name || 'Telegram Gift',
            senderAddress,
            timestamp: eventTimestamp,
            nftItemAddress,
            ageSec,
            eventLt,
          });
        }
      }
    }

    if (isBaseline) {
      db.setCraftBaseline();
      if (fetchedLts.length > 0) {
        db.setCraftCursorLt(Math.max(...fetchedLts));
      }
      console.log('✅ [UpgradeStream] Baseline snapshot initialized at startup. Streaming fresh real-time upgrades (< 60s)!');
      return;
    }

    if (candidates.length === 0) {
      this.advanceCursor(storedCursor, fetchedLts, []);
      return;
    }

    // A single upgrade can appear as several actions in one event batch; enrich
    // each gift slug only once per cycle.
    const seenSlugs = new Set<string>();
    const uniqueCandidates = newestFirst(candidates).filter((c) => {
      if (seenSlugs.has(c.tokenName)) return false;
      seenSlugs.add(c.tokenName);
      return true;
    });

    // Enrich candidates with bounded concurrency to protect MTProto and Fragment
    // against FLOOD_WAIT / rate limits during upgrade bursts.
    const failedLts: number[] = [];
    const queue = [...uniqueCandidates];
    const workerCount = Math.min(3, queue.length);

    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (queue.length > 0) {
          const c = queue.shift();
          if (!c) break;

          try {
            const upgrade = await this.enrichGiftDetails(
              c.tokenName,
              c.collectionName,
              c.senderAddress,
              c.timestamp,
              c.nftItemAddress,
              c.ageSec
            );

            // Mark only after a definitive result: a transient network failure
            // leaves the event unmarked so the next cycle can retry it while the
            // gift is still fresh.
            db.markCraftSeen(c.craftKey);

            if (upgrade) await this.emitCraft(upgrade);
          } catch (err: any) {
            failedLts.push(c.eventLt);
            console.warn(
              `⚠️ [UpgradeStream] Will retry ${c.tokenName} next cycle:`,
              err?.message || err
            );
          }
        }
      })
    );

    // Move the cursor past everything that was handled; a failure pins it just
    // before that event so it is fetched again instead of being skipped.
    this.advanceCursor(storedCursor, fetchedLts, failedLts);
  }

  /**
   * Fetches Fragment metadata for a slug. Unknown slugs (404) return null without
   * noise so the caller can try the next candidate; transient 5xx / network
   * errors are retried and NEVER cached so the next cycle can still fetch them.
   */
  private async fetchGiftMetadata(slug: string): Promise<any | null> {
    const cached = this.metaCache.get(slug);
    if (cached && Date.now() - cached.at < CraftStreamTracker.META_TTL_MS) {
      return cached.data;
    }

    const url = `https://nft.fragment.com/gift/${slug}.json`;
    let data: any | null = null;
    let shouldCache = false;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await axios.get(url, { headers: DEFAULT_HEADERS, timeout: 5000, httpsAgent });
        data = res.data || {};
        shouldCache = true;
        break;
      } catch (err: any) {
        const status = err?.response?.status;
        if (status === 404) {
          data = null;
          shouldCache = true;
          break;
        }
        const isTransient =
          !status ||
          status >= 500 ||
          err?.message === 'aborted' ||
          err?.code === 'ECONNRESET' ||
          err?.code === 'ECONNABORTED' ||
          err?.code === 'ETIMEDOUT';
        if (isTransient && attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
          continue;
        }
        console.warn(`⚠️ [UpgradeStream] Failed to load metadata for ${slug}:`, err?.message || err);
        data = null;
        break;
      }
    }

    if (shouldCache) {
      this.cacheMetadata(slug, data);
    }
    return data;
  }

  private cacheMetadata(slug: string, data: any | null): void {
    this.metaCache.set(slug, { at: Date.now(), data });

    if (this.metaCache.size > CraftStreamTracker.META_CACHE_LIMIT) {
      const oldest = this.metaCache.keys().next().value;
      if (oldest) this.metaCache.delete(oldest);
    }
  }

  /** Resolves the canonical slug and its metadata from the candidate list. */
  private async resolveGiftMetadata(
    candidates: string[]
  ): Promise<{ slug: string; meta: any }> {
    for (const candidate of candidates) {
      const meta = await this.fetchGiftMetadata(candidate);
      if (meta) return { slug: candidate, meta };
    }
    return { slug: candidates[0], meta: {} };
  }

  /**
   * Fetches metadata, owner and status with parallel queries.
   * Discards gifts that are already sold / unavailable and not active on a user profile.
   */
  private async enrichGiftDetails(
    tokenName: string,
    collectionName: string,
    senderAddress: string,
    timestampSec: number,
    nftItemAddress?: string,
    ageSec?: number
  ): Promise<UniqueCraftEvent | null> {
    try {
      // Metadata lookup and profile validation are independent, so run them in
      // parallel: the common path finishes in one round-trip instead of two.
      // The on-chain payload sometimes carries a typo in the collection slug
      // (e.g. joyfullbundle-5831 while Fragment serves joyfulbundle-5831), so
      // the resolved slug is checked afterwards and validation repeated only
      // when it actually differs.
      const wantsNonProfile = db.hasSubscribersWantingNonProfile();
      const wantsChannels = db.hasSubscribersWantingChannels();
      const checkGetgems = Boolean(wantsNonProfile && db.hasActiveGetgemsFilters());

      const slugCandidates = giftSlugCandidates(tokenName, collectionName);
      const [metaResult, rawResolution] = await Promise.all([
        this.resolveGiftMetadata(slugCandidates),
        validateProfileGift(tokenName, senderAddress, nftItemAddress, httpsAgent, checkGetgems),
      ]);

      const resolvedSlug = metaResult.slug;
      const meta = metaResult.meta;
      const ownerResolution = resolvedSlug === tokenName
        ? rawResolution
        : await validateProfileGift(resolvedSlug, senderAddress, nftItemAddress, httpsAgent, checkGetgems);

      // Default: watch ONLY active gifts displayed on a human user's Telegram profile.
      // Only allow channel or non-profile gifts through if at least one active
      // subscriber explicitly opted into them via /settings.
      if (!ownerResolution.isProfileActive) {
        if (ownerResolution.isChannel) {
          if (!wantsChannels) return null;
        } else if (!wantsNonProfile) {
          return null;
        }
      }

      const attributes = Array.isArray(meta.attributes) ? meta.attributes : [];
      const getAttr = (name: string): { value: string; rarity?: string } => {
        const found = attributes.find(
          (a: any) => (a.trait_type || '').toLowerCase() === name.toLowerCase()
        );
        if (!found) return { value: '' };
        let rarity = found.rarity ? String(found.rarity) : undefined;
        if (!rarity && found.rarity_percentage) {
          rarity = `${found.rarity_percentage}%`;
        }
        return { value: String(found.value || ''), rarity };
      };

      const metaModel = getAttr('Model');
      const metaBackdrop = getAttr('Backdrop');
      const metaSymbol = getAttr('Symbol').value ? getAttr('Symbol') : getAttr('Pattern');

      const modelName = ownerResolution.mtprotoInfo?.modelName || metaModel.value || 'Classic';
      const modelRarity = ownerResolution.mtprotoInfo?.modelRarity || metaModel.rarity;

      const backdropName = ownerResolution.mtprotoInfo?.backdropName || metaBackdrop.value || undefined;
      const backdropRarity = ownerResolution.mtprotoInfo?.backdropRarity || metaBackdrop.rarity;

      const symbolName = ownerResolution.mtprotoInfo?.symbolName || metaSymbol.value || undefined;
      const symbolRarity = ownerResolution.mtprotoInfo?.symbolRarity || metaSymbol.rarity;

      let num = ownerResolution.mtprotoInfo?.num || 0;
      if (!num) {
        const numMatch = (meta.name || resolvedSlug).match(/#?\s*(\d+)$/);
        if (numMatch) {
          num = parseInt(numMatch[1], 10);
        }
      }

      // Calculate Rarity Level based on model rarity percentage
      let rarityLevel: 'Common' | 'Uncommon' | 'Rare' | 'Epic' | 'Legendary' | undefined;
      if (modelRarity) {
        const numRarity = parseFloat(modelRarity.replace('%', ''));
        if (!isNaN(numRarity)) {
          if (numRarity <= 0.5) rarityLevel = 'Legendary';
          else if (numRarity <= 2.0) rarityLevel = 'Epic';
          else if (numRarity <= 6.0) rarityLevel = 'Rare';
          else if (numRarity <= 15.0) rarityLevel = 'Uncommon';
          else rarityLevel = 'Common';
        }
      }

      const ownerTelegramUsername = ownerResolution.telegramUsername;
      const effectiveTonviewer = nftItemAddress
        ? `https://tonviewer.com/${nftItemAddress}`
        : (ownerResolution.userFriendlyAddress ? `https://tonviewer.com/${ownerResolution.userFriendlyAddress}` : undefined);

      const isUpgradedOnProfile = ownerResolution.isProfileActive;
      const isChannel = ownerResolution.isChannel;
      const isOnGetgems = ownerResolution.isOnGetgems;

      let marketStatus: 'FOR_SALE' | 'ON_PROFILE' | 'JUST_MINTED' = 'JUST_MINTED';
      if (ownerResolution.isForSale) {
        marketStatus = 'FOR_SALE';
      } else if (ownerResolution.isProfileActive) {
        marketStatus = 'ON_PROFILE';
      }

      const metaTitle = typeof meta.name === 'string'
        ? meta.name.replace(/\s*#\d+\s*$/, '').trim()
        : '';
      const giftTitle =
        (collectionName && collectionName !== 'Telegram Gift' ? collectionName : '') ||
        ownerResolution.mtprotoInfo?.giftTitle ||
        metaTitle ||
        'Telegram Gift';

      return {
        id: `upgrade_${resolvedSlug}`,
        giftId: resolvedSlug,
        giftTitle,
        num,
        modelName,
        modelRarity,
        backdropName: backdropName || undefined,
        backdropRarity,
        symbolName: symbolName || undefined,
        symbolRarity,
        rarityLevel,
        description: meta.description,
        imageUrl:
          meta.image ||
          ownerResolution.nftImageUrl ||
          `https://nft.fragment.com/gift/${resolvedSlug}.webp`,
        lottieUrl: meta.lottie,
        ownerName: ownerResolution.displayName,
        ownerAddress: ownerResolution.userFriendlyAddress || senderAddress,
        ownerTelegramUsername,
        ownerTelegramUserId: ownerResolution.telegramUserId,
        isUpgradedOnProfile,
        isChannel,
        isOnGetgems,
        ageSec,
        marketStatus,
        platformName: 'Telegram / MRKT / Fragment',
        platformUrl: `https://fragment.com/gift/${resolvedSlug}`,
        telegramNftUrl: `https://t.me/nft/${resolvedSlug}`,
        fragmentUrl: `https://fragment.com/gift/${resolvedSlug}`,
        mrktUrl: `https://t.me/mrkt`,
        getgemsUrl: nftItemAddress ? `https://getgems.io/nft/${nftItemAddress}` : `https://getgems.io`,
        tonviewerUrl: effectiveTonviewer,
        timestamp: new Date(timestampSec * 1000).toISOString(),
      };
    } catch (err: any) {
      // Propagate: the caller decides whether to retry on the next cycle.
      throw new Error(`enrich ${tokenName}: ${err?.message || err}`, { cause: err });
    }
  }

  public async emitCraft(craft: UniqueCraftEvent): Promise<void> {
    console.log(
      `🎁 [Upgrade Detected] ${craft.giftTitle} #${craft.num} | Model: ${craft.modelName} | Owner: ${craft.ownerName || 'Unknown'} | Age: ${craft.ageSec ?? 0}s | Status: ${craft.marketStatus}`
    );
    for (const cb of this.onCraftCallbacks) {
      try {
        await cb(craft);
      } catch (err) {
        console.error('❌ Error handling gift upgrade event callback:', err);
      }
    }
  }
}
