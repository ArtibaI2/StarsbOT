export interface UserSubscription {
  chatId: number;
  userId: number;
  username?: string;
  firstName?: string;
  notifyUpgrades: boolean;      // Отслеживание открытия возможности апгрейда и цен
  notifyCrafts: boolean;        // Отслеживание потока скрафченных/улучшенных подарков
  notifyListings: boolean;      // Отслеживание подарков, выставленных на продажу
  onlyProfileUpgrades?: boolean; // Присылать только подарки, улучшенные в профиле (с ником)
  maxListingPriceTon?: number;  // Фильтр: оповещать если цена <= maxListingPriceTon (undefined = без ограничений)
  minRarity?: 'ALL' | 'UNCOMMON' | 'RARE' | 'EPIC' | 'LEGENDARY';
  createdAt: string;
  updatedAt: string;
  isBlocked: boolean;           // Флаг если пользователь заблокировал бота
}

export interface BotStatistics {
  totalSubscribers: number;
  activeUpgradesSubscribers: number;
  activeCraftsSubscribers: number;
  activeListingsSubscribers: number;
  totalUpgradeEventsSent: number;
  totalCraftEventsSent: number;
  totalListingEventsSent: number;
  botStartedAt: string;
  lastStoreCheckAt?: string;
  lastCraftCheckAt?: string;
  lastListingCheckAt?: string;
}
