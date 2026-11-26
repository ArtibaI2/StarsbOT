import { config } from '../config/config.js';
import { UserSubscription } from '../types/user.js';

const DEFAULT_ADMIN_IDS = [6965669923, 8230668674, 6175753245];
export const ADMIN_IDS = Array.from(new Set([...DEFAULT_ADMIN_IDS, ...config.ADMIN_IDS]));

export function isAdmin(userId?: number | string): boolean {
  if (!userId) return false;
  return ADMIN_IDS.includes(Number(userId));
}

/**
 * Checks whether a user explicitly holds an active granted/paid subscription
 * record, independent of whether the global subscription gate is enabled.
 */
export function hasPaidSubscriptionRecord(
  subscriber?: Pick<UserSubscription, 'isSubscribed' | 'subscriptionExpiresAt'>,
  now = Date.now()
): boolean {
  if (!subscriber || subscriber.isSubscribed === false) return false;
  if (subscriber.subscriptionExpiresAt === 'forever') return true;
  if (!subscriber.subscriptionExpiresAt) return false;

  const expiresAtMs = new Date(subscriber.subscriptionExpiresAt).getTime();
  return Number.isFinite(expiresAtMs) && expiresAtMs > now;
}

export function hasSubscriptionAccess(
  chatId: number,
  systemEnabled: boolean,
  subscriber?: Pick<UserSubscription, 'isSubscribed' | 'subscriptionExpiresAt'>,
  now = Date.now()
): boolean {
  if (isAdmin(chatId)) return true;
  if (!systemEnabled) return true;
  return hasPaidSubscriptionRecord(subscriber, now);
}
