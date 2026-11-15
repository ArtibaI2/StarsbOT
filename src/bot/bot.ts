import { Bot } from 'grammy';
import { config } from '../config/config.js';
import { Notifier } from '../notifier/notifier.js';
import { setupHandlers } from './handlers.js';

export function createBot(): { bot: Bot; notifier: Notifier } {
  const bot = new Bot(config.BOT_TOKEN);
  const notifier = new Notifier(bot);

  // Setup handlers and menus
  setupHandlers(bot, notifier);

  // Global error handler
  bot.catch((err) => {
    console.error('❌ [Bot Error]:', err.error);
  });

  return { bot, notifier };
}

