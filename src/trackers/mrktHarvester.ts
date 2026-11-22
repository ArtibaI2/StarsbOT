import axios from 'axios';
import { db } from '../storage/database.js';
import { config } from '../config/config.js';
import { SendPacer } from '../notifier/sendPacer.js';
import { tonApi, TonApiRateLimitError } from './tonApiClient.js';

export { parseRetryAfter } from './tonApiClient.js';

const MRKT_API_URL = 'https://api.tgmrkt.io/api/v1/gifts/saling';

// Wallet resolution is a background nicety, not a real-time feed: it only
// enriches owner names that MTProto usually already provides. Keep it rare and
// cheap so it never competes with the upgrade stream for the TON API budget.
const RESOLVE_MIN_INTERVAL_MS = 1200;
const MAX_RESOLVES_PER_CYCLE = 3;
const DISCOVERY_INTERVAL_MS = 5 * 60 * 1000;
const FAILED_TTL_MS = 10 * 60 * 1000;
const MRKT_429_COOLDOWN_MS = 5 * 60 * 1000;

export class MrktHarvester {
  private intervalSec: number;
  private timer: NodeJS.Timeout | null = null;
  private isHarvesting = false;
  private authToken?: string;

  /** Serializes address resolutions so they never run concurrently. */
  private resolvePacer = new SendPacer(RESOLVE_MIN_INTERVAL_MS);
  private pendingResolves = new Set<string>();
  private failedResolves = new Map<string, number>();
  private mrktCooldownUntil = 0;
  private nextDiscoveryAt = 0;

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
      if (this.authToken && Date.now() >= this.mrktCooldownUntil) {
        try {
          const res = await axios.post(
            MRKT_API_URL,
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
          const status = err?.response?.status;
          if (status === 401) {
            console.warn('⚠️ [MRKT Harvester] MRKT token is expired or invalid.');
          } else if (status === 429) {
            this.mrktCooldownUntil = Date.now() + MRKT_429_COOLDOWN_MS;
            console.warn('⚠️ [MRKT Harvester] MRKT API rate limit (429). Pausing MRKT sync for 5 minutes.');
          } else {
            console.warn('⚠️ [MRKT Harvester] MRKT API request failed:', err?.message || err);
          }
        }
      }

      // 2. Occasional discovery of wallet→username mappings from recent deals.
      if (Date.now() >= this.nextDiscoveryAt && !tonApi.isCoolingDown()) {
        this.nextDiscoveryAt = Date.now() + DISCOVERY_INTERVAL_MS;
        try {
          const dealsRes = await tonApi.get(
            '/accounts/0:158136239adb15dd59df90c641f9efd312cfeb8664f218f4c3e5fce9d95e6c07/events?limit=25'
          );

          const addresses = new Set<string>();
          const events = dealsRes?.events || [];
          for (const ev of events) {
            for (const act of ev.actions || []) {
              if (act.type === 'SmartContractExec' && act.SmartContractExec?.payload) {
                const senderMatch = act.SmartContractExec.payload.match(/RewriteSenderAddress:\s*([^\s\n]+)/);
                if (senderMatch?.[1]) {
                  const rawAddr = senderMatch[1].trim();
                  if (rawAddr && !db.getWalletUsername(rawAddr)) {
                    addresses.add(rawAddr);
                  }
                }
              }
            }
          }

          const toResolve = Array.from(addresses).slice(0, MAX_RESOLVES_PER_CYCLE);
          await Promise.all(toResolve.map((addr) => this.quickResolveAndCache(addr)));
        } catch (err: any) {
          // Rate limits are handled and logged once by the shared TON API gate.
          if (!(err instanceof TonApiRateLimitError)) {
            console.warn('⚠️ [MRKT Harvester] Failed to scan marketplace events:', err?.message || err);
          }
        }
      }

      const totalKnown = db.getWalletMappingsCount();
      if (harvestedCount > 0) {
        console.log(`✅ [MRKT Harvester] Added ${harvestedCount} new mappings. Total in DB: ${totalKnown}`);
      }
    } finally {
      this.isHarvesting = false;
    }
  }

  private async quickResolveAndCache(rawAddr: string): Promise<void> {
    if (this.pendingResolves.has(rawAddr)) return;

    const failedAt = this.failedResolves.get(rawAddr);
    if (failedAt && Date.now() - failedAt < FAILED_TTL_MS) return;

    this.pendingResolves.add(rawAddr);
    try {
      await this.resolvePacer.run(async () => {
        // Re-check under the pacer: another cycle may have resolved it already.
        if (db.getWalletUsername(rawAddr)) return;
        if (tonApi.isCoolingDown()) return;

        try {
          const acc = await tonApi.get(`/accounts/${encodeURIComponent(rawAddr)}`);
          if (acc?.name) {
            const name = acc.name.trim();
            let tgUsername: string | undefined;
            if (name.endsWith('.ton')) tgUsername = name.replace(/\.ton$/i, '');
            else if (name.endsWith('.t.me')) tgUsername = name.replace(/\.t\.me$/i, '');
            else if (name.startsWith('@')) tgUsername = name.slice(1);
            else if (/^[a-zA-Z0-9_]{4,32}$/.test(name)) tgUsername = name;

            if (tgUsername) {
              db.setWalletUsername(rawAddr, tgUsername, 'stream_resolver');
            }
          }
          this.failedResolves.delete(rawAddr);
        } catch (err: any) {
          this.failedResolves.set(rawAddr, Date.now());
          if (!(err instanceof TonApiRateLimitError)) {
            console.warn('⚠️ [MRKT Harvester] Failed to resolve wallet address:', err?.message || err);
          }
        }
      });
    } finally {
      this.pendingResolves.delete(rawAddr);
    }
  }
}

export const mrktHarvester = new MrktHarvester(config.MRKT_SYNC_INTERVAL_SEC, config.MRKT_AUTH_TOKEN);
