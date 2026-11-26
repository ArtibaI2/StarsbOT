import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../config/config.js';
import { matchesCraftFilters } from '../notifier/craftFilters.js';
import { hasPaidSubscriptionRecord, hasSubscriptionAccess, isAdmin } from '../storage/access.js';
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
  for (const id of [6965669923, 8230668674, 6175753245, ...config.ADMIN_IDS]) {
    assert.equal(isAdmin(id), true);
    assert.equal(hasSubscriptionAccess(id, true), true);
  }

  assert.equal(isAdmin(Number.MAX_SAFE_INTEGER), false);
  assert.equal(hasSubscriptionAccess(123456789, false), true);
  assert.equal(hasSubscriptionAccess(123456789, true), false);
  assert.equal(hasSubscriptionAccess(123456789, true, { subscriptionExpiresAt: 'forever' }), true);
  assert.equal(hasSubscriptionAccess(123456789, true, { subscriptionExpiresAt: '2020-01-01T00:00:00.000Z' }), false);
  assert.equal(hasSubscriptionAccess(123456789, true, { subscriptionExpiresAt: '2025-01-01T00:00:00.000Z' }, Date.parse('2024-01-01T00:00:00.000Z')), true);

  // Paid record check must stay false for non-subscribed users even when gate is disabled
  assert.equal(hasPaidSubscriptionRecord(undefined), false);
  assert.equal(hasPaidSubscriptionRecord({ isSubscribed: false, subscriptionExpiresAt: 'forever' }), false);
  assert.equal(hasPaidSubscriptionRecord({ isSubscribed: true, subscriptionExpiresAt: 'forever' }), true);
  assert.equal(
    hasPaidSubscriptionRecord({ isSubscribed: true, subscriptionExpiresAt: '2025-01-01T00:00:00.000Z' }, Date.parse('2024-01-01T00:00:00.000Z')),
    true
  );
  assert.equal(
    hasPaidSubscriptionRecord({ isSubscribed: true, subscriptionExpiresAt: '2020-01-01T00:00:00.000Z' }, Date.parse('2024-01-01T00:00:00.000Z')),
    false
  );
});

test('newest events are ordered first', () => {
  const ordered = newestFirst([{ timestamp: 10 }, { timestamp: 30 }, { timestamp: 20 }]);
  assert.deepEqual(ordered.map((event) => event.timestamp), [30, 20, 10]);
});

test('craft cursor only advances past fully processed events', async () => {
  const { nextCraftCursor } = await import('../trackers/craftCursor.js');

  assert.equal(nextCraftCursor(undefined, [], []), undefined);
  assert.equal(nextCraftCursor(100, [], []), 100, 'an empty page keeps the cursor');
  assert.equal(nextCraftCursor(undefined, [10, 20, 30], []), 30, 'a fresh stream starts at the newest event');
  assert.equal(nextCraftCursor(10, [20, 30], []), 30, 'the cursor advances to the newest fetched event');
  assert.equal(nextCraftCursor(50, [20, 30], []), 50, 'the cursor never moves backwards');
  assert.equal(nextCraftCursor(10, [20, 30], [20]), 10, 'a failure at the oldest fetched event pins the cursor');
  assert.equal(nextCraftCursor(10, [20, 30, 40], [40]), 30, 'the cursor stops just before the oldest failure');
  assert.equal(nextCraftCursor(10, [20, 30], [11]), 10, 'a failure older than the page still blocks progress');
});

test('onlyProfileUpgrades filter rejects non-profile when enabled and allows when disabled', () => {
  const nonProfile = { ...craft, isUpgradedOnProfile: false, ownerTelegramUsername: undefined };
  assert.equal(matchesCraftFilters({ onlyProfileUpgrades: true }, nonProfile), false);
  assert.equal(matchesCraftFilters({ onlyProfileUpgrades: undefined }, nonProfile), false);
  assert.equal(matchesCraftFilters({ onlyProfileUpgrades: false }, nonProfile), true);
  assert.equal(matchesCraftFilters({ onlyProfileUpgrades: true }, { ...craft, isUpgradedOnProfile: true }), true);
});

test('SendPacer serializes sends and never overlaps them', async () => {
  const { SendPacer } = await import('../notifier/sendPacer.js');
  const pacer = new SendPacer(10);
  const order: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const run = (id: number) =>
    pacer.run(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(id);
      inFlight--;
    });

  await Promise.all([run(1), run(2), run(3)]);

  assert.deepEqual(order, [1, 2, 3], 'Sends must run in FIFO order');
  assert.equal(maxInFlight, 1, 'At most one send may be in flight at a time');
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

test('listing messages escape untrusted marketplace metadata', async () => {
  const { Notifier } = await import('../notifier/notifier.js');
  const notifier = new Notifier({} as any);

  const listing: any = {
    id: 'listing_test',
    giftId: 'valentine_box',
    giftTitle: '<b>Evil</b> & Co',
    num: 7,
    modelName: '<script>x</script>',
    backdropName: 'A & B',
    symbolName: '<i>s</i>',
    description: '<img src=x onerror=alert(1)>',
    priceTon: 12.5,
    platformName: 'MRKT <b>',
    platformUrl: 'https://t.me/mrkt',
    sellerName: '@bad name',
    sellerAddress: 'EQDc08YxzZWtlKAohSybNc3kXAkAPPtHch-jY_E6KMQ3b1mn',
    timestamp: new Date().toISOString(),
  };

  const text = notifier.formatListingMessage(listing);
  assert.ok(!text.includes('<script>'), 'Raw script tag leaked into the listing message');
  assert.ok(text.includes('&lt;script&gt;x&lt;/script&gt;'), 'Model must be escaped');
  assert.ok(text.includes('&lt;b&gt;Evil&lt;/b&gt; &amp; Co'), 'Title must be escaped');
  assert.ok(text.includes('A &amp; B'), 'Backdrop must be escaped');
  assert.ok(!text.includes('onerror=alert(1)>'), 'Description markup must be escaped');
});

test('listing keyboard never links to an invalid t.me/nft collection id', async () => {
  const { Notifier } = await import('../notifier/notifier.js');
  const notifier = new Notifier({} as any);

  const base: any = {
    id: 'listing_test',
    giftId: 'valentine_box',
    giftTitle: 'Valentine Box',
    num: 7,
    modelName: 'Classic',
    priceTon: 12.5,
    platformName: 'MRKT',
    platformUrl: 'https://t.me/mrkt',
    timestamp: new Date().toISOString(),
  };

  const withoutSlug = notifier.buildListingKeyboard(base);
  const withoutSlugUrls = withoutSlug.inline_keyboard.flat().map((b) => (b as any).url);
  assert.ok(
    !withoutSlugUrls.some((u) => typeof u === 'string' && u.includes('t.me/nft/valentine_box')),
    'A collection id must not be used as an NFT slug'
  );

  const withSlug = notifier.buildListingKeyboard({
    ...base,
    telegramNftUrl: 'https://t.me/nft/plushpepe-1330',
  });
  const withSlugUrls = withSlug.inline_keyboard.flat().map((b) => (b as any).url);
  assert.ok(withSlugUrls.includes('https://t.me/nft/plushpepe-1330'));
});

test('parseRetryAfter handles seconds, HTTP dates and invalid values', async () => {
  const { parseRetryAfter } = await import('../trackers/mrktHarvester.js');

  assert.equal(parseRetryAfter('5'), 5000);
  assert.equal(parseRetryAfter('0'), 0);
  assert.equal(parseRetryAfter(undefined), null);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter('not-a-date'), null);
  assert.equal(parseRetryAfter('999'), 120_000, 'Retry-After must be capped at 120s');

  const future = new Date(Date.now() + 5000).toUTCString();
  const parsed = parseRetryAfter(future);
  assert.ok(parsed !== null && parsed > 0 && parsed <= 120_000);
});

test('gift slug candidates recover on-chain collection name typos', async () => {
  const { giftSlugCandidates, normalizeGiftSlug } = await import('../trackers/giftSlug.js');

  assert.equal(normalizeGiftSlug('Joyful Bundle'), 'joyfulbundle');
  assert.equal(normalizeGiftSlug('Snoop Cigar'), 'snoopcigar');
  assert.equal(normalizeGiftSlug('Telegram Gift'), 'telegramgift');

  assert.deepEqual(
    giftSlugCandidates('joyfullbundle-5831', 'Joyful Bundle'),
    ['joyfullbundle-5831', 'joyfulbundle-5831'],
    'The raw token name is tried first, then the normalized collection slug'
  );
  assert.deepEqual(
    giftSlugCandidates('plushpepe-1330', 'Plush Pepe'),
    ['plushpepe-1330'],
    'Well-formed token names must not produce duplicate candidates'
  );
  assert.deepEqual(
    giftSlugCandidates('unknown-1', 'Telegram Gift'),
    ['unknown-1'],
    'The generic fallback collection must not be used as a slug'
  );
});

test('StoreUpgradeTracker reads official Bot API upgrade_star_count field', async () => {
  const { mapRawGiftToTelegramGift } = await import('../trackers/storeUpgradeTracker.js');

  const botApiGift = mapRawGiftToTelegramGift(
    { id: '123', star_count: 50, upgrade_star_count: 25, total_count: 1000, remaining_count: 400 },
    undefined,
    '2026-01-01T00:00:00.000Z'
  );
  assert.equal(botApiGift.canUpgrade, true);
  assert.equal(botApiGift.upgradeStars, 25);

  const nonUpgradeable = mapRawGiftToTelegramGift(
    { id: '124', star_count: 15 },
    undefined,
    '2026-01-01T00:00:00.000Z'
  );
  assert.equal(nonUpgradeable.canUpgrade, false);
  assert.equal(nonUpgradeable.upgradeStars, undefined);
});
