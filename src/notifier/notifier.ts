import { Bot, InlineKeyboard } from 'grammy';
import { db } from '../storage/database.js';
import { GiftListingEvent, GiftUpgradeEvent, TelegramGift, UniqueCraftEvent } from '../types/gift.js';

export class Notifier {
  private bot: Bot;

  constructor(bot: Bot) {
    this.bot = bot;
  }

  /**
   * Broadcast gift upgrade availability alert to subscribers
   */
  public async broadcastUpgradeEvent(event: GiftUpgradeEvent, gift: TelegramGift): Promise<void> {
    const subscribers = db.getActiveSubscribers('upgrades');
    if (subscribers.length === 0) return;

    const text = this.formatUpgradeMessage(event, gift);
    const keyboard = this.buildUpgradeKeyboard(event, gift);

    let sentCount = 0;
    for (const sub of subscribers) {
      const ok = await this.sendSafeMessage(sub.chatId, text, keyboard);
      if (ok) sentCount++;
      // Polite rate limit ~35 ms delay
      await new Promise((r) => setTimeout(r, 35));
    }

    db.incrementSentStats('upgrades', sentCount);
  }

  /**
   * Broadcast crafted unique gift alert to subscribers
   */
  public async broadcastCraftEvent(craft: UniqueCraftEvent): Promise<void> {
    const subscribers = db.getActiveSubscribers('crafts');
    if (subscribers.length === 0) return;

    const text = this.formatCraftMessage(craft);
    const keyboard = this.buildCraftKeyboard(craft);

    let sentCount = 0;
    for (const sub of subscribers) {
      // Check if user wants only gifts upgraded on profile (with username/contact)
      if (sub.onlyProfileUpgrades !== false && !craft.isUpgradedOnProfile && !craft.ownerTelegramUsername) {
        continue; // Filter out blind / anonymous blockchain-only exports
      }

      // Check channel filter (channels vs personal profiles)
      if (sub.filterChannels === 'ONLY_USERS' && craft.isChannel) {
        continue; // Filtered out: user only wants personal user profiles
      }
      if (sub.filterChannels === 'ONLY_CHANNELS' && !craft.isChannel) {
        continue; // Filtered out: user only wants channels
      }

      // Check Getgems portal filter
      if (sub.filterGetgems === 'EXCLUDE_GETGEMS' && craft.isOnGetgems) {
        continue; // Filtered out: user excludes Getgems portal
      }
      if (sub.filterGetgems === 'ONLY_GETGEMS' && !craft.isOnGetgems) {
        continue; // Filtered out: user only wants Getgems portal
      }

      // Check user's rarity filter
      if (sub.minRarity && sub.minRarity !== 'ALL' && craft.rarityLevel) {
        const order = ['COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY'];
        const userMinIdx = order.indexOf(sub.minRarity);
        const craftIdx = order.indexOf(craft.rarityLevel.toUpperCase());
        if (craftIdx < userMinIdx) {
          continue; // Filtered out by user preferences
        }
      }

      const ok = await this.sendSafePhotoOrMessage(sub.chatId, craft.imageUrl, text, keyboard);
      if (ok) sentCount++;
      await new Promise((r) => setTimeout(r, 35));
    }

    db.incrementSentStats('crafts', sentCount);
  }

  /**
   * Broadcast gift sale listing alert to subscribers with price filter
   */
  public async broadcastListingEvent(listing: GiftListingEvent): Promise<void> {
    const subscribers = db.getActiveSubscribers('listings');
    if (subscribers.length === 0) return;

    const text = this.formatListingMessage(listing);
    const keyboard = this.buildListingKeyboard(listing);

    let sentCount = 0;
    for (const sub of subscribers) {
      // Check user's price filter
      if (sub.maxListingPriceTon !== undefined && listing.priceTon > sub.maxListingPriceTon) {
        continue; // Price higher than user's limit
      }

      const ok = await this.sendSafePhotoOrMessage(sub.chatId, listing.imageUrl, text, keyboard);
      if (ok) sentCount++;
      await new Promise((r) => setTimeout(r, 35));
    }

    db.incrementSentStats('listings', sentCount);
  }

  /**
   * Safe delivery with photo support and fallback
   */
  public async sendSafePhotoOrMessage(
    chatId: number,
    imageUrl: string | undefined,
    caption: string,
    keyboard?: InlineKeyboard
  ): Promise<boolean> {
    try {
      if (imageUrl) {
        try {
          await this.bot.api.sendPhoto(chatId, imageUrl, {
            caption,
            parse_mode: 'HTML',
            reply_markup: keyboard,
          });
          return true;
        } catch {
          // If sending photo fails, fall back to text
        }
      }

      await this.bot.api.sendMessage(chatId, caption, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
        link_preview_options: { is_disabled: false },
      });
      return true;
    } catch (err: any) {
      if (err?.error_code === 403 || err?.description?.includes('blocked')) {
        db.markBlocked(chatId);
      } else {
        console.warn(`⚠️ Failed to send message to ${chatId}:`, err?.message || err);
      }
      return false;
    }
  }

  /**
   * Safe text message delivery handling errors and blocks
   */
  public async sendSafeMessage(
    chatId: number,
    text: string,
    keyboard?: InlineKeyboard
  ): Promise<boolean> {
    try {
      await this.bot.api.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
        link_preview_options: { is_disabled: false },
      });
      return true;
    } catch (err: any) {
      if (err?.error_code === 403 || err?.description?.includes('blocked')) {
        db.markBlocked(chatId);
      } else {
        console.warn(`⚠️ Failed to send message to ${chatId}:`, err?.message || err);
      }
      return false;
    }
  }

  // --- Message Formatters ---

  public formatUpgradeMessage(event: GiftUpgradeEvent, gift: TelegramGift): string {
    let header = '🎁 <b>ОБНОВЛЕНИЕ ПОДАРКА</b>';
    let badge = 'ℹ️';

    switch (event.type) {
      case 'UPGRADE_OPENED':
        header = '🚨 <b>ОТКРЫТО УЛУЧШЕНИЕ ПОДАРКА!</b>';
        badge = '✨';
        break;
      case 'NEW_UPGRADEABLE_GIFT':
        header = '🎁 <b>НОВЫЙ УЛУЧШАЕМЫЙ ПОДАРОК!</b>';
        badge = '🆕';
        break;
      case 'PRICE_CHANGED':
        header = '⭐️ <b>ИЗМЕНИЛАСЬ ЦЕНА УЛУЧШЕНИЯ!</b>';
        badge = '📉';
        break;
      case 'SUPPLY_LOW':
        header = '⚠️ <b>ЗАКАНЧИВАЕТСЯ ТИРАЖ ПОДАРКА!</b>';
        badge = '⏳';
        break;
      case 'SOLD_OUT':
        header = '🛑 <b>ТИРАЖ ПОЛНОСТЬЮ РАСПРОДАН!</b>';
        badge = '🔒';
        break;
    }

    const upgradeStars = event.newUpgradeStars ?? gift.upgradeStars;
    const upgradeText = upgradeStars ? `<code>${upgradeStars.toLocaleString()}</code> ⭐` : 'Недоступно';

    let supplyText = 'Безлимитный';
    if (gift.totalCount) {
      const remaining = gift.remainingCount ?? 0;
      const pct = ((remaining / gift.totalCount) * 100).toFixed(1);
      supplyText = `<code>${remaining.toLocaleString()}</code> / <code>${gift.totalCount.toLocaleString()}</code> (<b>${pct}%</b> осталось)`;
    }

    let priceDiff = '';
    if (event.type === 'PRICE_CHANGED' && event.oldUpgradeStars && event.newUpgradeStars) {
      const diff = event.newUpgradeStars - event.oldUpgradeStars;
      const sign = diff > 0 ? '+' : '';
      priceDiff = ` (было: ${event.oldUpgradeStars} ⭐, изменение: ${sign}${diff} ⭐)`;
    }

    const timeStr = new Date(event.timestamp).toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZone: 'Europe/Moscow',
    });

    return [
      `${badge} ${header}`,
      '',
      `🆔 <b>ID подарка:</b> <code>#${gift.id}</code>`,
      `⭐ <b>Цена покупки:</b> <code>${gift.starCount.toLocaleString()}</code> Stars`,
      `💎 <b>Стоимость апгрейда:</b> ${upgradeText}${priceDiff}`,
      `📦 <b>Тираж:</b> ${supplyText}`,
      '',
      `🕒 <i>Зафиксировано в ${timeStr} MSK</i>`,
    ].join('\n');
  }

  public formatCraftMessage(craft: UniqueCraftEvent): string {
    const rarityEmojiMap: Record<string, string> = {
      Legendary: '👑',
      Epic: '🔮',
      Rare: '💎',
      Uncommon: '🟢',
      Common: '⚪',
    };

    const rarityBadge = craft.rarityLevel
      ? `${rarityEmojiMap[craft.rarityLevel] || '✨'} [${craft.rarityLevel}]`
      : '✨ Уникальный';

    const timeStr = new Date(craft.timestamp).toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZone: 'Europe/Moscow',
    });

    let ownerDisplay = '<i>Скрыт / Анонимно</i>';
    if (craft.ownerName && craft.ownerName !== 'Анонимно / Скрыт') {
      let resolvedUsername = craft.ownerTelegramUsername;
      if (!resolvedUsername && craft.ownerName) {
        let cand: string | undefined;
        if (craft.ownerName.endsWith('.ton')) cand = craft.ownerName.replace(/\.ton$/i, '');
        else if (craft.ownerName.endsWith('.t.me')) cand = craft.ownerName.replace(/\.t.me$/i, '');
        else if (craft.ownerName.startsWith('@')) cand = craft.ownerName.slice(1);
        else if (/^[a-zA-Z0-9_]{4,32}$/.test(craft.ownerName)) cand = craft.ownerName;

        if (cand && /^[a-zA-Z0-9_]{4,32}$/.test(cand) && !cand.includes('-')) {
          resolvedUsername = cand;
        }
      }

      if (resolvedUsername) {
        ownerDisplay = `<a href="https://t.me/${resolvedUsername}"><b>@${resolvedUsername}</b></a> 💬 <i>(нажмите, чтобы написать)</i>`;
        if (craft.ownerName.endsWith('.ton') || craft.ownerName.endsWith('.t.me')) {
          ownerDisplay += ` <code>(${craft.ownerName})</code>`;
        }
      } else if (craft.ownerName.endsWith('.ton')) {
        ownerDisplay = `<a href="https://tonviewer.com/${craft.ownerName}"><b>${craft.ownerName}</b></a> (TON DNS)`;
      } else if (craft.ownerAddress) {
        ownerDisplay = `<a href="https://tonviewer.com/${craft.ownerAddress}"><code>${craft.ownerName}</code></a> (Wallet)`;
      } else {
        ownerDisplay = `<code>${craft.ownerName}</code>`;
      }
    }

    const tgNftUrl = craft.telegramNftUrl || `https://t.me/nft/${craft.giftId}`;
    const mrktUrl = craft.mrktUrl || 'https://t.me/mrkt';
    const fragmentUrl = craft.fragmentUrl || craft.platformUrl;

    const statusText = craft.marketStatus === 'FOR_SALE'
      ? '🟢 В продаже на Fragment'
      : (craft.marketStatus === 'ON_PROFILE' ? '👤 Находится в профиле Telegram' : '⚡️ Свежий апгрейд в сети');

    const lines = [
      `🎁 <b>ПОДАРОК УЛУЧШЕН!</b>`,
      '',
      `🏷️ <b>Вид подарка:</b> <b>${craft.giftTitle} #${craft.num}</b>`,
      `🎨 <b>Модель:</b> <code>${craft.modelName}</code>`,
    ];

    if (craft.rarityLevel) {
      lines.push(`🏅 <b>Редкость:</b> ${rarityBadge}`);
    }
    if (craft.backdropName) {
      lines.push(`🌌 <b>Фон (Backdrop):</b> <code>${craft.backdropName}</code>`);
    }
    if (craft.symbolName) {
      lines.push(`💠 <b>Символ (Pattern):</b> <code>${craft.symbolName}</code>`);
    }
    if (craft.description) {
      lines.push(`📝 <i>${craft.description}</i>`);
    }

    const ownerLabel = craft.isChannel ? '📢 <b>Канал (улучшивший):</b>' : '👤 <b>Ник улучшившего:</b>';

    lines.push('');
    lines.push(`📊 <b>Статус:</b> <code>${statusText}</code>`);
    lines.push(`${ownerLabel} ${ownerDisplay}`);
    if (craft.isOnGetgems) {
      lines.push(`💎 <b>Getgems:</b> Зафиксирован на портале`);
    }
    lines.push(`🏛 <b>Платформы:</b> <a href="${tgNftUrl}">Telegram</a> • <a href="${mrktUrl}">MRKT (МКТ)</a> • <a href="${fragmentUrl}">Fragment</a>${craft.getgemsUrl ? ` • <a href="${craft.getgemsUrl}">Getgems</a>` : ''}`);
    lines.push('');
    if (craft.ageSec !== undefined) {
      lines.push(`⚡️ <i>Задержка: ~${craft.ageSec} сек. назад (Real-Time)</i>`);
    }
    lines.push(`🕒 <i>Зафиксировано в ${timeStr} MSK</i>`);

    return lines.join('\n');
  }

  public formatListingMessage(listing: GiftListingEvent): string {
    const timeStr = new Date(listing.timestamp).toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZone: 'Europe/Moscow',
    });

    let sellerDisplay = '<i>Скрыт / Wallet</i>';
    if (listing.sellerName) {
      if (listing.sellerName.startsWith('@')) {
        sellerDisplay = `<a href="https://t.me/${listing.sellerName.slice(1)}">${listing.sellerName}</a>`;
      } else if (listing.sellerAddress) {
        sellerDisplay = `<a href="https://tonviewer.com/${listing.sellerAddress}"><code>${listing.sellerName}</code></a>`;
      } else {
        sellerDisplay = `<code>${listing.sellerName}</code>`;
      }
    }

    const platformLink = `<a href="${listing.platformUrl}"><b>${listing.platformName}</b></a>`;

    const lines = [
      `💰 <b>ПОДАРОК ВЫСТАВЛЕН НА ПРОДАЖУ!</b>`,
      '',
      `🏷️ <b>Вид подарка:</b> <b>${listing.giftTitle} #${listing.num}</b>`,
      `💵 <b>Цена продажи:</b> <b><code>${listing.priceTon.toLocaleString()} TON</code></b>`,
      `🎨 <b>Модель:</b> <code>${listing.modelName}</code>`,
    ];

    if (listing.backdropName) {
      lines.push(`🌌 <b>Фон (Backdrop):</b> <code>${listing.backdropName}</code>`);
    }
    if (listing.symbolName) {
      lines.push(`💠 <b>Символ (Pattern):</b> <code>${listing.symbolName}</code>`);
    }
    if (listing.description) {
      lines.push(`📝 <i>${listing.description}</i>`);
    }

    lines.push('');
    lines.push(`🏛 <b>Платформа:</b> ${platformLink}`);
    lines.push(`👤 <b>Продавец:</b> ${sellerDisplay}`);
    lines.push('');
    lines.push(`🕒 <i>Выставлен в ${timeStr} MSK</i>`);

    return lines.join('\n');
  }

  public buildUpgradeKeyboard(event: GiftUpgradeEvent, gift: TelegramGift): InlineKeyboard {
    const keyboard = new InlineKeyboard();
    keyboard.url('🎁 Открыть магазин подарков', 'tg://resolve?domain=Telegram');
    return keyboard;
  }

  public buildCraftKeyboard(craft: UniqueCraftEvent): InlineKeyboard {
    const keyboard = new InlineKeyboard();

    // 1. Прямая кнопка написать в ЛС если есть валидный Telegram-юзернейм (без дефисов!)
    let username = craft.ownerTelegramUsername;
    if (!username && craft.ownerName) {
      let cand: string | undefined;
      if (craft.ownerName.endsWith('.ton')) cand = craft.ownerName.replace(/\.ton$/i, '');
      else if (craft.ownerName.endsWith('.t.me')) cand = craft.ownerName.replace(/\.t.me$/i, '');
      else if (craft.ownerName.startsWith('@')) cand = craft.ownerName.slice(1);
      else if (/^[a-zA-Z0-9_]{4,32}$/.test(craft.ownerName)) cand = craft.ownerName;

      if (cand && /^[a-zA-Z0-9_]{4,32}$/.test(cand) && !cand.includes('-')) {
        username = cand;
      }
    }

    if (username) {
      keyboard.url(`💬 Написать @${username}`, `https://t.me/${username}`).row();
    } else if (craft.ownerTelegramUserId) {
      keyboard.url('💬 Написать владельцу', `tg://user?id=${craft.ownerTelegramUserId}`).row();
    }

    // 2. Открыть подарок прямо в приложении Telegram (открывает окно с профилем владельца)
    const tgNftUrl = craft.telegramNftUrl || `https://t.me/nft/${craft.giftId}`;
    keyboard.url('📱 Профиль в Telegram (t.me/nft)', tgNftUrl);

    // 3. Маркетплейс MRKT (МКТ)
    const mrktUrl = craft.mrktUrl || 'https://t.me/mrkt';
    keyboard.url('🛍️ MRKT (МКТ)', mrktUrl).row();

    // 4. Fragment
    const fragmentUrl = craft.fragmentUrl || craft.platformUrl;
    keyboard.url('🌐 Fragment', fragmentUrl);

    // 5. Getgems
    if (craft.getgemsUrl) {
      keyboard.url('💎 Getgems', craft.getgemsUrl);
    }

    // 6. Tonviewer
    if (craft.tonviewerUrl) {
      keyboard.url('🔍 Tonviewer', craft.tonviewerUrl).row();
    }

    return keyboard;
  }

  public buildListingKeyboard(listing: GiftListingEvent): InlineKeyboard {
    const keyboard = new InlineKeyboard();

    const username = listing.sellerTelegramUsername || (listing.sellerName?.startsWith('@') ? listing.sellerName.slice(1) : undefined);
    if (username) {
      keyboard.url(`💬 Написать продавцу (@${username})`, `https://t.me/${username}`).row();
    }

    const tgNftUrl = listing.telegramNftUrl || `https://t.me/nft/${listing.giftId}`;
    keyboard.url('📱 Открыть в Telegram', tgNftUrl);
    keyboard.url(`🛍️ Купить на ${listing.platformName}`, listing.platformUrl).row();
    if (listing.sellerAddress) {
      keyboard.url('💎 В Tonviewer', `https://tonviewer.com/${listing.sellerAddress}`);
    }
    return keyboard;
  }
}
