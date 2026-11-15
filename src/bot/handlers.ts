import { Context, InlineKeyboard } from 'grammy';
import { db } from '../storage/database.js';
import { Notifier } from '../notifier/notifier.js';

export function setupHandlers(bot: any, notifier: Notifier): void {
  // /start command
  bot.command('start', async (ctx: Context) => {
    if (!ctx.chat || !ctx.from) return;

    db.upsertSubscriber({
      chatId: ctx.chat.id,
      userId: ctx.from.id,
      username: ctx.from.username,
      firstName: ctx.from.first_name,
      notifyUpgrades: true,
      notifyCrafts: true,
      notifyListings: false,
      minRarity: 'ALL',
    });

    const text = [
      `👋 <b>Привет, ${ctx.from.first_name || 'друг'}!</b>`,
      '',
      `Я бот для отслеживания <b>улучшений всех подарков в Telegram</b>!`,
      '',
      `Как только кто-либо улучшает любой подарок (все подряд без исключений), вы мгновенно получите карточку:`,
      `  • 🖼 Фотография обновлённого подарка`,
      `  • 🏷 Название и уникальный номер`,
      `  • 🎨 Модель, цвет фона и символ`,
      `  • 👤 Ник человека, который улучшил`,
      `  • 💬 Прямая кнопка <b>«Написать владельцу»</b> и <b>«Открыть в Telegram»</b>`,
      '',
      `✅ <b>Вы подписаны! Уведомления приходят прямо сюда.</b>`,
    ].join('\n');

    const keyboard = new InlineKeyboard()
      .text('🧪 Отправить пример', 'send_test')
      .text('📊 Статус бота', 'view_status');

    await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  });

  // /status command
  bot.command('status', async (ctx: Context) => {
    await handleViewStatus(ctx);
  });

  bot.callbackQuery('view_status', async (ctx: Context) => {
    await ctx.answerCallbackQuery();
    await handleViewStatus(ctx);
  });

  async function handleViewStatus(ctx: Context): Promise<void> {
    const stats = db.getStatistics();
    const uptimeSec = Math.floor((Date.now() - new Date(stats.botStartedAt).getTime()) / 1000);
    const hours = Math.floor(uptimeSec / 3600);
    const mins = Math.floor((uptimeSec % 3600) / 60);

    const craftCheck = stats.lastCraftCheckAt
      ? new Date(stats.lastCraftCheckAt).toLocaleTimeString('ru-RU')
      : 'ещё не проводилась';

    const text = [
      '📊 <b>Статус работы бота:</b>',
      '',
      `🟢 <b>Состояние:</b> Онлайн (мониторинг улучшений)`,
      `⏱️ <b>Аптайм:</b> ${hours} ч. ${mins} мин.`,
      `👥 <b>Подписчиков:</b> ${stats.totalSubscribers}`,
      `🎁 <b>Отправлено улучшений:</b> ${stats.totalCraftEventsSent}`,
      '',
      `🕒 <i>Посл. проверка: ${craftCheck}</i>`,
    ].join('\n');

    await ctx.reply(text, { parse_mode: 'HTML' });
  }

  // /test command
  bot.command('test', async (ctx: Context) => {
    await handleSendTest(ctx);
  });

  bot.callbackQuery('send_test', async (ctx: Context) => {
    await ctx.answerCallbackQuery();
    await handleSendTest(ctx);
  });

  async function handleSendTest(ctx: Context): Promise<void> {
    if (!ctx.chat?.id) return;

    await ctx.reply('🧪 Отправляю пример уведомления об улучшении подарка...', { parse_mode: 'HTML' });

    const demoCraft = {
      id: 'demo_craft_123',
      giftId: 'plushpepe-1330',
      giftTitle: 'Plush Pepe',
      num: 1330,
      modelName: 'Barcelona',
      backdropName: 'Lemongrass',
      symbolName: 'Cap',
      rarityLevel: 'Legendary' as const,
      description: 'Эксклюзивный Plush Pepe с обликом Barcelona на фоне цвета Lemongrass с символикой Cap.',
      imageUrl: 'https://nft.fragment.com/gift/plushpepe-1330.webp',
      ownerName: '@rasul',
      ownerTelegramUsername: 'rasul',
      ownerAddress: '0:61b6929cbb1ba1ac9d12b2be2582f33722b446f7f262028dbb3aa43f258fd8c5',
      platformName: 'Telegram / MRKT / Fragment',
      platformUrl: 'https://fragment.com/gift/plushpepe-1330',
      telegramNftUrl: 'https://t.me/nft/plushpepe-1330',
      mrktUrl: 'https://t.me/mrkt',
      fragmentUrl: 'https://fragment.com/gift/plushpepe-1330',
      getgemsUrl: 'https://getgems.io/nft/0:1ca16fc1d2fc5b88bc5d646a33e74d01a05aa398d8b98c0eb0da7c70baa0fca8',
      tonviewerUrl: 'https://tonviewer.com/0:1ca16fc1d2fc5b88bc5d646a33e74d01a05aa398d8b98c0eb0da7c70baa0fca8',
      timestamp: new Date().toISOString(),
    };

    const craftMsg = notifier.formatCraftMessage(demoCraft);

    await notifier.sendSafePhotoOrMessage(
      ctx.chat.id,
      demoCraft.imageUrl,
      craftMsg,
      notifier.buildCraftKeyboard(demoCraft)
    );
  }

  // /help command
  bot.command('help', async (ctx: Context) => {
    const text = [
      '📖 <b>Справка:</b>',
      '',
      '/start — Главное меню и статус подписки',
      '/status — Статистика отправленных улучшений и аптайм',
      '/test — Протестировать уведомление',
      '',
      'ℹ️ <i>Бот отслеживает абсолютно все улучшения подарков в Telegram в режиме реального времени.</i>',
    ].join('\n');

    await ctx.reply(text, { parse_mode: 'HTML' });
  });
}
