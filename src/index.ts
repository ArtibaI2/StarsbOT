import http from 'http';
import { config } from './config/config.js';
import { createBot } from './bot/bot.js';
import { CraftStreamTracker } from './trackers/craftStreamTracker.js';
import { StoreUpgradeTracker } from './trackers/storeUpgradeTracker.js';
import { ListingTracker } from './trackers/listingTracker.js';
import { mtprotoService } from './trackers/mtprotoClient.js';
import { mrktHarvester } from './trackers/mrktHarvester.js';
import { db } from './storage/database.js';

async function bootstrap() {
  console.log('==================================================');
  console.log('🌟 Telegram Gift Upgrades Tracker Bot is starting...');
  console.log('==================================================');

  // Start lightweight HTTP server for Cloud Hosting health checks (Render / Koyeb / Railway)
  const port = Number(process.env.PORT) || 8080;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'StarsBot', uptimeSec: Math.floor(process.uptime()) }));
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    console.error(`❌ Health-check server error on port ${port}:`, err.message);
    if (err.code === 'EADDRINUSE') {
      console.error('   Port is already in use. Set a different PORT in .env.');
    }
    process.exit(1);
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
      { command: 'settings', description: 'Настройки и фильтры (каналы, Getgems)' },
      { command: 'status', description: 'Статистика и аптайм' },
      { command: 'test', description: 'Отправить тестовое уведомление' },
      { command: 'admin', description: 'Панель администратора (только для админов)' },
      { command: 'help', description: 'Справка по командам' },
    ]);
    console.log('✅ Telegram bot commands registered successfully.');
  } catch (err: any) {
    console.warn('⚠️ Could not set bot commands:', err?.message || err);
  }

  // 3. Connect MTProto (optional, required for authoritative profile validation)
  await mtprotoService.init();

  // 4. Gift upgrades stream (Fragment Gift Minter events via TonAPI)
  const craftTracker = new CraftStreamTracker(config.CRAFT_POLL_INTERVAL_SEC, config.TONAPI_KEY);
  craftTracker.onCraft(async (craft) => {
    await notifier.broadcastCraftEvent(craft);
  });
  craftTracker.start();

  // 5. Telegram Gift Store changes (upgrade opened / price / supply / sold out)
  const storeTracker = new StoreUpgradeTracker(bot, config.STORE_POLL_INTERVAL_SEC);
  storeTracker.onEvent(async (event, gift) => {
    await notifier.broadcastUpgradeEvent(event, gift);
  });
  storeTracker.start();

  // 6. Gift sale listings on the TON blockchain
  const listingTracker = new ListingTracker(config.MRKT_SYNC_INTERVAL_SEC, config.TONAPI_KEY);
  listingTracker.onListing(async (listing) => {
    await notifier.broadcastListingEvent(listing);
  });
  listingTracker.start();

  // 7. MRKT wallet→username harvester
  mrktHarvester.start();

  // 8. Graceful shutdown (idempotent)
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`\n🛑 Received ${signal}. Gracefully stopping...`);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    craftTracker.stop();
    storeTracker.stop();
    listingTracker.stop();
    mrktHarvester.stop();
    await mtprotoService.disconnect();
    db.saveSync();
    console.log('💾 Database state saved.');
    try {
      await bot.stop();
    } catch (err: any) {
      console.warn('⚠️ Error while stopping bot:', err?.message || err);
    }
    console.log('👋 Bot stopped safely.');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // 9. Start Bot Polling
  console.log('🚀 Starting bot polling...');
  bot
    .start({
      onStart: (botInfo) => {
        console.log(`🎉 Bot @${botInfo.username} is successfully running and waiting for messages!`);
      },
    })
    .catch((err: any) => {
      console.error('💥 Bot polling failed:', err?.message || err);
      process.exit(1);
    });
}

bootstrap().catch((err) => {
  console.error('💥 Unhandled error in bootstrap:', err);
  process.exit(1);
});
