import axios from 'axios';
import { db } from '../storage/database.js';
import { GiftListingEvent } from '../types/gift.js';
// Known Telegram Collectible Gift Collections on TON blockchain
export const KNOWN_GIFT_COLLECTIONS: { id: string; name: string; address: string }[] = [
  { id: 'valentine_box', name: 'Valentine Box', address: 'EQDjBdu3zS-JT94OwIup4KVNaQjxDzGcIPRJ24Ha0Y8jLw83' },
  { id: 'plush_pepe', name: 'Plush Pepe', address: 'EQBG-g6ahkAUGWpefWbx-D_9sQ8oWbvy6puuq78U2c4NUDFS' },
  { id: 'chill_flame', name: 'Chill Flame', address: 'EQBlBJ4n01pmYez5VPd8Wo598s8agbQCyVOjucXKxLDAi9r7' },
  { id: 'vice_cream', name: 'Vice Cream', address: 'EQDc08YxzZWtlKAohSybNc3kXAkAPPtHch-jY_E6KMQ3b1mn' },
  { id: 'precious_peach', name: 'Precious Peach', address: 'EQA4i58iuS9DUYRtUZ97sZo5mnkbiYUBpWXQOe3dEUCcP1W8' },
];

export type ListingEventCallback = (listing: GiftListingEvent) => Promise<void>;

export class ListingTracker {
  private intervalSec: number;
  private tonApiKey?: string;
  private timer: NodeJS.Timeout | null = null;
  private isChecking = false;
  private onListingCallbacks: ListingEventCallback[] = [];

  constructor(intervalSec = 20, tonApiKey?: string) {
    this.intervalSec = Math.max(10, intervalSec);
    this.tonApiKey = tonApiKey;
  }

  public onListing(callback: ListingEventCallback): void {
    this.onListingCallbacks.push(callback);
  }

  public start(): void {
    if (this.timer) return;
    console.log(`🏷️ [ListingTracker] Started monitoring gift sale listings (every ${this.intervalSec}s)`);
    this.check();
    this.timer = setInterval(() => this.check(), this.intervalSec * 1000);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('🛑 [ListingTracker] Stopped.');
    }
  }

  public async check(): Promise<void> {
    if (this.isChecking) return;
    this.isChecking = true;

    try {
      db.updateLastCheck('listing');
      await this.pollListings();
    } catch (err: any) {
      console.error('⚠️ [ListingTracker] Polling error:', err?.message || err);
    } finally {
      this.isChecking = false;
    }
  }

  private async pollListings(): Promise<void> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (this.tonApiKey) {
      headers['Authorization'] = `Bearer ${this.tonApiKey}`;
    }

    const isBaseline = !db.isListingBaselineSet();
    const newListings: GiftListingEvent[] = [];

    for (const col of KNOWN_GIFT_COLLECTIONS) {
      try {
        const url = `https://tonapi.io/v2/nfts/collections/${encodeURIComponent(col.address)}/items?limit=25`;
        const res = await axios.get(url, { headers, timeout: 8000 });
        const items = res.data?.nft_items || [];

        for (const item of items) {
          if (!item.sale) continue; // Only process items with an active sale listing

          const sale = item.sale;
          const saleAddress = sale.address || `${item.address}_${sale.price?.value}`;
          const listingKey = `listing_${saleAddress}`;

          if (db.isListingSeen(listingKey)) {
            continue; // Already sent
          }

          db.markListingSeen(listingKey);

          if (isBaseline) {
            continue; // Record baseline during initial startup
          }

          // Price calculation
          const decimals = sale.price?.decimals || 9;
          const rawPrice = Number(sale.price?.value || 0);
          const priceTon = parseFloat((rawPrice / Math.pow(10, decimals)).toFixed(2));

          const metadata = item.metadata || {};
          const attributes = Array.isArray(metadata.attributes) ? metadata.attributes : [];

          // Attributes extraction
          const getAttr = (name: string): string => {
            const found = attributes.find(
              (a: any) => (a.trait_type || '').toLowerCase() === name.toLowerCase()
            );
            return found ? String(found.value || '') : '';
          };

          const modelName = getAttr('Model') || 'Classic';
          const backdropName = getAttr('Backdrop');
          const symbolName = getAttr('Symbol') || getAttr('Pattern');

          let num = 0;
          const numMatch = (metadata.name || '').match(/#\s*(\d+)/);
          if (numMatch) {
            num = parseInt(numMatch[1], 10);
          } else if (typeof item.index === 'number') {
            num = Math.abs(item.index % 100000);
          }

          // Platform identification (MRKT / Fragment / Getgems)
          let platformName = 'MRKT (МКТ)';
          let platformUrl = `https://t.me/mrkt`;

          const marketName = (sale.market?.name || '').toLowerCase();
          if (marketName.includes('fragment') || marketName.includes('teleitem')) {
            platformName = 'Fragment';
            let tokenSlug = '';
            if (metadata.image) {
              const slugMatch = metadata.image.match(/gift\/([^./]+)/);
              if (slugMatch) tokenSlug = slugMatch[1];
            }
            platformUrl = tokenSlug ? `https://fragment.com/gift/${tokenSlug}` : 'https://fragment.com';
          } else if (marketName.includes('getgems')) {
            platformName = 'Getgems';
            platformUrl = `https://getgems.io/nft/${item.address}`;
          } else if (marketName.includes('mrkt') || marketName.includes('market')) {
            platformName = 'MRKT (МКТ)';
            platformUrl = `https://t.me/mrkt`;
          }

          // Seller name resolution
          let sellerName = sale.owner?.name || '';
          const sellerAddress = sale.owner?.address || '';
          if (!sellerName && sellerAddress) {
            sellerName = `${sellerAddress.slice(0, 6)}...${sellerAddress.slice(-4)}`;
          }

          const listingEvent: GiftListingEvent = {
            id: listingKey,
            giftId: col.id,
            giftTitle: col.name,
            num,
            modelName,
            backdropName: backdropName || undefined,
            symbolName: symbolName || undefined,
            description: metadata.description,
            imageUrl: metadata.image || (item.previews && item.previews[2]?.url),
            priceTon,
            platformName,
            platformUrl,
            sellerName: sellerName || undefined,
            sellerAddress: sellerAddress || undefined,
            timestamp: new Date().toISOString(),
          };

          newListings.push(listingEvent);
        }
      } catch (colErr: any) {
        if (colErr?.response?.status === 429) {
          break;
        }
      }
    }

    if (isBaseline) {
      db.setListingBaseline();
      console.log('✅ [ListingTracker] Baseline snapshot initialized for sales listings.');
    } else {
      for (const listing of newListings) {
        await this.emitListing(listing);
      }
    }
  }

  public async emitListing(listing: GiftListingEvent): Promise<void> {
    console.log(
      `🏷️ [Listing Detected] ${listing.giftTitle} #${listing.num} | Price: ${listing.priceTon} TON | Platform: ${listing.platformName}`
    );
    for (const cb of this.onListingCallbacks) {
      try {
        await cb(listing);
      } catch (err) {
        console.error('❌ Error handling gift listing event callback:', err);
      }
    }
  }
}
