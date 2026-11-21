import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { config } from '../config/config.js';

/**
 * One-time interactive login that produces a TELEGRAM_SESSION string.
 *
 * Why a user session and not the bot token:
 * payments.getUniqueStarGift is a user-only MTProto method
 * (https://core.telegram.org/method/payments.getUniqueStarGift),
 * so a bot account cannot call it.
 */
async function main(): Promise<void> {
  const apiId = config.TELEGRAM_API_ID;
  const apiHash = config.TELEGRAM_API_HASH;

  if (!apiId || !apiHash) {
    console.error('❌ Set TELEGRAM_API_ID and TELEGRAM_API_HASH in .env first (https://my.telegram.org).');
    process.exit(1);
  }

  const rl = readline.createInterface({ input, output });
  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 5,
  });

  try {
    await client.start({
      phoneNumber: async () =>
        rl.question('Phone number in international format (e.g. +79991234567): '),
      phoneCode: async () => rl.question('Login code from Telegram: '),
      password: async (hint) =>
        rl.question(`Two-factor password${hint ? ` (hint: ${hint})` : ''} (leave empty if not set): `),
      onError: (err) => {
        console.error('MTProto auth error:', err.message);
      },
    });

    const session = client.session.save();
    console.log('\n✅ Authorized. Add this line to your .env / host environment:\n');
    console.log(`TELEGRAM_SESSION=${session}\n`);
    console.log('⚠️ Keep it secret: this session grants access to the account.');
  } finally {
    await client.disconnect();
    rl.close();
  }
}

main().catch((err) => {
  console.error('❌ Failed to create MTProto session:', err);
  process.exit(1);
});
