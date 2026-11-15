import { Bot, InlineKeyboard } from 'grammy';
import dotenv from 'dotenv';
dotenv.config();

const bot = new Bot(process.env.BOT_TOKEN || '8832217716:AAERjQW_stRmuYpmkVFOzurKP52dH0GwiUY');

async function main() {
  const text = [
    '🎁 <b>ПОДАРОК УЛУЧШЕН!</b>',
    '',
    '🏷️ <b>Вид подарка:</b> <b>Mirage Lamp #52415</b>',
    '🎨 <b>Модель:</b> <code>Deep Forest</code>',
    '🌌 <b>Фон (Backdrop):</b> <code>Camo Green</code>',
    '💠 <b>Символ (Pattern):</b> <code>Gem</code>',
    '',
    '👤 <b>Ник улучшившего:</b> <a href="https://t.me/hatemysocials"><b>@hatemysocials</b></a> <code>(hatemysocials.ton)</code> 💬 <i>(нажмите, чтобы написать)</i>',
    '🏛 <b>Платформы:</b> <a href="https://t.me/nft/miragelamp-52415">Telegram</a> • <a href="https://t.me/mrkt">MRKT (МКТ)</a> • <a href="https://fragment.com/gift/miragelamp-52415">Fragment</a> • <a href="https://getgems.io">Getgems</a>',
    '',
    '🕒 <i>Зафиксировано в 14:42:25 MSK</i>',
  ].join('\n');

  const kb = new InlineKeyboard()
    .url('💬 Написать @hatemysocials', 'https://t.me/hatemysocials').row()
    .url('📱 Профиль в Telegram (t.me/nft)', 'https://t.me/nft/miragelamp-52415')
    .url('🛍️ MRKT (МКТ)', 'https://t.me/mrkt').row()
    .url('🌐 Fragment', 'https://fragment.com/gift/miragelamp-52415')
    .url('💎 Getgems', 'https://getgems.io').row()
    .url('🔍 Tonviewer', 'https://tonviewer.com/hatemysocials.ton');

  for (const chatId of [8230668674, 6175753245]) {
    try {
      await bot.api.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        reply_markup: kb,
      });
      console.log(`Sent sample notification to ${chatId}`);
    } catch (e: any) {
      console.error(`Failed to send to ${chatId}:`, e.message);
    }
  }
}

main();

