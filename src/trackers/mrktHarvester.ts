import axios from 'axios';
import { db } from '../storage/database.js';
import { config } from '../config/config.js';

export class MrktHarvester {
  private intervalSec: number;
  private timer: NodeJS.Timeout | null = null;
  private isHarvesting = false;
  private authToken?: string;

  constructor(intervalSec = 60, authToken?: string) {
    this.intervalSec = Math.max(15, intervalSec);
    this.authToken = authToken || config.MRKT_AUTH_TOKEN;
  }

  public setAuthToken(token: string): void {
    this.authToken = token;
  }

  public start(): void {
    if (this.timer) return;
    console.log(`🛍️ [MRKT Harvester] Started syncing MRKT database (every ${this.intervalSec}s)`);
    this.harvest();
    this.timer = setInterval(() => this.harvest(), this.intervalSec * 1000);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('🛑 [MRKT Harvester] Stopped.');
    }
  }

  public async harvest(): Promise<void> {
    if (this.isHarvesting) return;
    this.isHarvesting = true;

    try {
      let harvestedCount = 0;

      // 1. If MRKT auth token is present, query MRKT API directly
      if (this.authToken) {
        try {
          const res = await axios.post(
            'https://api.tgmrkt.io/api/v1/gifts/saling',
            { count: 100 },
            {
              headers: {
                'Authorization': `Bearer ${this.authToken}`,
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
              },
              timeout: 7000,
            }
          );

          const gifts = res.data?.gifts || [];
          for (const g of gifts) {
            const wallet = g.seller?.wallet || g.wallet || g.ownerAddress;
            const username = g.seller?.username || g.seller?.tgUsername || g.ownerUsername;

            if (wallet && username) {
              db.setWalletUsername(wallet, username, 'mrkt_api');
              harvestedCount++;
            }
          }
        } catch (err: any) {
          // If token expired or rate limited
          if (err.response?.status === 401) {
            console.warn('⚠️ [MRKT Harvester] MRKT token is expired or invalid.');
          }
        }
      }

      // 2. Continuous Discovery: Scan Recent Marketplace Deals & On-Chain Transfers
      try {
        const tonApiHeaders: Record<string, string> = { Accept: 'application/json' };
        if (config.TONAPI_KEY) {
          tonApiHeaders['Authorization'] = `Bearer ${config.TONAPI_KEY}`;
        }

        // Query minter and marketplace transfers
        const dealsRes = await axios.get(
          'https://tonapi.io/v2/accounts/0:158136239adb15dd59df90c641f9efd312cfeb8664f218f4c3e5fce9d95e6c07/events?limit=25',
          { headers: tonApiHeaders, timeout: 6000 }
        );

        const events = dealsRes.data?.events || [];
        for (const ev of events) {
          for (const act of ev.actions || []) {
            if (act.type === 'SmartContractExec' && act.SmartContractExec?.payload) {
              const senderMatch = act.SmartContractExec.payload.match(/RewriteSenderAddress:\s*([^\s\n]+)/);
              if (senderMatch && senderMatch[1]) {
                const rawAddr = senderMatch[1].trim();
                if (!db.getWalletUsername(rawAddr)) {
                  // Resolve and store
                  this.quickResolveAndCache(rawAddr);
                }
              }
            }
          }
        }
      } catch {}

      const totalKnown = Object.keys((db as any).data?.walletMappings || {}).length;
      if (harvestedCount > 0) {
        console.log(`✅ [MRKT Harvester] Added ${harvestedCount} new mappings. Total in DB: ${totalKnown}`);
      }
    } finally {
      this.isHarvesting = false;
    }
  }

  private async quickResolveAndCache(rawAddr: string): Promise<void> {
    try {
      const acc = await axios.get(`https://tonapi.io/v2/accounts/${encodeURIComponent(rawAddr)}`, { timeout: 3000 });
      if (acc.data?.name) {
        const name = acc.data.name.trim();
        let tgUsername: string | undefined;
        if (name.endsWith('.ton')) tgUsername = name.replace(/\.ton$/i, '');
        else if (name.endsWith('.t.me')) tgUsername = name.replace(/\.t.me$/i, '');
        else if (name.startsWith('@')) tgUsername = name.slice(1);
        else if (/^[a-zA-Z0-9_]{4,32}$/.test(name)) tgUsername = name;

        if (tgUsername) {
          db.setWalletUsername(rawAddr, tgUsername, 'stream_resolver');
        }
      }
    } catch {}
  }
}

export const mrktHarvester = new MrktHarvester(config.MRKT_SYNC_INTERVAL_SEC, config.MRKT_AUTH_TOKEN);

