export interface TelegramGift {
  id: string;
  stickerFileId?: string;
  starCount: number;
  totalCount?: number;
  remainingCount?: number;
  upgradeStars?: number;
  canUpgrade: boolean;
  firstSeenAt: string;
  lastUpdatedAt: string;
}

export interface GiftUpgradeEvent {
  type: 'UPGRADE_OPENED' | 'NEW_UPGRADEABLE_GIFT' | 'PRICE_CHANGED' | 'SUPPLY_LOW' | 'SOLD_OUT';
  giftId: string;
  starCount: number;
  oldUpgradeStars?: number;
  newUpgradeStars?: number;
  remainingCount?: number;
  totalCount?: number;
  title?: string;
  timestamp: string;
}

export interface UniqueGiftAttribute {
  name: string;
  value: string;
  rarityPercent?: number;
}

export interface UniqueCraftEvent {
  id: string; // unique ID or hash
  giftId: string;
  giftTitle: string;
  num: number; // e.g. 1330
  modelName: string;
  backdropName?: string;
  symbolName?: string;
  rarityLevel?: 'Common' | 'Uncommon' | 'Rare' | 'Epic' | 'Legendary';
  rarityPercent?: number;
  
  // Внешний вид
  imageUrl?: string;
  lottieUrl?: string;
  description?: string;

  // Ник человека, который улучшил
  ownerName?: string;
  ownerAddress?: string;
  ownerTelegramUsername?: string; // Прямой юзернейм для написания в ЛС
  ownerTelegramUserId?: number;   // Числовой Telegram ID владельца
  isUpgradedOnProfile?: boolean; // Улучшен в профиле (есть прямой ник/контакт)
  isChannel?: boolean;           // Улучшен каналом Telegram (а не личным профилем человека)
  isOnGetgems?: boolean;         // Находится на портале / маркетплейсе Getgems

  // Статус и свежесть
  ageSec?: number;
  marketStatus?: 'FOR_SALE' | 'ON_PROFILE' | 'JUST_MINTED';
  salePriceTon?: number;

  // Ссылки на все доступные платформы
  platformName: string;
  platformUrl: string;
  telegramNftUrl?: string; // Прямая ссылка t.me/nft/... для открытия профиля владельца в Telegram
  fragmentUrl?: string;    // Платформа Fragment (fragment.com)
  mrktUrl?: string;        // Платформа MRKT / МКТ (t.me/mrkt)
  getgemsUrl?: string;     // Платформа Getgems (getgems.io)
  tonviewerUrl?: string;   // Эксплорер Tonviewer (tonviewer.com)
  
  timestamp: string;
}

export interface GiftListingEvent {
  id: string; // unique listing ID
  giftId: string;
  giftTitle: string;
  num: number;
  modelName: string;
  backdropName?: string;
  symbolName?: string;
  rarityLevel?: 'Common' | 'Uncommon' | 'Rare' | 'Epic' | 'Legendary';
  description?: string;
  imageUrl?: string;

  // Цена продажи
  priceTon: number;
  priceUsd?: number;

  // Платформа (MRKT, Fragment, Getgems и т.д.)
  platformName: string;
  platformUrl: string;
  telegramNftUrl?: string; // Прямая ссылка t.me/nft/...

  // Продавец
  sellerName?: string;
  sellerAddress?: string;
  sellerTelegramUsername?: string; // Прямой юзернейм для написания продавцу в ЛС

  timestamp: string;
}
