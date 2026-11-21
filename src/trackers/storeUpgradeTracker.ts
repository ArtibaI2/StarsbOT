import { Bot } from 'grammy';
import { db } from '../storage/database.js';
import { TelegramGift, GiftUpgradeEvent } from '../types/gift.js';

export interface RawApiGift {
  id: string;
  sticker?: {
    file_id?: string;
  };
  star_count: number;
  total_count?: number;
  remaining_count?: number;
  upgrade_stars?: number;
}

export type UpgradeEventCallback = (event: GiftUpgradeEvent, gift: TelegramGift) => Promise<void>;

export class StoreUpgradeTracker {
  private bot: Bot;
  private intervalSec: number;
  private timer: NodeJS.Timeout | null = null;
  private isChecking = false;
  private onEventCallbacks: UpgradeEventCallback[] = [];

  constructor(bot: Bot, intervalSec = 30) {
    this.bot = bot;
    this.intervalSec = intervalSec;
  }

  public onEvent(callback: UpgradeEventCallback): void {
    this.onEventCallbacks.push(callback);
  }

  public start(): void {
    if (this.timer) return;
    console.log(`🚀 [StoreTracker] Started monitoring gifts upgrade status (every ${this.intervalSec}s)`);
    // Run initial check immediately
    this.check();
    this.timer = setInterval(() => this.check(), this.intervalSec * 1000);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('🛑 [StoreTracker] Stopped.');
    }
  }

  public async check(): Promise<void> {
    if (this.isChecking) return;
    this.isChecking = true;

    try {
      db.updateLastCheck('store');
      const rawGifts = await this.fetchAvailableGifts();
      if (!rawGifts || rawGifts.length === 0) {
        return;
      }

      await this.processGifts(rawGifts);
    } catch (err: any) {
      console.error('⚠️ [StoreTracker] Error checking store gifts:', err?.message || err);
    } finally {
      this.isChecking = false;
    }
  }

  /**
   * Fetches the current list of available gifts from Telegram Bot API
   */
  private async fetchAvailableGifts(): Promise<RawApiGift[]> {
    try {
      // Call official Telegram Bot API method getAvailableGifts (Bot API 8.0+).
      // The grammY typings may lag behind the Bot API, so we check the method at runtime.
      const rawApi = this.bot.api.raw as unknown as {
        getAvailableGifts?: () => Promise<{ gifts?: RawApiGift[] }>;
      };

      if (typeof rawApi.getAvailableGifts !== 'function') {
        console.warn('⚠️ [StoreTracker] getAvailableGifts is not available in this Bot API version.');
        return [];
      }

      const response = await rawApi.getAvailableGifts();
      return response?.gifts || [];
    } catch (err: any) {
      // If method is not supported or returns error, log friendly message
      if (err?.error_code === 400 || err?.description?.includes('METHOD_NOT_FOUND')) {
        console.warn('⚠️ [StoreTracker] getAvailableGifts method returned:', err?.description);
      } else {
        console.error('⚠️ [StoreTracker] API call failed:', err?.message || err);
      }
      return [];
    }
  }

  /**
   * Compare previous state with fresh API state and emit events
   */
  private async processGifts(rawGifts: RawApiGift[]): Promise<void> {
    const known = db.getKnownGifts();
    const isFirstRun = Object.keys(known).length === 0;
    const now = new Date().toISOString();

    for (const raw of rawGifts) {
      const giftId = raw.id.toString();
      const existing = known[giftId];
      const canUpgrade = typeof raw.upgrade_stars === 'number' && raw.upgrade_stars >= 0;

      const currentGift: TelegramGift = {
        id: giftId,
        stickerFileId: raw.sticker?.file_id,
        starCount: raw.star_count,
        totalCount: raw.total_count,
        remainingCount: raw.remaining_count,
        upgradeStars: raw.upgrade_stars,
        canUpgrade,
        firstSeenAt: existing?.firstSeenAt || now,
        lastUpdatedAt: now,
      };

      if (isFirstRun) {
        // Save initial state without broadcasting massive alerts
        db.setKnownGift(currentGift);
        continue;
      }

      // Check for changes
      if (!existing) {
        // Brand new gift added to Telegram store
        db.setKnownGift(currentGift);
        if (canUpgrade) {
          await this.emitEvent({
            type: 'NEW_UPGRADEABLE_GIFT',
            giftId,
            starCount: currentGift.starCount,
            newUpgradeStars: currentGift.upgradeStars,
            remainingCount: currentGift.remainingCount,
            totalCount: currentGift.totalCount,
            timestamp: now,
          }, currentGift);
        }
        continue;
      }

      // Check: Was upgrade just opened for an existing gift?
      if (!existing.canUpgrade && canUpgrade) {
        await this.emitEvent({
          type: 'UPGRADE_OPENED',
          giftId,
          starCount: currentGift.starCount,
          newUpgradeStars: currentGift.upgradeStars,
          remainingCount: currentGift.remainingCount,
          totalCount: currentGift.totalCount,
          timestamp: now,
        }, currentGift);
      }

      // Check: Did upgrade price change?
      if (
        existing.canUpgrade &&
        canUpgrade &&
        existing.upgradeStars !== currentGift.upgradeStars
      ) {
        await this.emitEvent({
          type: 'PRICE_CHANGED',
          giftId,
          starCount: currentGift.starCount,
          oldUpgradeStars: existing.upgradeStars,
          newUpgradeStars: currentGift.upgradeStars,
          remainingCount: currentGift.remainingCount,
          totalCount: currentGift.totalCount,
          timestamp: now,
        }, currentGift);
      }

      // Check: Low supply alert (< 5% left or < 100 left)
      if (
        canUpgrade &&
        currentGift.remainingCount !== undefined &&
        currentGift.totalCount !== undefined &&
        existing.remainingCount !== undefined
      ) {
        const threshold = Math.max(100, Math.floor(currentGift.totalCount * 0.05));
        if (existing.remainingCount > threshold && currentGift.remainingCount <= threshold && currentGift.remainingCount > 0) {
          await this.emitEvent({
            type: 'SUPPLY_LOW',
            giftId,
            starCount: currentGift.starCount,
            newUpgradeStars: currentGift.upgradeStars,
            remainingCount: currentGift.remainingCount,
            totalCount: currentGift.totalCount,
            timestamp: now,
          }, currentGift);
        }

        // Check: Sold out
        if (existing.remainingCount > 0 && currentGift.remainingCount === 0) {
          await this.emitEvent({
            type: 'SOLD_OUT',
            giftId,
            starCount: currentGift.starCount,
            remainingCount: 0,
            totalCount: currentGift.totalCount,
            timestamp: now,
          }, currentGift);
        }
      }

      // Update cached gift record
      db.setKnownGift(currentGift);
    }
  }

  private async emitEvent(event: GiftUpgradeEvent, gift: TelegramGift): Promise<void> {
    console.log(`🔔 [StoreTracker Event] ${event.type} for Gift #${event.giftId}`);
    for (const cb of this.onEventCallbacks) {
      try {
        await cb(event, gift);
      } catch (err) {
        console.error('❌ Error handling store upgrade event callback:', err);
      }
    }
  }
}

