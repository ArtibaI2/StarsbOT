import axios from 'axios';
import { db } from '../storage/database.js';
import { UniqueCraftEvent } from '../types/gift.js';
import { mtprotoService } from './mtprotoClient.js';
import { isGetgemsSale, newestFirst } from './marketplace.js';

export type CraftEventCallback = (craft: UniqueCraftEvent) => Promise<void>;

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
      console.error('⚠️ [UpgradeStream] Polling error:', err?.message || err);
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
      Accept: 'application/json',
    };
    if (this.tonApiKey) {
      headers['Authorization'] = `Bearer ${this.tonApiKey}`;
    }

    const url = `https://tonapi.io/v2/accounts/${FRAGMENT_GIFT_MINTER_ADDRESS}/events?limit=30`;
    const res = await axios.get(url, { headers, timeout: 6000 });
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

      // Parallel execution: Metadata + Owner & Fragment Status
      const [metaRes, ownerResolution, isGetgemsListed] = await Promise.all([
        axios.get(metaUrl, { timeout: 3500 }).catch(() => ({ data: {} })),
        this.resolveOwnerAndFragmentStatus(tokenName, senderAddress),
        this.fetchIsGetgemsListed(nftItemAddress),
      ]);

      // STRICT PROFILE FILTER: Watch ONLY active gifts displayed on a human user's Telegram profile!
      if (!ownerResolution.isProfileActive || !ownerResolution.telegramUserId || ownerResolution.isChannel) {
        return null;
      }

      const meta = metaRes.data || {};
      const attributes = Array.isArray(meta.attributes) ? meta.attributes : [];
      const getAttr = (name: string): string => {
        const found = attributes.find(
          (a: any) => (a.trait_type || '').toLowerCase() === name.toLowerCase()
        );
        return found ? String(found.value || '') : '';
      };

      const modelName = getAttr('Model') || 'Classic';
      const backdropName = getAttr('Backdrop');
      const symbolName = getAttr('Symbol') || getAttr('Pattern');

      let num = 0;
      const numMatch = (meta.name || tokenName).match(/#?\s*(\d+)$/);
      if (numMatch) {
        num = parseInt(numMatch[1], 10);
      }

      const ownerTelegramUsername = ownerResolution.telegramUsername;
      const effectiveTonviewer = nftItemAddress
        ? `https://tonviewer.com/${nftItemAddress}`
        : (ownerResolution.userFriendlyAddress ? `https://tonviewer.com/${ownerResolution.userFriendlyAddress}` : undefined);

      const isUpgradedOnProfile = Boolean(
        ownerTelegramUsername ||
        ownerResolution.isRealName ||
        (ownerResolution.displayName && !ownerResolution.displayName.startsWith('UQ') && !ownerResolution.displayName.includes('...'))
      );

      const isChannel = Boolean(
        ownerResolution.isChannel ||
        (ownerResolution.telegramUserId && ownerResolution.telegramUserId < 0)
      );

      const isOnGetgems = isGetgemsListed || Boolean(
        ownerResolution.displayName?.toLowerCase().includes('getgems') ||
        senderAddress?.toLowerCase().includes('getgems') ||
        (effectiveTonviewer && effectiveTonviewer.toLowerCase().includes('getgems'))
      );

      let marketStatus: 'FOR_SALE' | 'ON_PROFILE' | 'JUST_MINTED' = 'JUST_MINTED';
      if (ownerResolution.isForSale) {
        marketStatus = 'FOR_SALE';
      } else if (isUpgradedOnProfile) {
        marketStatus = 'ON_PROFILE';
      }

      return {
        id: `upgrade_${tokenName}`,
        giftId: tokenName,
        giftTitle: collectionName || meta.name || 'Telegram Gift',
        num,
        modelName,
        backdropName: backdropName || undefined,
        symbolName: symbolName || undefined,
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

  private async fetchIsGetgemsListed(nftItemAddress?: string): Promise<boolean> {
    if (!nftItemAddress || !db.hasActiveGetgemsFilters()) return false;

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.tonApiKey) headers.Authorization = `Bearer ${this.tonApiKey}`;

    try {
      const res = await axios.get(
        `https://tonapi.io/v2/nfts/${encodeURIComponent(nftItemAddress)}`,
        { headers, timeout: 1200 }
      );
      return isGetgemsSale(res.data);
    } catch {
      return false;
    }
  }

  /**
   * Resolves owner information and checks Fragment live status (For sale vs Sold)
   */
  private async resolveOwnerAndFragmentStatus(
    tokenName: string,
    rawAddress: string
  ): Promise<{
    displayName: string;
    userFriendlyAddress?: string;
    isRealName: boolean;
    telegramUsername?: string;
    telegramUserId?: number;
    isSold: boolean;
    isForSale: boolean;
    isChannel?: boolean;
    isProfileActive: boolean;
  }> {
    let isSold = false;
    let isForSale = false;

    // Check Fragment HTML and MTProto in parallel for minimum latency
    const [fragRes, mtprotoInfo] = await Promise.all([
      axios.get(`https://fragment.com/gift/${tokenName}`, { timeout: 2500 }).catch(() => null),
      mtprotoService.getUniqueStarGift(tokenName).catch(() => null),
    ]);

    let fragmentOwnerRaw: string | undefined;

    if (fragRes?.data) {
      const html = fragRes.data;

      // Extract status from Fragment header
      const statusMatch = html.match(/<span class="tm-section-header-status[^>]*>([^<]+)<\/span>/i);
      const statusText = statusMatch ? statusMatch[1].trim() : '';
      if (/sold/i.test(statusText) || /tm-status-unavail/i.test(html)) {
        isSold = true;
      }
      if (/sale/i.test(statusText) || /tm-status-avail/i.test(html)) {
        isForSale = true;
      }

      // Extract owner from Fragment table
      const rowMatch = html.match(/<tr[^>]*>[\s\S]*?Owner[\s\S]*?<\/tr>/i);
      if (rowMatch) {
        const row = rowMatch[0];
        const shortMatch = row.match(/<span class="short">([^<]+)<\/span>/i);
        if (shortMatch && shortMatch[1]) {
          fragmentOwnerRaw = shortMatch[1].trim();
        }
      }
    }

    // 1. MTProto resolution (Live Telegram Profile)
    if (mtprotoInfo?.isProfileActive && mtprotoInfo?.userId) {
      if (rawAddress && mtprotoInfo.username) {
        db.setWalletUsername(rawAddress, mtprotoInfo.username, 'mtproto');
      }
      return {
        displayName: mtprotoInfo.username ? `@${mtprotoInfo.username}` : (mtprotoInfo.firstName || 'Владелец в профиле'),
        telegramUsername: mtprotoInfo.username,
        telegramUserId: mtprotoInfo.userId,
        isRealName: true,
        isSold,
        isForSale,
        isChannel: Boolean(mtprotoInfo.isChannel),
        isProfileActive: true,
      };
    }

    // 2. Cache / DB Lookup
    if (rawAddress) {
      const cached = db.getWalletUsername(rawAddress);
      if (cached) {
        return {
          displayName: `@${cached}`,
          telegramUsername: cached,
          isRealName: true,
          isSold,
          isForSale,
          isProfileActive: false,
        };
      }
    }

    // 3. Fragment Owner
    if (fragmentOwnerRaw) {
      let candidate: string | undefined;
      if (fragmentOwnerRaw.endsWith('.ton')) {
        candidate = fragmentOwnerRaw.replace(/\.ton$/i, '');
      } else if (fragmentOwnerRaw.endsWith('.t.me')) {
        candidate = fragmentOwnerRaw.replace(/\.t.me$/i, '');
      } else if (fragmentOwnerRaw.startsWith('@')) {
        candidate = fragmentOwnerRaw.slice(1);
      } else if (/^[a-zA-Z0-9_]{4,32}$/.test(fragmentOwnerRaw)) {
        candidate = fragmentOwnerRaw;
      }

      let tgUsername: string | undefined;
      if (candidate && /^[a-zA-Z0-9_]{4,32}$/.test(candidate) && !candidate.includes('-')) {
        tgUsername = candidate;
        if (rawAddress) {
          db.setWalletUsername(rawAddress, tgUsername, 'fragment');
        }
      }

      return {
        displayName: fragmentOwnerRaw,
        telegramUsername: tgUsername,
        isRealName: true,
        isSold,
        isForSale,
        isProfileActive: false,
      };
    }

    // 4. Reverse TON DNS / TonAPI fallback
    if (rawAddress) {
      const dnsPromise = axios.get(`https://tonapi.io/v2/accounts/${encodeURIComponent(rawAddress)}/dns/backresolve`, {
          timeout: 2000,
        }).catch(() => null);
      const parsePromise = axios.get(`https://tonapi.io/v2/address/${encodeURIComponent(rawAddress)}/parse`, {
          timeout: 2000,
        }).catch(() => null);

      try {
        const dnsRes = await dnsPromise;
        const domains = dnsRes?.data?.domains;
        if (Array.isArray(domains) && domains.length > 0) {
          const dom = domains[0].trim();
          const clean = dom.replace(/\.(ton|t\.me)$/i, '');
          const tgUsername = (/^[a-zA-Z0-9_]{4,32}$/.test(clean) && !clean.includes('-')) ? clean : undefined;
          if (tgUsername) {
            db.setWalletUsername(rawAddress, tgUsername, 'ton_dns');
          }
          return {
            displayName: dom,
            telegramUsername: tgUsername,
            isRealName: true,
            isSold,
            isForSale,
            isProfileActive: false,
          };
        }
      } catch {}

      try {
        const parseRes = await parsePromise;
        const uq = parseRes?.data?.non_bounceable?.b64url;
        if (uq) {
          return {
            displayName: `${uq.slice(0, 6)}...${uq.slice(-4)}`,
            userFriendlyAddress: uq,
            isRealName: false,
            isSold,
            isForSale,
            isProfileActive: false,
          };
        }
      } catch {}
    }

    return {
      displayName: 'Анонимно / Скрыт',
      isRealName: false,
      isSold,
      isForSale,
      isProfileActive: false,
    };
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
