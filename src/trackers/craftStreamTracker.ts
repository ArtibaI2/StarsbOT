import axios from 'axios';
import { db } from '../storage/database.js';
import { UniqueCraftEvent } from '../types/gift.js';
import { mtprotoService } from './mtprotoClient.js';

export type CraftEventCallback = (craft: UniqueCraftEvent) => Promise<void>;

// The official Fragment Gift Minter contract that processes EVERY Telegram gift upgrade
const FRAGMENT_GIFT_MINTER_ADDRESS = '0:158136239adb15dd59df90c641f9efd312cfeb8664f218f4c3e5fce9d95e6c07';

export class CraftStreamTracker {
  private intervalSec: number;
  private tonApiKey?: string;
  private timer: NodeJS.Timeout | null = null;
  private isChecking = false;
  private onCraftCallbacks: CraftEventCallback[] = [];

  constructor(intervalSec = 8, tonApiKey?: string) {
    this.intervalSec = Math.max(5, intervalSec);
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
   * Polls Fragment Gift Minter contract events for real-time gift upgrades
   */
  private async pollMinterEvents(): Promise<void> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (this.tonApiKey) {
      headers['Authorization'] = `Bearer ${this.tonApiKey}`;
    }

    const url = `https://tonapi.io/v2/accounts/${FRAGMENT_GIFT_MINTER_ADDRESS}/events?limit=15`;
    const res = await axios.get(url, { headers, timeout: 8000 });
    const events = res.data?.events || [];

    const isBaseline = !db.isCraftBaselineSet();
    const newUpgrades: UniqueCraftEvent[] = [];

    for (const ev of events) {
      const eventId = ev.event_id;
      if (!eventId) continue;

      if (db.isCraftSeen(eventId)) {
        continue; // Already processed
      }

      // Mark event as seen
      db.markCraftSeen(eventId);

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

          if (isBaseline) {
            // During first run, just record existing events as seen to prevent historical spam
            continue;
          }

          let nftItemAddress = '';
          for (const a of ev.actions || []) {
            if (a.type === 'NftItemTransfer' && a.NftItemTransfer?.nft) {
              nftItemAddress = a.NftItemTransfer.nft;
              break;
            }
          }

          // Fetch full metadata for this upgraded gift
          const craftEvent = await this.enrichGiftDetails(
            tokenName,
            sc.contract?.name || 'Telegram Gift',
            senderAddress,
            ev.timestamp,
            nftItemAddress
          );

          if (craftEvent) {
            newUpgrades.push(craftEvent);
          }
        }
      }
    }

    if (isBaseline) {
      db.setCraftBaseline();
      console.log('✅ [UpgradeStream] Baseline snapshot recorded. Now streaming newly upgraded gifts!');
    } else {
      // Emit newly upgraded gifts (reverse order so oldest first)
      for (const upgrade of newUpgrades.reverse()) {
        await this.emitCraft(upgrade);
      }
    }
  }

  /**
   * Fetches the upgraded gift's image, owner and attributes
   */
  private async enrichGiftDetails(
    tokenName: string,
    collectionName: string,
    senderAddress: string,
    timestampSec: number,
    nftItemAddress?: string
  ): Promise<UniqueCraftEvent | null> {
    try {
      const metaUrl = `https://nft.fragment.com/gift/${tokenName}.json`;
      const metaRes = await axios.get(metaUrl, { timeout: 5000 });
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

      // Extract number from name e.g. "Mousse Cake #9937"
      let num = 0;
      const numMatch = (meta.name || tokenName).match(/#?\s*(\d+)$/);
      if (numMatch) {
        num = parseInt(numMatch[1], 10);
      }

      // Resolve human-readable owner (Nickname / Username / TON DNS or User-Friendly Address)
      const ownerInfo = await this.resolveOwnerInfo(tokenName, senderAddress);

      let ownerTelegramUsername = ownerInfo.telegramUsername;
      if (!ownerTelegramUsername && ownerInfo.displayName) {
        let candidate: string | undefined;
        if (ownerInfo.displayName.endsWith('.t.me')) {
          candidate = ownerInfo.displayName.replace(/\.t.me$/i, '');
        } else if (ownerInfo.displayName.endsWith('.ton')) {
          candidate = ownerInfo.displayName.replace(/\.ton$/i, '');
        } else if (ownerInfo.displayName.startsWith('@')) {
          candidate = ownerInfo.displayName.slice(1);
        } else if (/^[a-zA-Z0-9_]{4,32}$/.test(ownerInfo.displayName)) {
          candidate = ownerInfo.displayName;
        }

        // Telegram usernames ONLY allow letters, numbers and underscores. NO hyphens!
        if (candidate && /^[a-zA-Z0-9_]{4,32}$/.test(candidate) && !candidate.includes('-')) {
          ownerTelegramUsername = candidate;
        }
      }

      const effectiveTonviewer = nftItemAddress
        ? `https://tonviewer.com/${nftItemAddress}`
        : (ownerInfo.userFriendlyAddress ? `https://tonviewer.com/${ownerInfo.userFriendlyAddress}` : undefined);

      const isUpgradedOnProfile = Boolean(
        ownerTelegramUsername ||
        ownerInfo.isRealName ||
        (ownerInfo.displayName && !ownerInfo.displayName.startsWith('UQ') && !ownerInfo.displayName.includes('...'))
      );

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
        ownerName: ownerInfo.displayName,
        ownerAddress: ownerInfo.userFriendlyAddress || senderAddress,
        ownerTelegramUsername,
        ownerTelegramUserId: ownerInfo.telegramUserId,
        isUpgradedOnProfile,
        platformName: 'Telegram / MRKT / Fragment',
        platformUrl: `https://fragment.com/gift/${tokenName}`,
        telegramNftUrl: `https://t.me/nft/${tokenName}`,
        fragmentUrl: `https://fragment.com/gift/${tokenName}`,
        mrktUrl: `https://t.me/mrkt`,
        getgemsUrl: nftItemAddress ? `https://getgems.io/nft/${nftItemAddress}` : `https://getgems.io`,
        tonviewerUrl: effectiveTonviewer,
        timestamp: new Date(timestampSec * 1000).toISOString(),
      };
    } catch {
      const ownerInfo = await this.resolveOwnerInfo(tokenName, senderAddress);
      let ownerTelegramUsername = ownerInfo.telegramUsername;
      if (!ownerTelegramUsername && ownerInfo.displayName) {
        let candidate: string | undefined;
        if (ownerInfo.displayName.endsWith('.t.me')) {
          candidate = ownerInfo.displayName.replace(/\.t.me$/i, '');
        } else if (ownerInfo.displayName.endsWith('.ton')) {
          candidate = ownerInfo.displayName.replace(/\.ton$/i, '');
        } else if (ownerInfo.displayName.startsWith('@')) {
          candidate = ownerInfo.displayName.slice(1);
        } else if (/^[a-zA-Z0-9_]{4,32}$/.test(ownerInfo.displayName)) {
          candidate = ownerInfo.displayName;
        }

        // Telegram usernames ONLY allow letters, numbers and underscores. NO hyphens!
        if (candidate && /^[a-zA-Z0-9_]{4,32}$/.test(candidate) && !candidate.includes('-')) {
          ownerTelegramUsername = candidate;
        }
      }

      const isUpgradedOnProfile = Boolean(
        ownerTelegramUsername ||
        ownerInfo.isRealName ||
        (ownerInfo.displayName && !ownerInfo.displayName.startsWith('UQ') && !ownerInfo.displayName.includes('...'))
      );

      return {
        id: `upgrade_${tokenName}`,
        giftId: tokenName,
        giftTitle: collectionName,
        num: 0,
        modelName: 'Upgraded Model',
        imageUrl: `https://nft.fragment.com/gift/${tokenName}.webp`,
        ownerName: ownerInfo.displayName,
        ownerAddress: ownerInfo.userFriendlyAddress || senderAddress,
        ownerTelegramUsername,
        ownerTelegramUserId: ownerInfo.telegramUserId,
        isUpgradedOnProfile,
        platformName: 'Telegram / MRKT / Fragment',
        platformUrl: `https://fragment.com/gift/${tokenName}`,
        telegramNftUrl: `https://t.me/nft/${tokenName}`,
        fragmentUrl: `https://fragment.com/gift/${tokenName}`,
        mrktUrl: `https://t.me/mrkt`,
        getgemsUrl: nftItemAddress ? `https://getgems.io/nft/${nftItemAddress}` : `https://getgems.io`,
        tonviewerUrl: nftItemAddress
          ? `https://tonviewer.com/${nftItemAddress}`
          : (ownerInfo.userFriendlyAddress ? `https://tonviewer.com/${ownerInfo.userFriendlyAddress}` : undefined),
        timestamp: new Date(timestampSec * 1000).toISOString(),
      };
    }
  }

  /**
   * Resolves owner info using 4 advanced techniques:
   * 1. Cache & Marketplace database lookup
   * 2. Telegram MTProto payments.getUniqueStarGift (host_id & users)
   * 3. Fragment & Reverse TON DNS backresolve
   * 4. TON NFT Scanner (Telegram Usernames & DNS NFTs)
   */
  private async resolveOwnerInfo(
    tokenName: string,
    rawAddress: string
  ): Promise<{ displayName: string; userFriendlyAddress?: string; isRealName: boolean; telegramUsername?: string; telegramUserId?: number }> {
    // 0. Cache / Database Lookup
    if (rawAddress) {
      const cached = db.getWalletUsername(rawAddress);
      if (cached) {
        return {
          displayName: `@${cached}`,
          telegramUsername: cached,
          isRealName: true,
        };
      }
    }

    // 1. Method 1: MTProto payments.getUniqueStarGift (Telegram Profile Upgrades)
    try {
      const mtprotoInfo = await mtprotoService.getUniqueStarGift(tokenName);
      if (mtprotoInfo?.username || mtprotoInfo?.userId) {
        if (rawAddress && mtprotoInfo.username) {
          db.setWalletUsername(rawAddress, mtprotoInfo.username, 'mtproto');
        }
        return {
          displayName: mtprotoInfo.username ? `@${mtprotoInfo.username}` : (mtprotoInfo.firstName || 'Владелец в профиле'),
          telegramUsername: mtprotoInfo.username,
          telegramUserId: mtprotoInfo.userId,
          isRealName: true,
        };
      }
    } catch {}

    // 2. Parse Fragment HTML page for nickname/domain
    try {
      const fragRes = await axios.get(`https://fragment.com/gift/${tokenName}`, { timeout: 3500 });
      const html = fragRes.data || '';
      const rowMatch = html.match(/<tr[^>]*>[\s\S]*?Owner[\s\S]*?<\/tr>/i);
      if (rowMatch) {
        const row = rowMatch[0];
        const shortMatch = row.match(/<span class="short">([^<]+)<\/span>/i);
        if (shortMatch && shortMatch[1]) {
          const val = shortMatch[1].trim();
          let tgUsername: string | undefined;
          if (val.endsWith('.ton')) {
            const clean = val.replace(/\.ton$/i, '');
            if (/^[a-zA-Z0-9_]{4,32}$/.test(clean) && !clean.includes('-')) {
              tgUsername = clean;
            }
          } else if (val.endsWith('.t.me')) {
            const clean = val.replace(/\.t.me$/i, '');
            if (/^[a-zA-Z0-9_]{4,32}$/.test(clean) && !clean.includes('-')) {
              tgUsername = clean;
            }
          } else if (val.startsWith('@')) {
            const clean = val.slice(1);
            if (/^[a-zA-Z0-9_]{4,32}$/.test(clean) && !clean.includes('-')) {
              tgUsername = clean;
            }
          } else if (/^[a-zA-Z0-9_]{4,32}$/.test(val) && !val.includes('-')) {
            tgUsername = val;
          }

          if (tgUsername && rawAddress) {
            db.setWalletUsername(rawAddress, tgUsername, 'fragment');
          }

          return {
            displayName: val,
            telegramUsername: tgUsername,
            isRealName: true,
          };
        }

        const headMatch = row.match(/<span class="head">([^<]+)<\/span>/i);
        const tailMatch = row.match(/<span class="tail">([^<]+)<\/span>/i);
        if (headMatch && tailMatch) {
          const full = headMatch[1].trim() + tailMatch[1].trim();
          const shortAddr = `${headMatch[1].trim().slice(0, 6)}...${tailMatch[1].trim().slice(-4)}`;
          return {
            displayName: shortAddr,
            userFriendlyAddress: full,
            isRealName: false,
          };
        }
      }
    } catch {}

    if (rawAddress) {
      // 3. Method 3: Reverse TON DNS backresolve
      try {
        const dnsRes = await axios.get(`https://tonapi.io/v2/accounts/${encodeURIComponent(rawAddress)}/dns/backresolve`, {
          timeout: 3000,
        });
        const domains = dnsRes.data?.domains;
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
          };
        }
      } catch {}

      // 4. Method 2: TON NFT Scan (Telegram Usernames & TON Domains)
      try {
        const nftRes = await axios.get(`https://tonapi.io/v2/accounts/${encodeURIComponent(rawAddress)}/nfts`, {
          timeout: 3500,
        });
        const nftItems = nftRes.data?.nft_items || [];
        for (const item of nftItems) {
          const colName = item.collection?.name || '';
          const metaName = item.metadata?.name || '';
          const dns = item.dns || '';

          if (colName === 'Telegram Usernames' || metaName.startsWith('@')) {
            const cleanUser = metaName.replace(/^@/, '').trim();
            if (cleanUser && /^[a-zA-Z0-9_]{4,32}$/.test(cleanUser)) {
              db.setWalletUsername(rawAddress, cleanUser, 'nft_username');
              return {
                displayName: `@${cleanUser}`,
                telegramUsername: cleanUser,
                isRealName: true,
              };
            }
          }

          if (dns && (dns.endsWith('.t.me') || dns.endsWith('.ton'))) {
            const cleanUser = dns.replace(/\.(t\.me|ton)$/i, '');
            if (cleanUser && /^[a-zA-Z0-9_]{4,32}$/.test(cleanUser)) {
              db.setWalletUsername(rawAddress, cleanUser, 'nft_dns');
              return {
                displayName: dns,
                telegramUsername: cleanUser,
                isRealName: true,
              };
            }
          }
        }
      } catch {}

      // 5. Try TonAPI account name
      try {
        const accRes = await axios.get(`https://tonapi.io/v2/accounts/${encodeURIComponent(rawAddress)}`, {
          timeout: 3000,
        });
        if (accRes.data?.name) {
          const name = accRes.data.name.trim();
          let candidate: string | undefined;
          if (name.endsWith('.ton')) {
            candidate = name.replace(/\.ton$/i, '');
          } else if (name.endsWith('.t.me')) {
            candidate = name.replace(/\.t.me$/i, '');
          } else if (name.startsWith('@')) {
            candidate = name.slice(1);
          } else if (/^[a-zA-Z0-9_]{4,32}$/.test(name)) {
            candidate = name;
          }

          let tgUsername: string | undefined;
          if (candidate && /^[a-zA-Z0-9_]{4,32}$/.test(candidate) && !candidate.includes('-')) {
            tgUsername = candidate;
            db.setWalletUsername(rawAddress, tgUsername, 'tonapi_name');
          }

          return {
            displayName: name,
            telegramUsername: tgUsername,
            isRealName: true,
          };
        }
      } catch {}

      // 6. Convert raw address to user-friendly UQ... format
      try {
        const parseRes = await axios.get(`https://tonapi.io/v2/address/${encodeURIComponent(rawAddress)}/parse`, {
          timeout: 3000,
        });
        const uq = parseRes.data?.non_bounceable?.b64url;
        if (uq) {
          return {
            displayName: `${uq.slice(0, 6)}...${uq.slice(-4)}`,
            userFriendlyAddress: uq,
            isRealName: false,
          };
        }
      } catch {}
    }

    return {
      displayName: 'Анонимно / Скрыт',
      isRealName: false,
    };
  }

  public async emitCraft(craft: UniqueCraftEvent): Promise<void> {
    console.log(
      `🎁 [Upgrade Detected] ${craft.giftTitle} #${craft.num} | Model: ${craft.modelName} | Owner: ${craft.ownerName || 'Unknown'}`
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
