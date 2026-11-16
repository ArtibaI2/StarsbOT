import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesCraftFilters } from '../notifier/craftFilters.js';
import { hasSubscriptionAccess, isAdmin } from '../storage/access.js';
import { isGetgemsSale, newestFirst } from '../trackers/marketplace.js';

const craft = {
  isUpgradedOnProfile: true,
  ownerTelegramUsername: 'gift_owner',
  isChannel: false,
  isOnGetgems: false,
  rarityLevel: 'Rare' as const,
};

test('channel filter accepts only the selected profile kind', () => {
  assert.equal(matchesCraftFilters({ onlyProfileUpgrades: false, filterChannels: 'ONLY_USERS' }, craft), true);
  assert.equal(matchesCraftFilters({ onlyProfileUpgrades: false, filterChannels: 'ONLY_CHANNELS' }, craft), false);
  assert.equal(matchesCraftFilters(
    { onlyProfileUpgrades: false, filterChannels: 'ONLY_CHANNELS' },
    { ...craft, isChannel: true }
  ), true);
});

test('Getgems filter includes or excludes portal listings', () => {
  assert.equal(matchesCraftFilters({ onlyProfileUpgrades: false, filterGetgems: 'ONLY_GETGEMS' }, { ...craft, isOnGetgems: true }), true);
  assert.equal(matchesCraftFilters({ onlyProfileUpgrades: false, filterGetgems: 'ONLY_GETGEMS' }, craft), false);
  assert.equal(matchesCraftFilters({ onlyProfileUpgrades: false, filterGetgems: 'EXCLUDE_GETGEMS' }, { ...craft, isOnGetgems: true }), false);
  assert.equal(isGetgemsSale({ sale: { market: { name: 'Getgems' } } }), true);
  assert.equal(isGetgemsSale({ sale: { market: { name: 'Fragment' } } }), false);
  assert.equal(isGetgemsSale({ sale: null }), false);
});

test('admins and subscription mode enforce access as configured', () => {
  for (const id of [6965669923, 8230668674, 6175753245]) {
    assert.equal(isAdmin(id), true);
    assert.equal(hasSubscriptionAccess(id, true), true);
  }

  assert.equal(isAdmin(123456789), false);
  assert.equal(hasSubscriptionAccess(123456789, false), true);
  assert.equal(hasSubscriptionAccess(123456789, true), false);
  assert.equal(hasSubscriptionAccess(123456789, true, { subscriptionExpiresAt: 'forever' }), true);
  assert.equal(hasSubscriptionAccess(123456789, true, { subscriptionExpiresAt: '2020-01-01T00:00:00.000Z' }), false);
  assert.equal(hasSubscriptionAccess(123456789, true, { subscriptionExpiresAt: '2025-01-01T00:00:00.000Z' }, Date.parse('2024-01-01T00:00:00.000Z')), true);
});

test('newest events are ordered first', () => {
  const ordered = newestFirst([{ timestamp: 10 }, { timestamp: 30 }, { timestamp: 20 }]);
  assert.deepEqual(ordered.map((event) => event.timestamp), [30, 20, 10]);
});
