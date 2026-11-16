import fs from 'fs';
import path from 'path';
import { UserSubscription, BotStatistics } from '../types/user.js';
import { TelegramGift } from '../types/gift.js';
import { resolvedDataDir } from '../config/config.js';
import { hasSubscriptionAccess, isAdmin } from './access.js';
export { ADMIN_IDS, isAdmin } from './access.js';

interface DatabaseSchema {
  subscribers: Record<string, UserSubscription>;
  knownGifts: Record<string, TelegramGift>;
  seenCraftIds: string[]; // Store last N seen craft unique IDs
  seenListingIds: string[]; // Store last N seen sale listing IDs
  isCraftBaselineInitialized?: boolean;
  isListingBaselineInitialized?: boolean;
  subscriptionSystemEnabled?: boolean; // Global subscription mode toggle
  walletMappings?: Record<string, { username: string; source: string; updatedAt: string }>;
  stats: {
    totalUpgradeEventsSent: number;
    totalCraftEventsSent: number;
    totalListingEventsSent: number;
    botStartedAt: string;
    lastStoreCheckAt?: string;
    lastCraftCheckAt?: string;
    lastListingCheckAt?: string;
  };
}

const DEFAULT_DB: DatabaseSchema = {
  subscribers: {},
  knownGifts: {},
  seenCraftIds: [],
  seenListingIds: [],
  isCraftBaselineInitialized: false,
  isListingBaselineInitialized: false,
  subscriptionSystemEnabled: false,
  walletMappings: {},
  stats: {
    totalUpgradeEventsSent: 0,
    totalCraftEventsSent: 0,
    totalListingEventsSent: 0,
    botStartedAt: new Date().toISOString(),
  },
};

export class Database {
  private filePath: string;
  private data: DatabaseSchema;
  private saveTimeout: NodeJS.Timeout | null = null;

  constructor() {
    if (!fs.existsSync(resolvedDataDir)) {
      fs.mkdirSync(resolvedDataDir, { recursive: true });
    }
    this.filePath = path.join(resolvedDataDir, 'bot_data.json');
    this.data = this.load();
  }

  private load(): DatabaseSchema {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        return {
          ...DEFAULT_DB,
          ...parsed,
          subscribers: parsed.subscribers || {},
          knownGifts: parsed.knownGifts || {},
          seenCraftIds: parsed.seenCraftIds || [],
          seenListingIds: parsed.seenListingIds || [],
          subscriptionSystemEnabled: Boolean(parsed.subscriptionSystemEnabled),
          stats: {
            ...DEFAULT_DB.stats,
            ...(parsed.stats || {}),
          },
        };
      }
    } catch (err) {
      console.error('⚠️ Failed to read data file, fallback to empty data:', err);
    }
    return JSON.parse(JSON.stringify(DEFAULT_DB));
  }

  /**
   * Save database atomically using temp file and rename
   */
  public saveSync(): void {
    try {
      const tempPath = `${this.filePath}.tmp.${Date.now()}`;
      fs.writeFileSync(tempPath, JSON.stringify(this.data, null, 2), 'utf-8');
      fs.renameSync(tempPath, this.filePath);
    } catch (err) {
      console.error('❌ Error saving database:', err);
    }
  }

  /**
   * Debounced asynchronous save
   */
  public scheduleSave(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
    this.saveTimeout = setTimeout(() => {
      this.saveSync();
      this.saveTimeout = null;
    }, 500);
  }

  // --- Subscription System & Access Control ---

  public isSubscriptionSystemEnabled(): boolean {
    return Boolean(this.data.subscriptionSystemEnabled);
  }

  public setSubscriptionSystemEnabled(enabled: boolean): void {
    this.data.subscriptionSystemEnabled = enabled;
    this.scheduleSave();
  }

  public hasActiveSubscription(chatId: number): boolean {
    return hasSubscriptionAccess(
      chatId,
      Boolean(this.data.subscriptionSystemEnabled),
      this.data.subscribers[chatId.toString()]
    );
  }

  public grantSubscription(chatId: number, durationDays?: number): void {
    const key = chatId.toString();
    let expiresAt: string;
    if (!durationDays || durationDays <= 0) {
      expiresAt = 'forever';
    } else {
      const curExp = this.data.subscribers[key]?.subscriptionExpiresAt;
      const base = (curExp && curExp !== 'forever' && new Date(curExp).getTime() > Date.now())
        ? new Date(curExp).getTime()
        : Date.now();
      expiresAt = new Date(base + durationDays * 24 * 60 * 60 * 1000).toISOString();
    }

    if (this.data.subscribers[key]) {
      this.data.subscribers[key].isSubscribed = true;
      this.data.subscribers[key].subscriptionExpiresAt = expiresAt;
      this.data.subscribers[key].updatedAt = new Date().toISOString();
    } else {
      this.data.subscribers[key] = {
        chatId,
        userId: chatId,
        notifyUpgrades: true,
        notifyCrafts: true,
        notifyListings: false,
        onlyProfileUpgrades: true,
        isSubscribed: true,
        subscriptionExpiresAt: expiresAt,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        isBlocked: false,
      };
    }
    this.scheduleSave();
  }

  public revokeSubscription(chatId: number): void {
    const key = chatId.toString();
    if (this.data.subscribers[key]) {
      this.data.subscribers[key].isSubscribed = false;
      delete this.data.subscribers[key].subscriptionExpiresAt;
      this.data.subscribers[key].updatedAt = new Date().toISOString();
      this.scheduleSave();
    }
  }

  // --- Subscribers ---

  public getSubscriber(chatId: number): UserSubscription | undefined {
    return this.data.subscribers[chatId.toString()];
  }

  public getAllSubscribers(): UserSubscription[] {
    return Object.values(this.data.subscribers);
  }

  public upsertSubscriber(sub: Omit<UserSubscription, 'createdAt' | 'updatedAt' | 'isBlocked'>): UserSubscription {
    const key = sub.chatId.toString();
    const existing = this.data.subscribers[key];
    const now = new Date().toISOString();

    const updated: UserSubscription = {
      ...(existing || {
        createdAt: now,
        notifyUpgrades: true,
        notifyCrafts: true,
        notifyListings: true,
        onlyProfileUpgrades: true,
        filterChannels: 'ALL',
        filterGetgems: 'ALL',
        maxListingPriceTon: undefined,
        minRarity: 'ALL',
        isBlocked: false,
      }),
      ...sub,
      updatedAt: now,
      isBlocked: false,
    };

    this.data.subscribers[key] = updated;
    this.scheduleSave();
    return updated;
  }

  public updatePreferences(
    chatId: number,
    partial: Partial<Pick<UserSubscription, 'notifyUpgrades' | 'notifyCrafts' | 'notifyListings' | 'onlyProfileUpgrades' | 'filterChannels' | 'filterGetgems' | 'maxListingPriceTon' | 'minRarity'>>
  ): UserSubscription | undefined {
    const key = chatId.toString();
    const existing = this.data.subscribers[key];
    if (!existing) return undefined;

    Object.assign(existing, partial, { updatedAt: new Date().toISOString() });
    this.scheduleSave();
    return existing;
  }

  public markBlocked(chatId: number): void {
    const key = chatId.toString();
    if (this.data.subscribers[key]) {
      this.data.subscribers[key].isBlocked = true;
      this.data.subscribers[key].updatedAt = new Date().toISOString();
      this.scheduleSave();
    }
  }

  public getActiveSubscribers(type?: 'upgrades' | 'crafts' | 'listings'): UserSubscription[] {
    const all = Object.values(this.data.subscribers).filter((s) => !s.isBlocked);
    const subFiltered = this.data.subscriptionSystemEnabled
      ? all.filter((s) => this.hasActiveSubscription(s.chatId))
      : all;

    if (type === 'upgrades') {
      return subFiltered.filter((s) => s.notifyUpgrades);
    }
    if (type === 'crafts') {
      return subFiltered.filter((s) => s.notifyCrafts);
    }
    if (type === 'listings') {
      return subFiltered.filter((s) => s.notifyListings);
    }
    return subFiltered;
  }

  public hasActiveGetgemsFilters(): boolean {
    return this.getActiveSubscribers('crafts').some(
      (subscriber) => subscriber.filterGetgems === 'EXCLUDE_GETGEMS' || subscriber.filterGetgems === 'ONLY_GETGEMS'
    );
  }

  // --- Known Gifts Cache ---

  public getKnownGifts(): Record<string, TelegramGift> {
    return this.data.knownGifts;
  }

  public getKnownGift(id: string): TelegramGift | undefined {
    return this.data.knownGifts[id];
  }

  public setKnownGift(gift: TelegramGift): void {
    this.data.knownGifts[gift.id] = gift;
    this.scheduleSave();
  }

  public setAllKnownGifts(gifts: Record<string, TelegramGift>): void {
    this.data.knownGifts = gifts;
    this.scheduleSave();
  }

  // --- Seen Unique Crafts (Deduplication) ---

  public isCraftSeen(craftId: string): boolean {
    return this.data.seenCraftIds.includes(craftId);
  }

  public isCraftBaselineSet(): boolean {
    return Boolean(this.data.isCraftBaselineInitialized);
  }

  public setCraftBaseline(): void {
    this.data.isCraftBaselineInitialized = true;
    this.scheduleSave();
  }

  public markCraftSeen(craftId: string): void {
    if (!this.data.seenCraftIds.includes(craftId)) {
      this.data.seenCraftIds.push(craftId);
      if (this.data.seenCraftIds.length > 15000) {
        this.data.seenCraftIds = this.data.seenCraftIds.slice(-10000);
      }
      this.scheduleSave();
    }
  }

  // --- Seen Listings (Deduplication) ---

  public isListingSeen(listingId: string): boolean {
    return this.data.seenListingIds.includes(listingId);
  }

  public isListingBaselineSet(): boolean {
    return Boolean(this.data.isListingBaselineInitialized);
  }

  public setListingBaseline(): void {
    this.data.isListingBaselineInitialized = true;
    this.scheduleSave();
  }

  public markListingSeen(listingId: string): void {
    if (!this.data.seenListingIds.includes(listingId)) {
      this.data.seenListingIds.push(listingId);
      if (this.data.seenListingIds.length > 10000) {
        this.data.seenListingIds = this.data.seenListingIds.slice(-8000);
      }
      this.scheduleSave();
    }
  }

  // --- Wallet Mappings (OSINT / Cache) ---

  public getWalletUsername(address: string): string | undefined {
    if (!address || !this.data.walletMappings) return undefined;
    const clean = address.trim().toLowerCase();
    return this.data.walletMappings[clean]?.username;
  }

  public setWalletUsername(address: string, username: string, source: string): void {
    if (!address || !username) return;
    const clean = address.trim().toLowerCase();
    const cleanUsername = username.replace(/^@/, '').trim();
    if (!cleanUsername) return;

    if (!this.data.walletMappings) {
      this.data.walletMappings = {};
    }
    this.data.walletMappings[clean] = {
      username: cleanUsername,
      source,
      updatedAt: new Date().toISOString(),
    };
    this.scheduleSave();
  }

  // --- Statistics ---

  public incrementSentStats(type: 'upgrades' | 'crafts' | 'listings', count = 1): void {
    if (type === 'upgrades') {
      this.data.stats.totalUpgradeEventsSent += count;
    } else if (type === 'crafts') {
      this.data.stats.totalCraftEventsSent += count;
    } else {
      this.data.stats.totalListingEventsSent += count;
    }
    this.scheduleSave();
  }

  public updateLastCheck(type: 'store' | 'craft' | 'listing'): void {
    const now = new Date().toISOString();
    if (type === 'store') {
      this.data.stats.lastStoreCheckAt = now;
    } else if (type === 'craft') {
      this.data.stats.lastCraftCheckAt = now;
    } else {
      this.data.stats.lastListingCheckAt = now;
    }
  }

  public getStatistics(): BotStatistics {
    const subs = Object.values(this.data.subscribers);
    const active = subs.filter((s) => !s.isBlocked);
    const paid = subs.filter((s) => this.hasActiveSubscription(s.chatId) && !isAdmin(s.chatId));

    return {
      totalSubscribers: subs.length,
      activeSubscribersCount: active.length,
      paidSubscribersCount: paid.length,
      subscriptionSystemEnabled: Boolean(this.data.subscriptionSystemEnabled),
      activeUpgradesSubscribers: active.filter((s) => s.notifyUpgrades).length,
      activeCraftsSubscribers: active.filter((s) => s.notifyCrafts).length,
      activeListingsSubscribers: active.filter((s) => s.notifyListings).length,
      totalUpgradeEventsSent: this.data.stats.totalUpgradeEventsSent,
      totalCraftEventsSent: this.data.stats.totalCraftEventsSent,
      totalListingEventsSent: this.data.stats.totalListingEventsSent,
      botStartedAt: this.data.stats.botStartedAt,
      lastStoreCheckAt: this.data.stats.lastStoreCheckAt,
      lastCraftCheckAt: this.data.stats.lastCraftCheckAt,
      lastListingCheckAt: this.data.stats.lastListingCheckAt,
    };
  }
}

export const db = new Database();
