import { UniqueCraftEvent } from '../types/gift.js';
import { UserSubscription } from '../types/user.js';

export function matchesCraftFilters(
  subscription: Pick<UserSubscription, 'onlyProfileUpgrades' | 'filterChannels' | 'filterGetgems' | 'minRarity'>,
  craft: Pick<UniqueCraftEvent, 'isUpgradedOnProfile' | 'ownerTelegramUsername' | 'isChannel' | 'isOnGetgems' | 'rarityLevel'>
): boolean {
  if (subscription.onlyProfileUpgrades !== false && !craft.isUpgradedOnProfile) {
    return false;
  }

  if (subscription.filterChannels === 'ONLY_USERS' && craft.isChannel) return false;
  if (subscription.filterChannels === 'ONLY_CHANNELS' && !craft.isChannel) return false;

  if (subscription.filterGetgems === 'EXCLUDE_GETGEMS' && craft.isOnGetgems) return false;
  if (subscription.filterGetgems === 'ONLY_GETGEMS' && !craft.isOnGetgems) return false;

  if (subscription.minRarity && subscription.minRarity !== 'ALL' && craft.rarityLevel) {
    const order = ['COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY'];
    const minimumIndex = order.indexOf(subscription.minRarity);
    const craftIndex = order.indexOf(craft.rarityLevel.toUpperCase());
    if (craftIndex < minimumIndex) return false;
  }

  return true;
}
