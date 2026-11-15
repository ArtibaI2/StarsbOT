import { Menu } from '@grammyjs/menu';
import { db } from '../storage/database.js';

export const settingsMenu = new Menu('settings-menu')
  .text(
    (ctx) => {
      const sub = ctx.chat?.id ? db.getSubscriber(ctx.chat.id) : undefined;
      const status = (sub?.notifyUpgrades ?? true) ? '🔔 Вкл' : '🔕 Выкл';
      return `Магазин & Апгрейды: ${status}`;
    },
    async (ctx) => {
      if (!ctx.chat?.id) return;
      const sub = db.getSubscriber(ctx.chat.id);
      const nextVal = !(sub?.notifyUpgrades ?? true);
      db.updatePreferences(ctx.chat.id, { notifyUpgrades: nextVal });
      await ctx.menu.update();
    }
  )
  .row()
  .text(
    (ctx) => {
      const sub = ctx.chat?.id ? db.getSubscriber(ctx.chat.id) : undefined;
      const status = (sub?.notifyCrafts ?? true) ? '🔔 Вкл' : '🔕 Выкл';
      return `Поток улучшений: ${status}`;
    },
    async (ctx) => {
      if (!ctx.chat?.id) return;
      const sub = db.getSubscriber(ctx.chat.id);
      const nextVal = !(sub?.notifyCrafts ?? true);
      db.updatePreferences(ctx.chat.id, { notifyCrafts: nextVal });
      await ctx.menu.update();
    }
  )
  .row()
  .text(
    (ctx) => {
      const sub = ctx.chat?.id ? db.getSubscriber(ctx.chat.id) : undefined;
      const status = (sub?.notifyListings ?? true) ? '🔔 Вкл' : '🔕 Выкл';
      return `Выставлен на продажу: ${status}`;
    },
    async (ctx) => {
      if (!ctx.chat?.id) return;
      const sub = db.getSubscriber(ctx.chat.id);
      const nextVal = !(sub?.notifyListings ?? true);
      db.updatePreferences(ctx.chat.id, { notifyListings: nextVal });
      await ctx.menu.update();
    }
  )
  .row()
  .text(
    (ctx) => {
      const sub = ctx.chat?.id ? db.getSubscriber(ctx.chat.id) : undefined;
      const price = sub?.maxListingPriceTon;
      const priceLabel = price ? `до ${price} TON` : 'Все цены';
      return `💰 Фильтр цены: [${priceLabel}]`;
    },
    async (ctx) => {
      if (!ctx.chat?.id) return;
      const sub = db.getSubscriber(ctx.chat.id);
      const prices: Array<number | undefined> = [undefined, 10, 25, 50, 100, 250, 500];
      const current = sub?.maxListingPriceTon;
      const currIdx = prices.indexOf(current);
      const nextIdx = (currIdx + 1) % prices.length;
      const nextPrice = prices[nextIdx];
      db.updatePreferences(ctx.chat.id, { maxListingPriceTon: nextPrice });
      await ctx.menu.update();
    }
  )
  .row()
  .text(
    (ctx) => {
      const sub = ctx.chat?.id ? db.getSubscriber(ctx.chat.id) : undefined;
      const rarity = sub?.minRarity || 'ALL';
      return `🏅 Редкость: [${rarity}]`;
    },
    async (ctx) => {
      if (!ctx.chat?.id) return;
      const sub = db.getSubscriber(ctx.chat.id);
      const current = sub?.minRarity || 'ALL';
      const order: Array<'ALL' | 'UNCOMMON' | 'RARE' | 'EPIC' | 'LEGENDARY'> = [
        'ALL',
        'UNCOMMON',
        'RARE',
        'EPIC',
        'LEGENDARY',
      ];
      const nextIdx = (order.indexOf(current) + 1) % order.length;
      const nextRarity = order[nextIdx];
      db.updatePreferences(ctx.chat.id, { minRarity: nextRarity });
      await ctx.menu.update();
    }
  )
  .row()
  .text('🔄 Обновить меню', async (ctx) => {
    await ctx.menu.update();
  });
