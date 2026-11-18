import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { config } from '../config/config.js';

export class MtprotoService {
  private client: TelegramClient | null = null;
  private isConnected = false;

  public async init(): Promise<boolean> {
    const apiId = config.TELEGRAM_API_ID ? Number(config.TELEGRAM_API_ID) : 2040;
    const apiHash = config.TELEGRAM_API_HASH || 'b18441a1ff607e10a989891a5462e627';

    try {
      const session = new StringSession(config.TELEGRAM_SESSION || '');
      this.client = new TelegramClient(session, apiId, apiHash, {
        connectionRetries: 5,
      });

      console.log('⏳ [MTProto] Connecting to Telegram MTProto API...');
      
      if (config.TELEGRAM_SESSION) {
        await this.client.connect();
      } else if (config.BOT_TOKEN) {
        await this.client.start({
          botAuthToken: config.BOT_TOKEN,
        });
      } else {
        await this.client.connect();
      }

      this.isConnected = true;
      console.log('✅ [MTProto] MTProto client connected and authenticated successfully!');
      return true;
    } catch (err: any) {
      console.warn('⚠️ [MTProto] Could not authenticate MTProto:', err?.message || err);
      this.isConnected = false;
      return false;
    }
  }

  /**
   * Calls MTProto payments.GetUniqueStarGift to resolve owner peer and user info
   */
  public async getUniqueStarGift(slug: string): Promise<{
    username?: string;
    userId?: number;
    firstName?: string;
    ownerAddress?: string;
    isChannel?: boolean;
    isProfileActive: boolean;
  } | null> {
    if (!this.client || !this.isConnected) return null;

    try {
      const res: any = await this.client.invoke(
        new Api.payments.GetUniqueStarGift({ slug })
      );

      if (!res) return null;

      const gift = res.gift;
      let username: string | undefined;
      let userId: number | undefined;
      let firstName: string | undefined;
      let isChannel = false;
      let isProfileActive = false;

      // 1. Check users array returned by Telegram (Personal Profiles)
      if (Array.isArray(res.users) && res.users.length > 0) {
        const u = res.users.find((user: any) => !user.deleted && !user.bot) || res.users[0];
        if (u && !u.deleted) {
          if (u.username) {
            username = u.username;
          }
          if (u.id) {
            userId = Number(u.id);
          }
          if (u.firstName) {
            firstName = u.firstName;
          }
          isProfileActive = Boolean(userId && userId > 0 && !u.bot);
        }
      }

      // 2. Check chats array returned by Telegram (Channels)
      if (Array.isArray(res.chats) && res.chats.length > 0) {
        const c = res.chats[0];
        isChannel = true;
        isProfileActive = false;
        if (c.username) {
          username = c.username;
        }
        if (c.id) {
          userId = -Math.abs(Number(c.id));
        }
        if (c.title) {
          firstName = c.title;
        }
      }

      // 3. Check gift.ownerName or gift.slug
      if (!username && gift?.ownerName) {
        if (gift.ownerName.startsWith('@')) {
          username = gift.ownerName.slice(1);
        } else if (gift.ownerName.endsWith('.t.me')) {
          username = gift.ownerName.replace(/\.t.me$/i, '');
        } else if (gift.ownerName.endsWith('.ton')) {
          username = gift.ownerName.replace(/\.ton$/i, '');
        }
      }

      // Detached / exported blockchain-only gift has no active profile
      if (gift?.ownerAddress && (!res.users || res.users.length === 0)) {
        isProfileActive = false;
      }

      return {
        username,
        userId,
        firstName,
        ownerAddress: gift?.ownerAddress,
        isChannel,
        isProfileActive,
      };
    } catch {
      return null;
    }
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

