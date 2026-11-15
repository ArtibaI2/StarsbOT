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
  
  // Система платных подписок
  isSubscribed?: boolean;
  subscriptionExpiresAt?: string; // ISO дата окончания или 'forever'

  // Фильтры
  filterChannels?: 'ALL' | 'ONLY_USERS' | 'ONLY_CHANNELS'; // Фильтр каналов
  filterGetgems?: 'ALL' | 'EXCLUDE_GETGEMS' | 'ONLY_GETGEMS'; // Фильтр портала Getgems

  createdAt: string;
  updatedAt: string;
  isBlocked: boolean;           // Флаг если пользователь заблокировал бота
}

export interface BotStatistics {
  totalSubscribers: number;
  activeSubscribersCount: number;
  paidSubscribersCount: number;
  subscriptionSystemEnabled: boolean;
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
