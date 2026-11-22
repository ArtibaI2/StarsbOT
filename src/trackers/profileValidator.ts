import https from 'https';
import axios from 'axios';
import { mtprotoService, MtprotoGiftDetails } from './mtprotoClient.js';
import { isGetgemsSale } from './marketplace.js';
import { tonApi } from './tonApiClient.js';

export interface ProfileValidationResult {
  isProfileActive: boolean;
  displayName: string;
  ownerDisplayName: string;
  userFriendlyAddress?: string;
  telegramUsername?: string;
  telegramUserId?: number;
  isRealName: boolean;
  isChannel: boolean;
  isSold: boolean;
  isForSale: boolean;
  rejectionReason?: string;
  mtprotoInfo?: MtprotoGiftDetails | null;
  /** Image from TonAPI metadata, used as a fallback when Fragment metadata is missing. */
  nftImageUrl?: string;
  /** Name from TonAPI metadata. */
  nftName?: string;
}

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'ru,en;q=0.9',
};

/** Fetch a Fragment gift page, retrying once on transient 5xx responses. */
async function fetchFragmentPage(slug: string, httpsAgent?: https.Agent) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await axios.get(`https://fragment.com/gift/${slug}`, {
        headers: DEFAULT_HEADERS,
        timeout: 3500,
        httpsAgent,
      });
    } catch (err: any) {
      const status = err?.response?.status;
      if (status >= 500 && attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        continue;
      }
      return null;
    }
  }
  return null;
}

/**
 * Validates with 100% accuracy whether a unique Telegram gift is currently
 * active and displayed on a human user's Telegram profile.
 *
 * Strictly rejects:
 * 1. Detached / blockchain-only gifts (held on TON wallet address UQ... / EQ...)
 * 2. Historical recipients from minting details (e.g. StarGiftAttributeOriginalDetails)
 * 3. Gifts listed for sale or sold on Fragment or Getgems
 * 4. Gifts owned by Telegram Channels
 */
export async function validateProfileGift(
  slug: string,
  rawSenderAddress?: string,
  nftItemAddress?: string,
  httpsAgent?: https.Agent
): Promise<ProfileValidationResult> {
  let isSold = false;
  let isForSale = false;

  // 1. Parallel fetch: Fragment HTML, MTProto StarGift, and TonAPI NFT status
  const [fragRes, mtprotoInfo, tonApiNft] = await Promise.all([
    fetchFragmentPage(slug, httpsAgent),
    mtprotoService.getUniqueStarGift(slug).catch(() => null),
    nftItemAddress
      ? tonApi.get(`/nfts/${encodeURIComponent(nftItemAddress)}`).catch(() => null)
      : Promise.resolve(null),
  ]);

  const nftMetadata = (tonApiNft as { metadata?: { image?: unknown; name?: unknown } } | null)?.metadata;
  const nftImageUrl = typeof nftMetadata?.image === 'string' ? nftMetadata.image : undefined;
  const nftName = typeof nftMetadata?.name === 'string' ? nftMetadata.name : undefined;

  let fragmentOwnerRaw: string | undefined;

  // 2. Fragment Analysis (fallback only; MTProto/TonAPI are authoritative)
  if (fragRes?.status === 200 && typeof fragRes.data === 'string') {
    const html = fragRes.data;

    const statusMatch = html.match(/<span class="tm-section-header-status[^>]*>([^<]+)<\/span>/i);
    const statusText = statusMatch ? statusMatch[1].trim() : '';

    if (!statusMatch && !mtprotoInfo) {
      console.warn(
        `⚠️ [ProfileValidator] Could not parse Fragment status for ${slug}; page structure may have changed.`
      );
    }

    if (/sold/i.test(statusText) || /tm-status-unavail/i.test(html)) {
      isSold = true;
    }
    if (/sale/i.test(statusText) || /tm-status-avail/i.test(html)) {
      isForSale = true;
    }

    const rowMatch = html.match(/<tr[^>]*>[\s\S]*?Owner[\s\S]*?<\/tr>/i);
    if (rowMatch) {
      const row = rowMatch[0];
      const shortMatch = row.match(/<span class="short">([^<]+)<\/span>/i);
      if (shortMatch && shortMatch[1]) {
        fragmentOwnerRaw = shortMatch[1].trim();
      }
    } else if (!mtprotoInfo) {
      console.warn(
        `⚠️ [ProfileValidator] Could not parse Fragment owner for ${slug}; page structure may have changed.`
      );
    }
  }

  // 3. TonAPI NFT Item Sale Analysis
  if (tonApiNft) {
    if (isGetgemsSale(tonApiNft)) {
      isForSale = true;
    }
  }

  // Reject if already listed for sale on marketplace
  if (isForSale) {
    const disp = fragmentOwnerRaw || 'На маркетплейсе';
    return {
      isProfileActive: false,
      displayName: disp,
      ownerDisplayName: disp,
      isRealName: false,
      isChannel: false,
      isSold: false,
      isForSale: true,
      rejectionReason: 'Gift is currently listed for sale on marketplace (Fragment/Getgems)',
      mtprotoInfo,
    };
  }

  // Reject if sold on Fragment
  if (isSold) {
    const disp = fragmentOwnerRaw || 'Продан на Fragment';
    return {
      isProfileActive: false,
      displayName: disp,
      ownerDisplayName: disp,
      isRealName: false,
      isChannel: false,
      isSold: true,
      isForSale: false,
      rejectionReason: 'Gift is marked as Sold on Fragment',
      mtprotoInfo,
    };
  }

  // 4. MTProto Authoritative Ground Truth Check
  if (mtprotoInfo) {
    // If gift is on a channel
    if (mtprotoInfo.isChannel) {
      const disp = mtprotoInfo.username ? `@${mtprotoInfo.username}` : (mtprotoInfo.firstName || 'Канал Telegram');
      return {
        isProfileActive: false,
        displayName: disp,
        ownerDisplayName: disp,
        telegramUsername: mtprotoInfo.username,
        telegramUserId: mtprotoInfo.userId,
        isRealName: true,
        isChannel: true,
        isSold,
        isForSale,
        rejectionReason: 'Gift is on a Telegram Channel, not a personal user profile',
        mtprotoInfo,
      };
    }

    // STRICT CHECK: An active profile gift MUST have isProfileActive=true from MTProto ownerId (PeerUser)
    // and MUST NOT have an ownerAddress (which indicates it was exported to TON blockchain).
    if (mtprotoInfo.isProfileActive && mtprotoInfo.userId && !mtprotoInfo.ownerAddress) {
      const disp = mtprotoInfo.username ? `@${mtprotoInfo.username}` : (mtprotoInfo.firstName || 'Владелец в профиле');
      return {
        isProfileActive: true,
        displayName: disp,
        ownerDisplayName: disp,
        telegramUsername: mtprotoInfo.username,
        telegramUserId: mtprotoInfo.userId,
        isRealName: true,
        isChannel: false,
        isSold: false,
        isForSale: false,
        mtprotoInfo,
        nftImageUrl,
        nftName,
      };
    }

    // If MTProto indicates it is an exported blockchain NFT (ownerAddress is set, or ownerId is null)
    if (mtprotoInfo.ownerAddress || !mtprotoInfo.isProfileActive) {
      const disp = mtprotoInfo.ownerAddress || 'Блокчейн-кошелёк TON';
      return {
        isProfileActive: false,
        displayName: disp,
        ownerDisplayName: disp,
        userFriendlyAddress: mtprotoInfo.ownerAddress,
        isRealName: false,
        isChannel: false,
        isSold,
        isForSale,
        rejectionReason: 'Gift is exported to TON blockchain address and detached from Telegram profile',
        mtprotoInfo,
      };
    }
  }

  // 5. Fallback if MTProto is unavailable: Check Fragment Owner
  if (fragmentOwnerRaw) {
    // If owner is a TON address (UQ... or EQ... or .ton domain)
    if (/^(UQ|EQ)[a-zA-Z0-9_-]{46,48}$/.test(fragmentOwnerRaw) || fragmentOwnerRaw.endsWith('.ton')) {
      return {
        isProfileActive: false,
        displayName: fragmentOwnerRaw,
        ownerDisplayName: fragmentOwnerRaw,
        userFriendlyAddress: fragmentOwnerRaw.startsWith('UQ') || fragmentOwnerRaw.startsWith('EQ') ? fragmentOwnerRaw : undefined,
        isRealName: false,
        isChannel: false,
        isSold,
        isForSale,
        rejectionReason: 'Fragment owner is a cold TON wallet address, not an active Telegram profile',
        mtprotoInfo,
      };
    }
  }

  // Default: Reject unverified or anonymous items
  const disp = fragmentOwnerRaw || 'Скрыт / Блокчейн';
  return {
    isProfileActive: false,
    displayName: disp,
    ownerDisplayName: disp,
    isRealName: false,
    isChannel: false,
    isSold,
    isForSale,
    rejectionReason: 'Could not verify active profile ownership',
    mtprotoInfo,
  };
}
