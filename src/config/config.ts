import dotenv from 'dotenv';
import { z } from 'zod';
import path from 'path';

dotenv.config();

const envSchema = z.object({
  BOT_TOKEN: z.string().min(10, 'BOT_TOKEN is required. Get one from @BotFather in Telegram.'),
  
  // MTProto settings (Optional for userbot capabilities)
  TELEGRAM_API_ID: z.coerce.number().optional(),
  TELEGRAM_API_HASH: z.string().optional(),
  TELEGRAM_SESSION: z.string().optional(),
  
  // TON Blockchain & Indexer API (Optional, for on-chain unique gift stream)
  TONAPI_KEY: z.string().optional(),

  // Intervals in seconds
  STORE_POLL_INTERVAL_SEC: z.coerce.number().default(30),
  CRAFT_POLL_INTERVAL_SEC: z.coerce.number().default(3),
  MRKT_SYNC_INTERVAL_SEC: z.coerce.number().default(60),

  // MRKT Marketplace API Token
  MRKT_AUTH_TOKEN: z.string().optional(),

  // Admin and Data
  ADMIN_CHAT_ID: z.coerce.number().optional(),
  DATA_DIR: z.string().default('./data'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Configuration validation error:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  if (!process.env.BOT_TOKEN) {
    console.error('\n👉 Please create a .env file with your BOT_TOKEN from @BotFather.');
    console.error('   Example: BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrSTUvwxyz');
  }
}

export const config = parsed.success ? parsed.data : {
  BOT_TOKEN: process.env.BOT_TOKEN || '',
  STORE_POLL_INTERVAL_SEC: 30,
  CRAFT_POLL_INTERVAL_SEC: 3,
  DATA_DIR: './data',
} as z.infer<typeof envSchema>;

export const resolvedDataDir = path.resolve(process.cwd(), config.DATA_DIR);

