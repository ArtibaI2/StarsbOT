import http from 'http';
import { config } from './config/config.js';
import { createBot } from './bot/bot.js';
import { CraftStreamTracker } from './trackers/craftStreamTracker.js';
import { mtprotoService } from './trackers/mtprotoClient.js';
import { mrktHarvester } from './trackers/mrktHarvester.js';
import { db } from './storage/database.js';

async function bootstrap() {
  console.log('==================================================');
  console.log('🌟 Telegram Gift Upgrades Tracker Bot is starting...');
  console.log('==================================================');

  // Start lightweight HTTP server for Cloud Hosting health checks (Render / Koyeb / Railway)
  const port = process.env.PORT || 8080;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'StarsBot', uptimeSec: Math.floor(process.uptime()) }));
  });
  server.listen(port, () => {
    console.log(`🌐 Cloud Health Check server listening on port ${port}`);
  });

  if (!config.BOT_TOKEN) {
    console.error('❌ FATAL: BOT_TOKEN is empty! Please check your .env file.');
    process.exit(1);
  }

  // 1. Initialize Bot & Notifier
  const { bot, notifier } = createBot();

  // 2. Set Bot Commands for Telegram UI
  try {
    await bot.api.setMyCommands([
      { command: 'start', description: 'Главное меню и статус' },
      { command: 'status', description: 'Статистика и аптайм' },
      { command: 'test', description: 'Отправить тестовое уведомление' },
      { command: 'help', description: 'Справка' },
    ]);
    console.log('✅ Telegram bot commands registered successfully.');
  } catch (err: any) {
    console.warn('⚠️ Could not set bot commands:', err?.message || err);
  }

  // 3. Connect MTProto (Optional)
  await mtprotoService.init();

  // 4. Initialize Tracker: ONLY Gift Upgrades
  const craftTracker = new CraftStreamTracker(config.CRAFT_POLL_INTERVAL_SEC, config.TONAPI_KEY);

  // Wire event handlers to notifier
  craftTracker.onCraft(async (craft) => {
    await notifier.broadcastCraftEvent(craft);
  });

  // Start tracker
  craftTracker.start();

  // 5. Start MRKT Database Harvester (frequent updates)
  mrktHarvester.start();

  // 6. Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n🛑 Received ${signal}. Gracefully stopping...`);
    server.close();
    craftTracker.stop();
    mrktHarvester.stop();
    await mtprotoService.disconnect();
    db.saveSync();
    console.log('💾 Database state saved.');
    bot.stop();
    console.log('👋 Bot stopped safely.');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // 6. Start Bot Polling
  console.log('🚀 Starting bot polling...');
  bot.start({
    onStart: (botInfo) => {
      console.log(`🎉 Bot @${botInfo.username} is successfully running and waiting for messages!`);
    },
  });
}

bootstrap().catch((err) => {
  console.error('💥 Unhandled error in bootstrap:', err);
  process.exit(1);
});
