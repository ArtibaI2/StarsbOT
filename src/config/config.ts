import dotenv from 'dotenv';
import { z } from 'zod';
import path from 'path';

dotenv.config();

function parseAdminIds(value: string | undefined): number[] {
  return (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => Number(part))
    .filter((id) => Number.isInteger(id) && id > 0);
}

const envSchema = z.object({
  BOT_TOKEN: z.string().min(10, 'BOT_TOKEN is required. Get one from @BotFather in Telegram.'),

  // MTProto settings (required for authoritative profile validation)
  TELEGRAM_API_ID: z.coerce.number().optional(),
  TELEGRAM_API_HASH: z.string().optional(),
  TELEGRAM_SESSION: z.string().optional(),

  // TON Blockchain & Indexer API (optional, for on-chain unique gift stream)
  TONAPI_KEY: z.string().optional(),

  // Intervals in seconds
  STORE_POLL_INTERVAL_SEC: z.coerce.number().default(30),
  CRAFT_POLL_INTERVAL_SEC: z.coerce.number().default(3),
  MRKT_SYNC_INTERVAL_SEC: z.coerce.number().default(60),

  // MRKT Marketplace API Token
  MRKT_AUTH_TOKEN: z.string().optional(),

  // Comma-separated Telegram user IDs with admin access
  ADMIN_IDS: z
    .string()
    .optional()
    .transform((value) => parseAdminIds(value)),

  // Data directory
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

// Typed fallback used only when validation fails (e.g. missing BOT_TOKEN).
// It never pretends that missing values are present.
const fallback: z.infer<typeof envSchema> = {
  BOT_TOKEN: process.env.BOT_TOKEN || '',
  TELEGRAM_API_ID: process.env.TELEGRAM_API_ID ? Number(process.env.TELEGRAM_API_ID) : undefined,
  TELEGRAM_API_HASH: process.env.TELEGRAM_API_HASH,
  TELEGRAM_SESSION: process.env.TELEGRAM_SESSION,
  TONAPI_KEY: process.env.TONAPI_KEY,
  STORE_POLL_INTERVAL_SEC: 30,
  CRAFT_POLL_INTERVAL_SEC: 3,
  MRKT_SYNC_INTERVAL_SEC: 60,
  MRKT_AUTH_TOKEN: process.env.MRKT_AUTH_TOKEN,
  ADMIN_IDS: parseAdminIds(process.env.ADMIN_IDS),
  DATA_DIR: process.env.DATA_DIR || './data',
};

export const config = parsed.success ? parsed.data : fallback;

if (config.ADMIN_IDS.length === 0) {
  console.warn(
    '⚠️ ADMIN_IDS is empty — nobody can access the admin panel. ' +
      'Set ADMIN_IDS in .env (comma-separated Telegram user IDs).'
  );
}

export const resolvedDataDir = path.resolve(process.cwd(), config.DATA_DIR);
