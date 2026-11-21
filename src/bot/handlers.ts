import { Bot, Context, InlineKeyboard } from 'grammy';
import { db, isAdmin } from '../storage/database.js';
import { Notifier } from '../notifier/notifier.js';

function matchText(ctx: Context): string {
  return typeof ctx.match === 'string' ? ctx.match.trim() : '';
}

const BROADCAST_CONFIRM_TTL_MS = 60_000;

export function setupHandlers(bot: Bot, notifier: Notifier): void {
  // Pending broadcasts awaiting explicit confirmation, keyed by admin user id.
  const pendingBroadcasts = new Map<number, { text: string; createdAt: number }>();

  // /start command
  bot.command('start', async (ctx: Context) => {
    if (!ctx.chat || !ctx.from) return;

    const existing = db.getSubscriber(ctx.chat.id);
    const user = db.upsertSubscriber({
      chatId: ctx.chat.id,
      userId: ctx.from.id,
      username: ctx.from.username,
      firstName: ctx.from.first_name,
      notifyUpgrades: existing?.notifyUpgrades ?? true,
      notifyCrafts: existing?.notifyCrafts ?? true,
      notifyListings: existing?.notifyListings ?? false,
      onlyProfileUpgrades: existing?.onlyProfileUpgrades ?? true,
      filterChannels: existing?.filterChannels ?? 'ALL',
      filterGetgems: existing?.filterGetgems ?? 'ALL',
      minRarity: existing?.minRarity ?? 'ALL',
    });

    const isUserAdmin = isAdmin(ctx.from.id);
    const isSubActive = db.hasActiveSubscription(ctx.chat.id);
    const subSystemEnabled = db.isSubscriptionSystemEnabled();

    // If subscription system is enabled and user has NO subscription
    if (subSystemEnabled && !isSubActive && !isUserAdmin) {
      const lockText = [
        `👋 <b>Привет, ${ctx.from.first_name || 'друг'}!</b>`,
        '',
        `🔐 <b>В боте включен закрытый доступ по подписке.</b>`,
        '',
        `У вас пока нет активной подписки на мониторинг улучшений подарков.`,
        '',
        `Для получения доступа обратитесь к администраторам бота.`,
        '',
        `ℹ️ <i>Ваш Telegram ID:</i> <code>${ctx.from.id}</code> (сообщите его админу для активации)`,
      ].join('\n');

      const lockKeyboard = new InlineKeyboard()
        .text('🔑 Проверить статус подписки', 'my_subscription')
        .row()
        .text('📊 Статус бота', 'view_status');

      await ctx.reply(lockText, {
        parse_mode: 'HTML',
        reply_markup: lockKeyboard,
      });
      return;
    }

    const text = [
      `👋 <b>Привет, ${ctx.from.first_name || 'друг'}!</b>`,
      '',
      `Я бот для <b>мгновенного отслеживания улучшений подарков в Telegram (Real-Time)</b>!`,
      '',
      `⚡️ <b>Как это работает:</b>`,
      `Как только кто-либо улучшает подарок в Telegram (в профиле или на блокчейне), бот за <b>3–5 секунд</b> присылает карточку:`,
      `  • 🖼 Фотография и модель подарка`,
      `  • 🏷 Название, номер и редкость`,
      `  • 👤 Ник улучшившего (или канал)`,
      `  • 💬 Прямая кнопка <b>«Написать владельцу»</b> и ссылки на платформы`,
      `  • ⏱ Реальное время с задержкой (без устаревших данных)`,
      '',
      `✅ <b>Вы подписаны на обновления!</b>`,
    ].join('\n');

    const keyboard = new InlineKeyboard()
      .text('🧪 Пример уведомления', 'send_test')
      .text('⚙️ Фильтры и настройки', 'view_settings')
      .row()
      .text('📊 Статус бота', 'view_status')
      .text('🔑 Моя подписка', 'my_subscription');

    if (isUserAdmin) {
      keyboard.row().text('👑 Панель Администратора', 'admin_panel');
    }

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
      `🟢 <b>Состояние:</b> Онлайн (Real-Time мониторинг каждые 3 сек)`,
      `⏱️ <b>Аптайм:</b> ${hours} ч. ${mins} мин.`,
      `👥 <b>Всего пользователей:</b> ${stats.totalSubscribers}`,
      `🔐 <b>Режим подписок:</b> ${stats.subscriptionSystemEnabled ? 'Включен' : 'Отключен (открытый доступ)'}`,
      `🎁 <b>Отправлено улучшений:</b> ${stats.totalCraftEventsSent}`,
      '',
      `🕒 <i>Посл. проверка сети: ${craftCheck}</i>`,
    ].join('\n');

    const keyboard = new InlineKeyboard().text('🔙 Назад', 'back_to_menu');
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }

  // /settings & /filters commands
  bot.command(['settings', 'filters'], async (ctx: Context) => {
    await handleViewSettings(ctx);
  });

  bot.callbackQuery('view_settings', async (ctx: Context) => {
    await ctx.answerCallbackQuery();
    await handleViewSettings(ctx);
  });

  async function handleViewSettings(ctx: Context): Promise<void> {
    if (!ctx.chat?.id) return;
    const sub = db.getSubscriber(ctx.chat.id);

    const channelsMode = sub?.filterChannels || 'ALL';
    const getgemsMode = sub?.filterGetgems || 'ALL';
    const profileOnly = sub?.onlyProfileUpgrades !== false;

    const channelsLabel = channelsMode === 'ONLY_USERS'
      ? '👤 Только люди (без каналов)'
      : (channelsMode === 'ONLY_CHANNELS' ? '📢 Только каналы' : '🌐 Все (люди и каналы)');

    const getgemsLabel = getgemsMode === 'EXCLUDE_GETGEMS'
      ? '🚫 Исключать Getgems'
      : (getgemsMode === 'ONLY_GETGEMS' ? '💎 Только Getgems' : '🌐 Все платформы');

    const profileLabel = profileOnly ? '✅ Да (с контактом)' : '🌐 Все (включая анонимные)';

    const text = [
      '⚙️ <b>Настройки фильтрации уведомлений:</b>',
      '',
      `📢 <b>Фильтр каналов:</b> <code>${channelsLabel}</code>`,
      `💎 <b>Фильтр Getgems:</b> <code>${getgemsLabel}</code>`,
      `👤 <b>Только с профиля Telegram:</b> <code>${profileLabel}</code>`,
      '',
      '<i>Нажмите на кнопку ниже, чтобы переключить нужный фильтр:</i>',
    ].join('\n');

    const keyboard = new InlineKeyboard()
      .text(`📢 Каналы: ${channelsMode === 'ONLY_USERS' ? 'Только люди' : (channelsMode === 'ONLY_CHANNELS' ? 'Только каналы' : 'Все')}`, 'toggle_filter_channels')
      .row()
      .text(`💎 Getgems: ${getgemsMode === 'EXCLUDE_GETGEMS' ? 'Без Getgems' : (getgemsMode === 'ONLY_GETGEMS' ? 'Только Getgems' : 'Все')}`, 'toggle_filter_getgems')
      .row()
      .text(`👤 Профиль: ${profileOnly ? 'Только профили' : 'Все'}`, 'toggle_only_profile')
      .row()
      .text('🔙 Назад', 'back_to_menu');

    if (ctx.callbackQuery) {
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
        return;
      } catch {}
    }
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }

  // Toggle Channel filter callback
  bot.callbackQuery('toggle_filter_channels', async (ctx: Context) => {
    if (!ctx.chat?.id) return;
    const sub = db.getSubscriber(ctx.chat.id);
    const cur = sub?.filterChannels || 'ALL';

    let next: 'ALL' | 'ONLY_USERS' | 'ONLY_CHANNELS' = 'ONLY_USERS';
    if (cur === 'ONLY_USERS') next = 'ONLY_CHANNELS';
    else if (cur === 'ONLY_CHANNELS') next = 'ALL';
    else next = 'ONLY_USERS';

    db.updatePreferences(ctx.chat.id, { filterChannels: next });
    await ctx.answerCallbackQuery({ text: `Фильтр каналов: ${next}` });
    await handleViewSettings(ctx);
  });

  // Toggle Getgems filter callback
  bot.callbackQuery('toggle_filter_getgems', async (ctx: Context) => {
    if (!ctx.chat?.id) return;
    const sub = db.getSubscriber(ctx.chat.id);
    const cur = sub?.filterGetgems || 'ALL';

    let next: 'ALL' | 'EXCLUDE_GETGEMS' | 'ONLY_GETGEMS' = 'EXCLUDE_GETGEMS';
    if (cur === 'EXCLUDE_GETGEMS') next = 'ONLY_GETGEMS';
    else if (cur === 'ONLY_GETGEMS') next = 'ALL';
    else next = 'EXCLUDE_GETGEMS';

    db.updatePreferences(ctx.chat.id, { filterGetgems: next });
    await ctx.answerCallbackQuery({ text: `Фильтр Getgems: ${next}` });
    await handleViewSettings(ctx);
  });

  // Toggle Profile filter callback
  bot.callbackQuery('toggle_only_profile', async (ctx: Context) => {
    if (!ctx.chat?.id) return;
    const sub = db.getSubscriber(ctx.chat.id);
    const cur = sub?.onlyProfileUpgrades !== false;
    db.updatePreferences(ctx.chat.id, { onlyProfileUpgrades: !cur });
    await ctx.answerCallbackQuery({ text: `Только профили: ${!cur ? 'ВКЛ' : 'ВЫКЛ'}` });
    await handleViewSettings(ctx);
  });

  // My Subscription check callback
  bot.callbackQuery('my_subscription', async (ctx: Context) => {
    await ctx.answerCallbackQuery();
    if (!ctx.chat?.id) return;

    const isUserAdmin = isAdmin(ctx.chat.id);
    const isSubActive = db.hasActiveSubscription(ctx.chat.id);
    const sub = db.getSubscriber(ctx.chat.id);
    const sysEnabled = db.isSubscriptionSystemEnabled();

    let statusText = '';
    if (isUserAdmin) {
      statusText = '👑 <b>Вы администратор:</b> полный неограниченный доступ навсегда.';
    } else if (!sysEnabled) {
      statusText = '🟢 <b>Открытый доступ:</b> система подписок отключена администратором, бот доступен всем.';
    } else if (isSubActive) {
      const exp = sub?.subscriptionExpiresAt === 'forever'
        ? 'Бессрочно (навсегда)'
        : (sub?.subscriptionExpiresAt ? new Date(sub.subscriptionExpiresAt).toLocaleString('ru-RU') : 'Активна');
      statusText = `🟢 <b>Подписка активна!</b>\nСрок действия: <code>${exp}</code>`;
    } else {
      statusText = `🔴 <b>Подписка не активна.</b>\nДля продления или покупки напишите администраторам бота.`;
    }

    const text = [
      '🔑 <b>Информация о вашей подписке:</b>',
      '',
      statusText,
      '',
      `Ваш ID: <code>${ctx.chat.id}</code>`,
    ].join('\n');

    const keyboard = new InlineKeyboard().text('🔙 Назад', 'back_to_menu');
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  });

  // Back to Main Menu callback
  bot.callbackQuery('back_to_menu', async (ctx: Context) => {
    await ctx.answerCallbackQuery();
    if (!ctx.chat?.id || !ctx.from) return;

    const isUserAdmin = isAdmin(ctx.from.id);
    const text = [
      `👋 <b>Главное меню StarsBot</b>`,
      '',
      `Выберите нужный раздел:`,
    ].join('\n');

    const keyboard = new InlineKeyboard()
      .text('🧪 Пример уведомления', 'send_test')
      .text('⚙️ Фильтры и настройки', 'view_settings')
      .row()
      .text('📊 Статус бота', 'view_status')
      .text('🔑 Моя подписка', 'my_subscription');

    if (isUserAdmin) {
      keyboard.row().text('👑 Панель Администратора', 'admin_panel');
    }

    if (ctx.callbackQuery) {
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
        return;
      } catch {}
    }
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  });

  // ==========================================
  // 👑 ADMIN PANEL & MANAGEMENT
  // ==========================================

  bot.command('admin', async (ctx: Context) => {
    await handleAdminPanel(ctx);
  });

  bot.callbackQuery('admin_panel', async (ctx: Context) => {
    await ctx.answerCallbackQuery();
    await handleAdminPanel(ctx);
  });

  bot.callbackQuery('admin_refresh', async (ctx: Context) => {
    await ctx.answerCallbackQuery({ text: 'Данные обновлены' });
    await handleAdminPanel(ctx);
  });

  async function handleAdminPanel(ctx: Context): Promise<void> {
    if (!ctx.from || !isAdmin(ctx.from.id)) {
      await ctx.reply('⛔ Доступ запрещён. Вы не являетесь администратором бота.');
      return;
    }

    const stats = db.getStatistics();
    const sysEnabled = db.isSubscriptionSystemEnabled();
    const uptimeSec = Math.floor((Date.now() - new Date(stats.botStartedAt).getTime()) / 1000);
    const hours = Math.floor(uptimeSec / 3600);
    const mins = Math.floor((uptimeSec % 3600) / 60);

    const text = [
      '👑 <b>Панель Администратора</b>',
      '',
      `🔐 <b>Система платных подписок:</b> ${sysEnabled ? '🟢 <b>ВКЛЮЧЕНА</b> (только по подписке)' : '⚪️ <b>ВЫКЛЮЧЕНА</b> (доступ открыт всем)'}`,
      '',
      `📊 <b>Статистика:</b>`,
      `  • Всего пользователей в базе: <b>${stats.totalSubscribers}</b>`,
      `  • Активных пользователей: <b>${stats.activeSubscribersCount}</b>`,
      `  • Пользователей с платной подпиской: <b>${stats.paidSubscribersCount}</b>`,
      `  • Отправлено алертов: <b>${stats.totalCraftEventsSent}</b>`,
      `  • Аптайм бота: <b>${hours} ч. ${mins} мин.</b>`,
      '',
      `⚡️ <i>Администраторы задаются через ADMIN_IDS в .env</i>`,
    ].join('\n');

    const keyboard = new InlineKeyboard()
      .text(`🔐 Режим подписок: ${sysEnabled ? 'ВКЛ' : 'ВЫКЛ'} (нажмите для смены)`, 'admin_toggle_sub_system')
      .row()
      .text('➕ Выдать подписку', 'admin_add_sub_info')
      .text('➖ Забрать подписку', 'admin_remove_sub_info')
      .row()
      .text('📋 Список подписчиков', 'admin_list_subs')
      .text('📢 Сделать рассылку', 'admin_broadcast_info')
      .row()
      .text('🔄 Обновить', 'admin_refresh')
      .text('🔙 В главное меню', 'back_to_menu');

    if (ctx.callbackQuery) {
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
        return;
      } catch {}
    }
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }

  // Toggle Subscription System Mode
  bot.callbackQuery('admin_toggle_sub_system', async (ctx: Context) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    const cur = db.isSubscriptionSystemEnabled();
    db.setSubscriptionSystemEnabled(!cur);
    await ctx.answerCallbackQuery({ text: `Система подписок: ${!cur ? 'ВКЛЮЧЕНА' : 'ВЫКЛЮЧЕНА'}` });
    await handleAdminPanel(ctx);
  });

  bot.command('sub_toggle', async (ctx: Context) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    const cur = db.isSubscriptionSystemEnabled();
    db.setSubscriptionSystemEnabled(!cur);
    await ctx.reply(`🔐 Система подписок теперь: <b>${!cur ? 'ВКЛЮЧЕНА' : 'ВЫКЛЮЧЕНА'}</b>`, { parse_mode: 'HTML' });
  });

  // Admin help info buttons
  bot.callbackQuery('admin_add_sub_info', async (ctx: Context) => {
    await ctx.answerCallbackQuery();
    const text = [
      '➕ <b>Как выдать подписку:</b>',
      '',
      'Используйте команду:',
      '<code>/sub_add &lt;user_id&gt; [дней]</code>',
      '',
      '<b>Примеры:</b>',
      '• <code>/sub_add 123456789 30</code> — выдать на 30 дней',
      '• <code>/sub_add 123456789 7</code> — выдать на 7 дней',
      '• <code>/sub_add 123456789 forever</code> — выдать навсегда',
    ].join('\n');
    await ctx.reply(text, { parse_mode: 'HTML' });
  });

  bot.callbackQuery('admin_remove_sub_info', async (ctx: Context) => {
    await ctx.answerCallbackQuery();
    const text = [
      '➖ <b>Как забрать подписку:</b>',
      '',
      'Используйте команду:',
      '<code>/sub_remove &lt;user_id&gt;</code>',
      '',
      '<b>Пример:</b>',
      '• <code>/sub_remove 123456789</code>',
    ].join('\n');
    await ctx.reply(text, { parse_mode: 'HTML' });
  });

  bot.callbackQuery('admin_broadcast_info', async (ctx: Context) => {
    await ctx.answerCallbackQuery();
    const text = [
      '📢 <b>Как сделать рассылку:</b>',
      '',
      'Используйте команду:',
      '<code>/broadcast &lt;текст сообщения&gt;</code>',
      '',
      'Сообщение получат все пользователи, зарегистрированные в боте.',
      '',
      'После команды бот попросит подтверждение — случайную рассылку отправить нельзя.',
    ].join('\n');
    await ctx.reply(text, { parse_mode: 'HTML' });
  });

  // /sub_add command
  bot.command('sub_add', async (ctx: Context) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) {
      await ctx.reply('⛔ Доступ запрещён.');
      return;
    }

    const parts = matchText(ctx).split(/\s+/).filter(Boolean);
    if (!parts[0]) {
      await ctx.reply('⚠️ Формат: <code>/sub_add &lt;user_id&gt; [дней|forever]</code>', { parse_mode: 'HTML' });
      return;
    }

    const targetId = parseInt(parts[0], 10);
    if (isNaN(targetId)) {
      await ctx.reply('❌ Неверный ID пользователя.');
      return;
    }

    const durationArg = parts[1] ? parts[1].toLowerCase() : '30';
    const days = durationArg === 'forever' ? 0 : parseInt(durationArg, 10) || 30;

    db.grantSubscription(targetId, days);

    const periodStr = days === 0 ? 'навсегда' : `на ${days} дней`;
    await ctx.reply(`✅ Пользователю <code>${targetId}</code> успешно выдана подписка <b>${periodStr}</b>!`, { parse_mode: 'HTML' });

    // Notify user if possible
    try {
      await bot.api.sendMessage(
        targetId,
        `🎉 <b>Вам активирована подписка на StarsBot (${periodStr})!</b>\nТеперь вы получаете все Real-Time обновления улучшений подарков.`,
        { parse_mode: 'HTML' }
      );
    } catch {}
  });

  // /sub_remove command
  bot.command('sub_remove', async (ctx: Context) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) {
      await ctx.reply('⛔ Доступ запрещён.');
      return;
    }

    const targetStr = matchText(ctx);
    const targetId = parseInt(targetStr, 10);
    if (isNaN(targetId)) {
      await ctx.reply('⚠️ Формат: <code>/sub_remove &lt;user_id&gt;</code>', { parse_mode: 'HTML' });
      return;
    }

    db.revokeSubscription(targetId);
    await ctx.reply(`❌ Подписка у пользователя <code>${targetId}</code> успешно аннулирована.`, { parse_mode: 'HTML' });

    try {
      await bot.api.sendMessage(
        targetId,
        `⚠️ Срок действия вашей подписки на StarsBot завершён. Для продления обратитесь к администраторам.`,
        { parse_mode: 'HTML' }
      );
    } catch {}
  });

  // /sub_list command & callback
  bot.command('sub_list', async (ctx: Context) => {
    await handleListSubs(ctx);
  });

  bot.callbackQuery('admin_list_subs', async (ctx: Context) => {
    await ctx.answerCallbackQuery();
    await handleListSubs(ctx);
  });

  async function handleListSubs(ctx: Context): Promise<void> {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;

    const all = db.getAllSubscribers();
    const paid = all.filter((s) => db.hasActiveSubscription(s.chatId) && !isAdmin(s.chatId));

    if (paid.length === 0) {
      await ctx.reply('📋 В данный момент нет пользователей с отдельной платной подпиской.');
      return;
    }

    const lines = ['📋 <b>Список активных подписчиков:</b>', ''];
    for (const p of paid.slice(0, 30)) {
      const exp = p.subscriptionExpiresAt === 'forever'
        ? 'навсегда'
        : (p.subscriptionExpiresAt ? new Date(p.subscriptionExpiresAt).toLocaleDateString('ru-RU') : 'активна');
      const name = p.username ? `@${p.username}` : (p.firstName || `ID ${p.chatId}`);
      lines.push(`• <b>${name}</b> (<code>${p.chatId}</code>): до ${exp}`);
    }

    if (paid.length > 30) {
      lines.push(`\n<i>...и ещё ${paid.length - 30} пользователей</i>`);
    }

    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  }

  // /broadcast command (two-step: request -> explicit confirmation)
  bot.command('broadcast', async (ctx: Context) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) {
      await ctx.reply('⛔ Доступ запрещён.');
      return;
    }

    const message = matchText(ctx);
    if (!message) {
      await ctx.reply('⚠️ Укажите текст рассылки: <code>/broadcast &lt;текст&gt;</code>', { parse_mode: 'HTML' });
      return;
    }

    // Telegram hard limit for a single message is 4096 characters.
    if (message.length > 4000) {
      await ctx.reply(`⚠️ Сообщение слишком длинное: ${message.length} символов (максимум 4000).`);
      return;
    }

    const recipients = db.getAllSubscribers().filter((s) => !s.isBlocked).length;
    pendingBroadcasts.set(ctx.from.id, { text: message, createdAt: Date.now() });

    const keyboard = new InlineKeyboard()
      .text('✅ Отправить всем', 'broadcast_confirm')
      .text('❌ Отмена', 'broadcast_cancel');

    await ctx.reply(
      `📢 Подтвердите рассылку для ${recipients} пользователей (действует 60 секунд):\n\n${message}`,
      { reply_markup: keyboard }
    );
  });

  bot.callbackQuery('broadcast_confirm', async (ctx: Context) => {
    await ctx.answerCallbackQuery();
    if (!ctx.from || !isAdmin(ctx.from.id)) return;

    const pending = pendingBroadcasts.get(ctx.from.id);
    if (!pending || Date.now() - pending.createdAt > BROADCAST_CONFIRM_TTL_MS) {
      pendingBroadcasts.delete(ctx.from.id);
      await ctx.reply('⌛ Подтверждение истекло. Запустите /broadcast заново.');
      return;
    }
    pendingBroadcasts.delete(ctx.from.id);

    const subs = db.getAllSubscribers().filter((s) => !s.isBlocked);
    await ctx.reply(`📢 Начинаю рассылку для ${subs.length} пользователей...`);

    let sent = 0;
    let failed = 0;
    for (const s of subs) {
      try {
        await bot.api.sendMessage(s.chatId, pending.text, { parse_mode: 'HTML' });
        sent++;
      } catch (err: any) {
        failed++;
        if (err?.error_code === 429) {
          const retryAfterSec = Number(err?.parameters?.retry_after ?? 1);
          await new Promise((r) => setTimeout(r, retryAfterSec * 1000));
        } else if (err?.error_code === 403) {
          db.markBlocked(s.chatId);
        }
      }
      await new Promise((r) => setTimeout(r, 40));
    }

    await ctx.reply(`✅ Рассылка завершена! Доставлено: ${sent}, ошибок: ${failed}.`);
  });

  bot.callbackQuery('broadcast_cancel', async (ctx: Context) => {
    await ctx.answerCallbackQuery({ text: 'Рассылка отменена' });
    if (ctx.from) pendingBroadcasts.delete(ctx.from.id);
    await ctx.reply('❌ Рассылка отменена.');
  });

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
      ageSec: 4,
      marketStatus: 'ON_PROFILE' as const,
      isChannel: false,
      isOnGetgems: false,
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
    const isUserAdmin = ctx.from && isAdmin(ctx.from.id);
    const lines = [
      '📖 <b>Справка по командам:</b>',
      '',
      '/start — Главное меню и статус',
      '/settings — Фильтры (каналы, Getgems, профили)',
      '/status — Статистика работы и аптайм',
      '/test — Протестировать уведомление',
    ];

    if (isUserAdmin) {
      lines.push(
        '',
        '👑 <b>Команды Администратора:</b>',
        '/admin — Интерактивная админ-панель',
        '/sub_toggle — Вкл/выкл систему подписок',
        '/sub_add &lt;id&gt; [дней] — Выдать подписку',
        '/sub_remove &lt;id&gt; — Забрать подписку',
        '/sub_list — Список активных подписок',
        '/broadcast &lt;текст&gt; — Рассылка всем пользователям'
      );
    }

    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });
}
