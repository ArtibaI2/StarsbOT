import { Bot, InlineKeyboard } from 'grammy';
import { db } from '../storage/database.js';
import { GiftListingEvent, GiftUpgradeEvent, TelegramGift, UniqueCraftEvent } from '../types/gift.js';
import { matchesCraftFilters } from './craftFilters.js';
import { SendPacer } from './sendPacer.js';

export function escapeHtml(text?: string): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function isBlockedError(err: any): boolean {
  return (
    err?.error_code === 403 ||
    (typeof err?.description === 'string' &&
      /blocked|chat not found|user is deactivated/i.test(err.description))
  );
}

function isRetryableError(err: any): boolean {
  const code = err?.error_code;
  if (code === 429) return true;
  if (typeof code === 'number' && code >= 500) return true;

  const netCode = err?.code;
  return (
    netCode === 'ECONNRESET' ||
    netCode === 'ETIMEDOUT' ||
    netCode === 'ECONNREFUSED' ||
    netCode === 'EAI_AGAIN' ||
    netCode === 'ENOTFOUND'
  );
}

export class Notifier {
  private bot: Bot;
  private readonly sendPacer = new SendPacer(35);

  constructor(bot: Bot) {
    this.bot = bot;
  }

  /**
   * Retries retryable Telegram failures (429 / 5xx / transient network errors)
   * with exponential backoff and respects the API-provided retry_after.
   */
  private async sendWithRetry<T>(operation: () => Promise<T>, maxAttempts = 3): Promise<T> {
    let attempt = 0;
    let delayMs = 500;

    while (true) {
      try {
        return await operation();
      } catch (err: any) {
        attempt++;
        if (!isRetryableError(err) || attempt >= maxAttempts) {
          throw err;
        }

        const retryAfterSec = Number(err?.parameters?.retry_after ?? 0);
        const waitMs = retryAfterSec > 0 ? retryAfterSec * 1000 : delayMs;
        console.warn(
          `⏳ Telegram send retry ${attempt}/${maxAttempts} in ${waitMs}ms ` +
            `(${err?.error_code ?? err?.code ?? 'network'})`
        );
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        delayMs = Math.min(delayMs * 2, 8000);
      }
    }
  }

  /**
   * Broadcast gift upgrade availability alert to subscribers
   */
  public async broadcastUpgradeEvent(event: GiftUpgradeEvent, gift: TelegramGift): Promise<void> {
    const subscribers = db.getActiveSubscribers('upgrades');
    if (subscribers.length === 0) return;

    const text = this.formatUpgradeMessage(event, gift);
    const keyboard = this.buildUpgradeKeyboard(event, gift);

    const sentResults = await Promise.all(subscribers.map((sub) =>
      this.sendPacer.run(() => this.sendSafeMessage(sub.chatId, text, keyboard))
    ));
    const sentCount = sentResults.filter(Boolean).length;

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

    const eligible = subscribers.filter((sub) => matchesCraftFilters(sub, craft));
    const sentResults = await Promise.all(eligible.map((sub) =>
      this.sendPacer.run(() => this.sendSafePhotoOrMessage(sub.chatId, craft.imageUrl, text, keyboard))
    ));
    const sentCount = sentResults.filter(Boolean).length;

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

    const eligible = subscribers.filter((sub) =>
      sub.maxListingPriceTon === undefined || listing.priceTon <= sub.maxListingPriceTon
    );
    const sentResults = await Promise.all(eligible.map((sub) =>
      this.sendPacer.run(() => this.sendSafePhotoOrMessage(sub.chatId, listing.imageUrl, text, keyboard))
    ));
    const sentCount = sentResults.filter(Boolean).length;

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
          await this.sendWithRetry(() =>
            this.bot.api.sendPhoto(chatId, imageUrl, {
              caption,
              parse_mode: 'HTML',
              reply_markup: keyboard,
            })
          );
          return true;
        } catch (photoErr: any) {
          if (isBlockedError(photoErr)) {
            db.markBlocked(chatId);
            return false;
          }
          // Bad/unsupported image or exhausted retries -> fall back to a text message.
          console.warn(
            `⚠️ Photo delivery failed for ${chatId}, falling back to text:`,
            photoErr?.message || photoErr
          );
        }
      }

      await this.sendWithRetry(() =>
        this.bot.api.sendMessage(chatId, caption, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
          link_preview_options: { is_disabled: false },
        })
      );
      return true;
    } catch (err: any) {
      if (isBlockedError(err)) {
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
      await this.sendWithRetry(() =>
        this.bot.api.sendMessage(chatId, text, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
          link_preview_options: { is_disabled: false },
        })
      );
      return true;
    } catch (err: any) {
      if (isBlockedError(err)) {
        db.markBlocked(chatId);
      } else {
        console.warn(`⚠️ Failed to send message to ${chatId}:`, err?.message || err);
      }
      return false;
    }
  }

  /**
   * Resolves a public Telegram username from the owner's display name.
   * Returns undefined when the name is not a valid public username.
   */
  private resolveUsername(ownerName?: string, ownerTelegramUsername?: string): string | undefined {
    if (ownerTelegramUsername) return ownerTelegramUsername;
    if (!ownerName) return undefined;

    let candidate: string | undefined;
    if (ownerName.endsWith('.ton')) candidate = ownerName.replace(/\.ton$/i, '');
    else if (ownerName.endsWith('.t.me')) candidate = ownerName.replace(/\.t.me$/i, '');
    else if (ownerName.startsWith('@')) candidate = ownerName.slice(1);
    else if (/^[a-zA-Z0-9_]{4,32}$/.test(ownerName)) candidate = ownerName;

    if (candidate && /^[a-zA-Z0-9_]{4,32}$/.test(candidate) && !candidate.includes('-')) {
      return candidate;
    }
    return undefined;
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
      const resolvedUsername = this.resolveUsername(craft.ownerName, craft.ownerTelegramUsername);

      if (resolvedUsername) {
        ownerDisplay = `<a href="https://t.me/${resolvedUsername}"><b>@${escapeHtml(resolvedUsername)}</b></a> 💬 <i>(нажмите, чтобы написать)</i>`;
        if (craft.ownerName.endsWith('.ton') || craft.ownerName.endsWith('.t.me')) {
          ownerDisplay += ` <code>(${escapeHtml(craft.ownerName)})</code>`;
        }
      } else if (craft.ownerName.endsWith('.ton')) {
        ownerDisplay = `<a href="https://tonviewer.com/${encodeURIComponent(craft.ownerName)}"><b>${escapeHtml(craft.ownerName)}</b></a> (TON DNS)`;
      } else if (craft.ownerAddress) {
        ownerDisplay = `<a href="https://tonviewer.com/${encodeURIComponent(craft.ownerAddress)}"><code>${escapeHtml(craft.ownerName)}</code></a> (Wallet)`;
      } else {
        ownerDisplay = `<b>${escapeHtml(craft.ownerName)}</b> (в профиле Telegram)`;
      }
    }

    const tgNftUrl = craft.telegramNftUrl || `https://t.me/nft/${craft.giftId}`;
    const mrktUrl = craft.mrktUrl || 'https://t.me/mrkt';
    const fragmentUrl = craft.fragmentUrl || craft.platformUrl;

    const statusText = craft.marketStatus === 'FOR_SALE'
      ? '🟢 В продаже на Fragment'
      : (craft.marketStatus === 'ON_PROFILE' ? '👤 Находится в профиле Telegram' : '⚡️ Свежий апгрейд в сети');

    const lines = [
      `🎁 <b>НОВОЕ УЛУЧШЕНИЕ В ПРОФИЛЕ!</b>`,
      '',
      `🏷️ <b>Вид подарка:</b> <b>${escapeHtml(craft.giftTitle)} #${craft.num}</b>`,
      `🎨 <b>Модель:</b> <code>${escapeHtml(craft.modelName)}</code>${craft.modelRarity ? ` <i>(${escapeHtml(craft.modelRarity)})</i>` : ''}`,
    ];

    if (craft.rarityLevel) {
      lines.push(`🏅 <b>Редкость:</b> ${rarityBadge}`);
    }
    if (craft.backdropName) {
      lines.push(`🌌 <b>Фон (Backdrop):</b> <code>${escapeHtml(craft.backdropName)}</code>${craft.backdropRarity ? ` <i>(${escapeHtml(craft.backdropRarity)})</i>` : ''}`);
    }
    if (craft.symbolName) {
      lines.push(`💠 <b>Символ (Pattern):</b> <code>${escapeHtml(craft.symbolName)}</code>${craft.symbolRarity ? ` <i>(${escapeHtml(craft.symbolRarity)})</i>` : ''}`);
    }
    if (craft.description) {
      lines.push(`📝 <i>${escapeHtml(craft.description)}</i>`);
    }

    const ownerLabel = craft.isChannel ? '📢 <b>Канал:</b>' : '👤 <b>Владелец:</b>';

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
        const uname = listing.sellerName.slice(1);
        sellerDisplay = /^[a-zA-Z0-9_]{4,32}$/.test(uname)
          ? `<a href="https://t.me/${uname}">@${escapeHtml(uname)}</a>`
          : `<code>${escapeHtml(listing.sellerName)}</code>`;
      } else if (listing.sellerAddress) {
        sellerDisplay = `<a href="https://tonviewer.com/${encodeURIComponent(listing.sellerAddress)}"><code>${escapeHtml(listing.sellerName)}</code></a>`;
      } else {
        sellerDisplay = `<code>${escapeHtml(listing.sellerName)}</code>`;
      }
    }

    const platformLink = `<a href="${listing.platformUrl}"><b>${escapeHtml(listing.platformName)}</b></a>`;

    const lines = [
      `💰 <b>ПОДАРОК ВЫСТАВЛЕН НА ПРОДАЖУ!</b>`,
      '',
      `🏷️ <b>Вид подарка:</b> <b>${escapeHtml(listing.giftTitle)} #${listing.num}</b>`,
      `💵 <b>Цена продажи:</b> <b><code>${listing.priceTon.toLocaleString()} TON</code></b>`,
      `🎨 <b>Модель:</b> <code>${escapeHtml(listing.modelName)}</code>`,
    ];

    if (listing.backdropName) {
      lines.push(`🌌 <b>Фон (Backdrop):</b> <code>${escapeHtml(listing.backdropName)}</code>`);
    }
    if (listing.symbolName) {
      lines.push(`💠 <b>Символ (Pattern):</b> <code>${escapeHtml(listing.symbolName)}</code>`);
    }
    if (listing.description) {
      lines.push(`📝 <i>${escapeHtml(listing.description)}</i>`);
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
    const username = this.resolveUsername(craft.ownerName, craft.ownerTelegramUsername);

    const tgNftUrl = craft.telegramNftUrl || `https://t.me/nft/${craft.giftId}`;

    if (username) {
      const offerMsg = encodeURIComponent(
        `Привет! Вижу твой подарок ${craft.giftTitle} #${craft.num} в профиле. Интересует продажа?`
      );
      keyboard.url(`💬 Написать @${username}`, `https://t.me/${username}?text=${offerMsg}`).row();
      keyboard.url('📱 Профиль в Telegram', tgNftUrl);
    } else {
      // Для пользователей без публичного @юзернейма (например, "Иван")
      // t.me/nft/<slug> открывает карточку подарка с профилем владельца напрямую в Telegram!
      // ВАЖНО: Telegram Bot API запрещает использовать tg://user?id= в кнопках (вызывает ошибку BUTTON_USER_INVALID)
      keyboard.url('📱 Профиль владельца (в Telegram)', tgNftUrl);
    }

    // 2. Маркетплейс MRKT (МКТ)
    const mrktUrl = craft.mrktUrl || 'https://t.me/mrkt';
    keyboard.url('🛍️ MRKT (МКТ)', mrktUrl).row();

    // 3. Fragment
    const fragmentUrl = craft.fragmentUrl || craft.platformUrl;
    keyboard.url('🌐 Fragment', fragmentUrl);

    // 4. Getgems
    if (craft.getgemsUrl) {
      keyboard.url('💎 Getgems', craft.getgemsUrl);
    }

    // 5. Tonviewer
    if (craft.tonviewerUrl) {
      keyboard.url('🔍 Tonviewer', craft.tonviewerUrl).row();
    }

    return keyboard;
  }

  public buildListingKeyboard(listing: GiftListingEvent): InlineKeyboard {
    const keyboard = new InlineKeyboard();

    const username = listing.sellerTelegramUsername || (listing.sellerName?.startsWith('@') ? listing.sellerName.slice(1) : undefined);
    if (username && /^[a-zA-Z0-9_]{4,32}$/.test(username)) {
      keyboard.url(`💬 Написать продавцу (@${username})`, `https://t.me/${username}`).row();
    }

    // Only a real slug produces a working t.me/nft link; a collection id
    // ("valentine_box") would open an invalid page.
    if (listing.telegramNftUrl) {
      keyboard.url('📱 Открыть в Telegram', listing.telegramNftUrl);
    }
    keyboard.url(`🛍️ Купить на ${listing.platformName}`, listing.platformUrl).row();
    if (listing.sellerAddress) {
      keyboard.url('💎 В Tonviewer', `https://tonviewer.com/${listing.sellerAddress}`);
    }
    return keyboard;
  }
}
