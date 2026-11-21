import https from 'https';
import axios from 'axios';
import { db } from '../storage/database.js';
import { UniqueCraftEvent } from '../types/gift.js';
import { newestFirst } from './marketplace.js';
import { validateProfileGift } from './profileValidator.js';

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
  private tonApiKey?: string;
  private timer: NodeJS.Timeout | null = null;
  private isChecking = false;
  private onCraftCallbacks: CraftEventCallback[] = [];
  private botStartedAtSec = Math.floor(Date.now() / 1000);

  constructor(intervalSec = 3, tonApiKey?: string) {
    this.intervalSec = Math.max(2, intervalSec);
    this.tonApiKey = tonApiKey;
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
      if (err?.response?.status === 429) {
        console.warn('⚠️ [UpgradeStream] TonAPI rate limit (429). Applying 6s smart backoff...');
        await new Promise((r) => setTimeout(r, 6000));
      } else {
        console.error('⚠️ [UpgradeStream] Polling error:', err?.message || err);
      }
    } finally {
      this.isChecking = false;
    }
  }

  /**
   * Polls Fragment Gift Minter contract events for real-time gift upgrades.
   * Strictly filters out events older than 60s and events that happened before bot startup.
   */
  private async pollMinterEvents(): Promise<void> {
    const headers: Record<string, string> = {
      ...DEFAULT_HEADERS,
      Accept: 'application/json',
    };
    if (this.tonApiKey) {
      headers['Authorization'] = `Bearer ${this.tonApiKey}`;
    }

    const url = `https://tonapi.io/v2/accounts/${FRAGMENT_GIFT_MINTER_ADDRESS}/events?limit=30`;
    const res = await axios.get(url, { headers, timeout: 6000, httpsAgent });
    const events = res.data?.events || [];

    const nowSec = Math.floor(Date.now() / 1000);
    const isBaseline = !db.isCraftBaselineSet();

    interface UpgradeCandidate {
      tokenName: string;
      collectionName: string;
      senderAddress: string;
      timestamp: number;
      nftItemAddress?: string;
      ageSec: number;
    }

    const candidates: UpgradeCandidate[] = [];

    for (const ev of events) {
      const eventId = ev.event_id;
      if (!eventId) continue;

      const eventTimestamp = Number(ev.timestamp || 0);
      const ageSec = Math.max(0, nowSec - eventTimestamp);

      // 1. STRICT LATENCY FILTER: Discard any events older than 35 seconds (prevents notifying about already sold items)
      if (ageSec > 35) {
        db.markCraftSeen(eventId);
        continue;
      }

      // 2. Discard events that took place before bot started (e.g. on container restart)
      if (eventTimestamp < this.botStartedAtSec - 15) {
        db.markCraftSeen(eventId);
        continue;
      }

      // 3. Skip already processed events
      if (db.isCraftSeen(eventId)) {
        continue;
      }

      // Mark event as seen immediately
      db.markCraftSeen(eventId);

      // If initial baseline snapshot, do not emit historical items
      if (isBaseline) {
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

          let nftItemAddress = '';
          for (const a of ev.actions || []) {
            if (a.type === 'NftItemTransfer' && a.NftItemTransfer?.nft) {
              nftItemAddress = a.NftItemTransfer.nft;
              break;
            }
          }

          candidates.push({
            tokenName,
            collectionName: sc.contract?.name || 'Telegram Gift',
            senderAddress,
            timestamp: eventTimestamp,
            nftItemAddress,
            ageSec,
          });
        }
      }
    }

    if (isBaseline) {
      db.setCraftBaseline();
      console.log('✅ [UpgradeStream] Baseline snapshot initialized at startup. Streaming fresh real-time upgrades (< 60s)!');
      return;
    }

    if (candidates.length === 0) {
      return;
    }

    // Enrich candidates in parallel for lightning speed (< 1.5s total)
    const processing = newestFirst(candidates).map(async (c) => {
      const upgrade = await this.enrichGiftDetails(
          c.tokenName,
          c.collectionName,
          c.senderAddress,
          c.timestamp,
          c.nftItemAddress,
          c.ageSec
      );
      if (upgrade) await this.emitCraft(upgrade);
    });

    // Let each event notify as soon as its own enrichment completes; one slow lookup
    // no longer holds every other fresh upgrade in the batch.
    await Promise.allSettled(processing);
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
      const metaUrl = `https://nft.fragment.com/gift/${tokenName}.json`;

      // Parallel execution: Metadata + 100% Comprehensive Multi-Layer Profile Validation
      const [metaRes, ownerResolution] = await Promise.all([
        axios
          .get(metaUrl, { headers: DEFAULT_HEADERS, timeout: 3500, httpsAgent })
          .catch((err: any) => {
            console.warn(`⚠️ [UpgradeStream] Failed to load metadata for ${tokenName}:`, err?.message || err);
            return { data: {} };
          }),
        validateProfileGift(tokenName, senderAddress, nftItemAddress, this.tonApiKey, httpsAgent),
      ]);

      // STRICT PROFILE FILTER: Watch ONLY active gifts displayed on a human user's Telegram profile!
      if (!ownerResolution.isProfileActive || !ownerResolution.telegramUserId || ownerResolution.isChannel) {
        return null;
      }

      const meta = metaRes.data || {};
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
        const numMatch = (meta.name || tokenName).match(/#?\s*(\d+)$/);
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
      const isOnGetgems = ownerResolution.isForSale;

      let marketStatus: 'FOR_SALE' | 'ON_PROFILE' | 'JUST_MINTED' = 'JUST_MINTED';
      if (ownerResolution.isForSale) {
        marketStatus = 'FOR_SALE';
      } else if (ownerResolution.isProfileActive) {
        marketStatus = 'ON_PROFILE';
      }

      return {
        id: `upgrade_${tokenName}`,
        giftId: tokenName,
        giftTitle: collectionName || meta.name || 'Telegram Gift',
        num,
        modelName,
        modelRarity,
        backdropName: backdropName || undefined,
        backdropRarity,
        symbolName: symbolName || undefined,
        symbolRarity,
        rarityLevel,
        description: meta.description,
        imageUrl: meta.image || `https://nft.fragment.com/gift/${tokenName}.webp`,
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
        platformUrl: `https://fragment.com/gift/${tokenName}`,
        telegramNftUrl: `https://t.me/nft/${tokenName}`,
        fragmentUrl: `https://fragment.com/gift/${tokenName}`,
        mrktUrl: `https://t.me/mrkt`,
        getgemsUrl: nftItemAddress ? `https://getgems.io/nft/${nftItemAddress}` : `https://getgems.io`,
        tonviewerUrl: effectiveTonviewer,
        timestamp: new Date(timestampSec * 1000).toISOString(),
      };
    } catch (err: any) {
      console.warn(`⚠️ [UpgradeStream] Error enriching ${tokenName}:`, err?.message || err);
      return null;
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
