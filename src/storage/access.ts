import { UserSubscription } from '../types/user.js';

export const ADMIN_IDS = [6965669923, 8230668674, 6175753245];

export function isAdmin(userId?: number | string): boolean {
  if (!userId) return false;
  return ADMIN_IDS.includes(Number(userId));
}

export function hasSubscriptionAccess(
  chatId: number,
  systemEnabled: boolean,
  subscriber?: Pick<UserSubscription, 'subscriptionExpiresAt'>,
  now = Date.now()
): boolean {
  if (isAdmin(chatId)) return true;
  if (!systemEnabled) return true;
  if (!subscriber) return false;
  if (subscriber.subscriptionExpiresAt === 'forever') return true;
  if (!subscriber.subscriptionExpiresAt) return false;

  return new Date(subscriber.subscriptionExpiresAt).getTime() > now;
}
