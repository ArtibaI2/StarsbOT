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

test('onlyProfileUpgrades filter rejects gifts not on profile', () => {
  assert.equal(matchesCraftFilters({ onlyProfileUpgrades: true }, { ...craft, isUpgradedOnProfile: false, ownerTelegramUsername: undefined }), false);
  assert.equal(matchesCraftFilters({ onlyProfileUpgrades: true }, { ...craft, isUpgradedOnProfile: true }), true);
});

test('validateProfileGift strictly rejects sold, blockchain-exported, and marketplace gifts', async () => {
  const { validateProfileGift } = await import('../trackers/profileValidator.js');

  // skystilettos-32812 was exported to capitulation.ton and listed on Fragment
  const skyRes = await validateProfileGift('skystilettos-32812');
  assert.equal(skyRes.isProfileActive, false, 'skystilettos-32812 must be rejected because it is on blockchain/Fragment');

  // miragelamp-52415 is sold to a TON wallet
  const lampRes = await validateProfileGift('miragelamp-52415');
  assert.equal(lampRes.isProfileActive, false, 'miragelamp-52415 must be rejected because it is sold to a wallet');
});

test('buildCraftKeyboard never produces BUTTON_USER_INVALID and formats links correctly', async () => {
  const { Notifier } = await import('../notifier/notifier.js');
  const notifier = new Notifier({} as any);

  // Case 1: Owner has a public username
  const craftWithUser: any = {
    giftId: 'skystilettos-100',
    giftTitle: 'Sky Stilettos',
    num: 100,
    ownerTelegramUsername: 'alice_buyer',
    ownerName: 'Alice',
    telegramNftUrl: 'https://t.me/nft/skystilettos-100',
  };
  const kb1 = notifier.buildCraftKeyboard(craftWithUser);
  const rows1 = kb1.inline_keyboard;
  assert.ok(rows1.length >= 2, 'Should have multiple rows for user with username');
  assert.match((rows1[0][0] as any).url, /^https:\/\/t\.me\/alice_buyer\?text=/, 'Direct message link should lead to user dm');
  assert.equal((rows1[1][0] as any).url, 'https://t.me/nft/skystilettos-100');

  // Case 2: Owner has NO username (first name only, like "Иван")
  const craftNoUser: any = {
    giftId: 'skystilettos-32812',
    giftTitle: 'Sky Stilettos',
    num: 32812,
    ownerTelegramUsername: undefined,
    ownerName: 'Иван',
    telegramNftUrl: 'https://t.me/nft/skystilettos-32812',
  };
  const kb2 = notifier.buildCraftKeyboard(craftNoUser);
  const rows2 = kb2.inline_keyboard;
  assert.ok(rows2.length >= 2, 'Should have rows including profile and marketplaces');
  assert.equal((rows2[0][0] as any).url, 'https://t.me/nft/skystilettos-32812');

  // In ALL cases: NO button must ever use tg://user?id= (which Telegram rejects with 400 Bad Request: BUTTON_USER_INVALID)
  for (const row of [...rows1, ...rows2]) {
    for (const btn of row) {
      const url = (btn as any).url;
      assert.ok(!url?.startsWith('tg://user'), `Forbidden tg://user found in button: ${url}`);
    }
  }
});

test('formatCraftMessage escapes special characters and preserves HTML tags safely', async () => {
  const { Notifier } = await import('../notifier/notifier.js');
  const notifier = new Notifier({} as any);

  const craftWithHtml: any = {
    id: 'upgrade_test',
    giftId: 'test-1',
    giftTitle: '<Dangerous Gift & Co>',
    num: 1,
    modelName: '<b>HackerModel</b>',
    description: 'Special <tag> & symbols',
    ownerName: '<script>alert(1)</script>',
    marketStatus: 'ON_PROFILE',
    timestamp: new Date().toISOString(),
  };

  const message = notifier.formatCraftMessage(craftWithHtml);
  assert.ok(!message.includes('<script>'), 'Unescaped script tag found');
  assert.ok(message.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'Script tag must be safely escaped');
  assert.ok(message.includes('&lt;Dangerous Gift &amp; Co&gt;'), 'Title must be safely escaped');
  assert.ok(message.includes('👤 Находится в профиле Telegram'), 'Status must indicate profile');
});
