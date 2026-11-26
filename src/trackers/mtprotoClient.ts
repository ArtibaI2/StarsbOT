import { TelegramClient, Api, Logger } from 'telegram';
import { LogLevel } from 'telegram/extensions/Logger.js';
import { StringSession } from 'telegram/sessions/index.js';
import { config } from '../config/config.js';

export interface MtprotoGiftDetails {
  username?: string;
  userId?: number;
  firstName?: string;
  ownerAddress?: string;
  isChannel?: boolean;
  isProfileActive: boolean;
  giftTitle?: string;
  num?: number;
  modelName?: string;
  modelRarity?: string;
  backdropName?: string;
  backdropRarity?: string;
  symbolName?: string;
  symbolRarity?: string;
}

/** Telegram DC hiccups (INTERDC_*_CALL_RICH_ERROR, FLOOD, timeouts) that clear on retry. */
function isTransientMtprotoError(err: any): boolean {
  const text = String(err?.errorMessage || err?.message || err || '');
  return /INTERDC|FLOOD|TIMEOUT|ECONN|CONNECTION|Internal|RICH_ERROR|^500\b/i.test(text);
}

export class MtprotoService {
  private client: TelegramClient | null = null;
  private isConnected = false;

  /** Short-lived cache so a batch of events does not call MTProto twice per gift. */
  private static readonly CACHE_TTL_MS = 30_000;
  private static readonly CACHE_LIMIT = 500;
  private static readonly ERROR_LOG_INTERVAL_MS = 60_000;
  private giftCache = new Map<string, { at: number; value: MtprotoGiftDetails | null }>();
  private giftInflight = new Map<string, Promise<MtprotoGiftDetails | null>>();
  private lastErrorLogAt = 0;

  public async init(): Promise<boolean> {
    if (!config.TELEGRAM_API_ID || !config.TELEGRAM_API_HASH) {
      console.warn(
        '⚠️ [MTProto] TELEGRAM_API_ID / TELEGRAM_API_HASH are not set. ' +
          'Profile validation will fall back to Fragment HTML. Get credentials at https://my.telegram.org.'
      );
      return false;
    }

    if (!config.TELEGRAM_SESSION) {
      console.warn(
        '⚠️ [MTProto] TELEGRAM_SESSION is not set. payments.getUniqueStarGift is a user-only method, ' +
          'so a bot token cannot call it. Run `npm run mtproto:session` locally and set TELEGRAM_SESSION. ' +
          'Falling back to Fragment HTML.'
      );
      return false;
    }

    const apiId = Number(config.TELEGRAM_API_ID);
    const apiHash = config.TELEGRAM_API_HASH;

    try {
      const session = new StringSession(config.TELEGRAM_SESSION);
      // Suppress GramJS's verbose internal ping/reconnect stack traces; our RPC
      // wrapper already logs real lookup errors once per minute.
      const baseLogger = new Logger(LogLevel.NONE);
      this.client = new TelegramClient(session, apiId, apiHash, {
        connectionRetries: 5,
        retryDelay: 2000,
        autoReconnect: true,
        baseLogger,
      });

      console.log('⏳ [MTProto] Connecting with a user session...');
      await this.client.connect();

      if (!(await this.client.isUserAuthorized())) {
        console.warn(
          '⚠️ [MTProto] TELEGRAM_SESSION is not authorized. Regenerate it with `npm run mtproto:session`.'
        );
        await this.client.disconnect();
        this.client = null;
        this.isConnected = false;
        return false;
      }

      this.isConnected = true;
      console.log('✅ [MTProto] User session connected and authorized.');
      return true;
    } catch (err: any) {
      console.warn('⚠️ [MTProto] Could not connect with the user session:', err?.message || err);
      this.isConnected = false;
      return false;
    }
  }

  /**
   * Calls MTProto payments.GetUniqueStarGift to resolve owner peer, user info, and gift attributes.
   * Results are cached briefly and concurrent lookups of the same slug share one request.
   */
  public async getUniqueStarGift(slug: string): Promise<MtprotoGiftDetails | null> {
    const cached = this.giftCache.get(slug);
    if (cached && Date.now() - cached.at < MtprotoService.CACHE_TTL_MS) {
      return cached.value;
    }

    const inflight = this.giftInflight.get(slug);
    if (inflight) return inflight;

    const task = this.fetchUniqueStarGift(slug)
      .then((value) => {
        this.rememberGift(slug, value);
        return value;
      })
      // Transient failures are not cached: the next cycle should retry instead
      // of treating the gift as "unknown" for the whole TTL.
      .catch(() => null)
      .finally(() => {
        this.giftInflight.delete(slug);
      });

    this.giftInflight.set(slug, task);
    return task;
  }

  private rememberGift(slug: string, value: MtprotoGiftDetails | null): void {
    this.giftCache.set(slug, { at: Date.now(), value });
    if (this.giftCache.size > MtprotoService.CACHE_LIMIT) {
      const oldest = this.giftCache.keys().next().value;
      if (oldest) this.giftCache.delete(oldest);
    }
  }

  private async fetchUniqueStarGift(slug: string): Promise<MtprotoGiftDetails | null> {
    if (!this.client || !this.isConnected) return null;

    let res: any;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        res = await this.client.invoke(new Api.payments.GetUniqueStarGift({ slug }));
        break;
      } catch (err: any) {
        // INTERDC_*_CALL_RICH_ERROR is a transient Telegram-side 500 that
        // succeeds on a second attempt; retry once, then surface the error
        // (uncached) so the caller can fall back to Fragment for this cycle.
        if (attempt === 0 && isTransientMtprotoError(err)) {
          await new Promise((resolve) => setTimeout(resolve, 700));
          continue;
        }
        this.logLookupError(slug, err);
        throw err;
      }
    }

    if (!res) return null;

    // Flatten the MTProto response into the shape used by the validators.
    {
      const gift = res.gift;
      let username: string | undefined;
      let userId: number | undefined;
      let firstName: string | undefined;
      let isChannel = false;
      let isProfileActive = false;

      // Determine owner peer strictly from gift.ownerId
      let targetUserId: number | undefined;
      let targetChatId: number | undefined;

      if (gift?.ownerId) {
        if (gift.ownerId.className === 'PeerUser' || typeof gift.ownerId.userId !== 'undefined') {
          targetUserId = Number(gift.ownerId.userId);
        } else if (gift.ownerId.className === 'PeerChannel' || typeof gift.ownerId.channelId !== 'undefined') {
          targetChatId = Number(gift.ownerId.channelId);
        }
      }

      // 1. User Profile Resolution: ONLY if gift.ownerId is a PeerUser and NOT exported to TON blockchain
      if (targetUserId && !gift?.ownerAddress) {
        const users = Array.isArray(res.users)
          ? (res.users as Array<{
              id: unknown;
              deleted?: boolean;
              bot?: boolean;
              username?: string;
              firstName?: string;
            }>)
          : [];
        const targetUser = users.find((u) => Number(u.id) === targetUserId);

        if (targetUser && !targetUser.deleted && !targetUser.bot) {
          userId = Number(targetUser.id);
          username = targetUser.username;
          firstName = targetUser.firstName;
          isProfileActive = true;
        }
      } else if (targetChatId) {
        // Channel Profile
        isChannel = true;
        isProfileActive = false;
        const chats = Array.isArray(res.chats)
          ? (res.chats as Array<{ id: unknown; username?: string; title?: string }>)
          : [];
        const targetChat = chats.find((c) => Number(c.id) === targetChatId);
        if (targetChat) {
          userId = -Math.abs(Number(targetChat.id));
          username = targetChat.username;
          firstName = targetChat.title;
        }
      } else {
        // If ownerId is missing or gift has ownerAddress -> definitely NOT an active profile gift!
        // (Do NOT fall back to res.users which only contains historical recipients from StarGiftAttributeOriginalDetails)
        isProfileActive = false;
      }

      // Check gift.ownerName fallback for username only if active in profile
      if (isProfileActive && !username && gift?.ownerName) {
        if (gift.ownerName.startsWith('@')) {
          username = gift.ownerName.slice(1);
        } else if (gift.ownerName.endsWith('.t.me')) {
          username = gift.ownerName.replace(/\.t.me$/i, '');
        } else if (gift.ownerName.endsWith('.ton')) {
          username = gift.ownerName.replace(/\.ton$/i, '');
        }
      }

      // Parse Attributes & Rarities from MTProto
      let modelName: string | undefined;
      let modelRarity: string | undefined;
      let backdropName: string | undefined;
      let backdropRarity: string | undefined;
      let symbolName: string | undefined;
      let symbolRarity: string | undefined;

      if (Array.isArray(gift?.attributes)) {
        for (const attr of gift.attributes) {
          const permille = attr.rarityPermille;
          const rarityStr = typeof permille === 'number' ? `${(permille / 10).toFixed(1)}%` : undefined;
          const className = attr.className || '';

          if (className === 'StarGiftAttributeModel' || (!modelName && attr.name)) {
            modelName = attr.name;
            if (rarityStr) modelRarity = rarityStr;
          } else if (className === 'StarGiftAttributeBackdrop') {
            backdropName = attr.name;
            if (rarityStr) backdropRarity = rarityStr;
          } else if (className === 'StarGiftAttributePattern') {
            symbolName = attr.name;
            if (rarityStr) symbolRarity = rarityStr;
          }
        }
      }

      return {
        username,
        userId,
        firstName,
        ownerAddress: gift?.ownerAddress,
        isChannel,
        isProfileActive,
        giftTitle: gift?.title,
        num: gift?.num ? Number(gift.num) : undefined,
        modelName,
        modelRarity,
        backdropName,
        backdropRarity,
        symbolName,
        symbolRarity,
      };
    }
  }

  /** One warning per minute: a flaky Telegram DC must not flood the console. */
  private logLookupError(slug: string, err: any): void {
    const now = Date.now();
    if (now - this.lastErrorLogAt < MtprotoService.ERROR_LOG_INTERVAL_MS) return;
    this.lastErrorLogAt = now;
    console.warn(
      `⚠️ [MTProto] getUniqueStarGift failed for ${slug}:`,
      err?.errorMessage || err?.message || err
    );
  }

  public getClient(): TelegramClient | null {
    return this.client;
  }

  public isReady(): boolean {
    return this.isConnected && this.client !== null;
  }

  public async disconnect(): Promise<void> {
    if (this.client && this.isConnected) {
      await this.client.disconnect();
      this.isConnected = false;
      console.log('🛑 [MTProto] Disconnected.');
    }
  }
}

export const mtprotoService = new MtprotoService();

