import { isTrustedYouTubeThumbnail, YOUTUBE_VIDEO_ID_PATTERN, type YouTubeVideo } from "./sync";

const API_ROOT = "https://www.googleapis.com/youtube/v3";
const CACHE_PREFIX = "yt-jam:youtube:v3:";
const CACHE_TTL_MS = 15 * 60 * 1000;

export const youtubeApiKey = (import.meta.env.VITE_YOUTUBE_API_KEY ?? "").trim();

type Fetcher = typeof fetch;
export type YouTubePage = { videos: YouTubeVideo[]; nextPageToken: string | null };
type CacheEntry = { savedAt: number; page: YouTubePage };

export type YouTubeRequest = {
  apiKey: string;
  query?: string;
  regionCode?: string;
  signal?: AbortSignal;
  pageToken?: string;
  fetcher?: Fetcher;
  storage?: Storage | null;
  now?: number;
};

export function parseIsoDuration(value: string): number {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value);
  if (!match) return 0;
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

export function browserRegion(
  language = navigator.language,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
  const timeZoneRegion: Record<string, string> = {
    "Asia/Calcutta": "IN",
    "Asia/Kolkata": "IN",
  };
  if (timeZoneRegion[timeZone]) return timeZoneRegion[timeZone];
  const region = language.split("-")[1]?.toUpperCase();
  return region && /^[A-Z]{2}$/.test(region) ? region : "US";
}

function cacheKey(query: string | undefined, regionCode: string, pageToken?: string): string {
  return `${CACHE_PREFIX}${regionCode}:${query?.trim().toLowerCase() || "popular"}:${pageToken || "first"}`;
}

export function readVideoCache(
  storage: Storage | null,
  key: string,
  now = Date.now(),
): YouTubePage | null {
  if (!storage) return null;
  try {
    const parsed = JSON.parse(storage.getItem(key) ?? "null") as CacheEntry | null;
    if (!parsed || now - parsed.savedAt > CACHE_TTL_MS || !Array.isArray(parsed.page?.videos)) return null;
    return parsed.page;
  } catch {
    return null;
  }
}

export function writeVideoCache(
  storage: Storage | null,
  key: string,
  page: YouTubePage,
  now = Date.now(),
): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify({ savedAt: now, page } satisfies CacheEntry));
  } catch {
    // Discovery still works when storage is unavailable or full.
  }
}

function cleanText(value: unknown, fallback: string, maxLength: number): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maxLength) : fallback;
}

export function parseVideoItems(
  items: unknown,
  durations: ReadonlyMap<string, number> = new Map(),
): YouTubeVideo[] {
  if (!Array.isArray(items)) return [];

  return items.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    const idValue = typeof item.id === "string"
      ? item.id
      : item.id && typeof item.id === "object"
        ? (item.id as Record<string, unknown>).videoId
        : null;
    if (typeof idValue !== "string" || !YOUTUBE_VIDEO_ID_PATTERN.test(idValue)) return [];

    const snippet = item.snippet && typeof item.snippet === "object"
      ? item.snippet as Record<string, unknown>
      : {};
    const thumbnails = snippet.thumbnails && typeof snippet.thumbnails === "object"
      ? snippet.thumbnails as Record<string, unknown>
      : {};
    const preferred = ["high", "medium", "default"]
      .map((key) => thumbnails[key])
      .find((thumbnail) => thumbnail && typeof thumbnail === "object") as Record<string, unknown> | undefined;
    const candidateThumbnail = typeof preferred?.url === "string" ? preferred.url : "";
    const contentDetails = item.contentDetails && typeof item.contentDetails === "object"
      ? item.contentDetails as Record<string, unknown>
      : {};
    const status = item.status && typeof item.status === "object"
      ? item.status as Record<string, unknown>
      : {};
    if (status.embeddable === false || status.privacyStatus === "private") return [];

    return [{
      videoId: idValue,
      title: cleanText(snippet.title, "YouTube video", 200),
      channelTitle: cleanText(snippet.channelTitle, "YouTube", 120),
      thumbnailUrl: isTrustedYouTubeThumbnail(candidateThumbnail)
        ? candidateThumbnail
        : `https://i.ytimg.com/vi/${idValue}/hqdefault.jpg`,
      durationSeconds: durations.get(idValue) ?? (
        typeof contentDetails.duration === "string" ? parseIsoDuration(contentDetails.duration) : 0
      ),
    }];
  });
}

export function filterVideoItemsForRegion(items: unknown, regionCode: string): unknown[] {
  if (!Array.isArray(items)) return [];
  const region = regionCode.toUpperCase();
  return items.filter((raw) => {
    if (!raw || typeof raw !== "object") return false;
    const item = raw as Record<string, unknown>;
    const details = item.contentDetails && typeof item.contentDetails === "object"
      ? item.contentDetails as Record<string, unknown>
      : {};
    const restriction = details.regionRestriction && typeof details.regionRestriction === "object"
      ? details.regionRestriction as Record<string, unknown>
      : null;
    if (!restriction) return true;
    const allowed = Array.isArray(restriction.allowed) ? restriction.allowed.map(String) : null;
    const blocked = Array.isArray(restriction.blocked) ? restriction.blocked.map(String) : [];
    return allowed ? allowed.includes(region) : !blocked.includes(region);
  });
}

export function pickNextUnplayedVideo(
  videos: YouTubeVideo[],
  playedVideoIds: ReadonlySet<string>,
): YouTubeVideo | null {
  return videos.find((video) => !playedVideoIds.has(video.videoId)) ?? null;
}

async function requestJson(url: URL, fetcher: Fetcher, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetcher(url, { signal });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (response.ok) return body;

  const error = body.error && typeof body.error === "object" ? body.error as Record<string, unknown> : {};
  const errors = Array.isArray(error.errors) ? error.errors : [];
  const reason = errors[0] && typeof errors[0] === "object"
    ? String((errors[0] as Record<string, unknown>).reason ?? "")
    : "";
  if (response.status === 403 && /quota/i.test(reason)) {
    throw new Error("YouTube search quota is exhausted for today.");
  }
  if (response.status === 400 || response.status === 403) {
    throw new Error("YouTube API key is invalid or not allowed for this site.");
  }
  throw new Error(`YouTube discovery failed (${response.status}).`);
}

export async function fetchYouTubeVideoPage({
  apiKey,
  query,
  regionCode = browserRegion(),
  signal,
  pageToken,
  fetcher = fetch,
  storage = typeof sessionStorage === "undefined" ? null : sessionStorage,
  now = Date.now(),
}: YouTubeRequest): Promise<YouTubePage> {
  if (!apiKey.trim()) throw new Error("Add VITE_YOUTUBE_API_KEY to .env.local to enable Surf.");
  const normalizedQuery = query?.trim() || undefined;
  const key = cacheKey(normalizedQuery, regionCode, pageToken);
  const cached = readVideoCache(storage, key, now);
  if (cached) return cached;

  let videos: YouTubeVideo[];
  {
    const searchUrl = new URL(`${API_ROOT}/search`);
    searchUrl.search = new URLSearchParams({
      part: "snippet",
      type: "video",
      videoEmbeddable: "true",
      videoSyndicated: "true",
      safeSearch: "moderate",
      maxResults: "12",
      regionCode,
      ...(normalizedQuery ? { q: normalizedQuery } : { q: "music", order: "viewCount", videoCategoryId: "10" }),
      key: apiKey,
      ...(pageToken ? { pageToken } : {}),
    }).toString();
    const searchBody = await requestJson(searchUrl, fetcher, signal);
    const preliminary = parseVideoItems(searchBody.items);
    if (preliminary.length === 0) return {
      videos: [],
      nextPageToken: typeof searchBody.nextPageToken === "string" ? searchBody.nextPageToken : null,
    };

    const detailsUrl = new URL(`${API_ROOT}/videos`);
    detailsUrl.search = new URLSearchParams({
      part: "contentDetails,status",
      id: preliminary.map((video) => video.videoId).join(","),
      key: apiKey,
    }).toString();
    const detailsBody = await requestJson(detailsUrl, fetcher, signal);
    const playableDetails = parseVideoItems(filterVideoItemsForRegion(detailsBody.items, regionCode));
    const durationMap = new Map(playableDetails.map((video) => [video.videoId, video.durationSeconds]));
    const playableIds = new Set(playableDetails.map((video) => video.videoId));
    videos = preliminary.filter((video) => playableIds.has(video.videoId)).map((video) => ({
      ...video,
      durationSeconds: durationMap.get(video.videoId) ?? 0,
    }));
    const page = {
      videos,
      nextPageToken: typeof searchBody.nextPageToken === "string" ? searchBody.nextPageToken : null,
    };
    writeVideoCache(storage, key, page, now);
    return page;
  }
}

export async function fetchYouTubeVideos(request: YouTubeRequest): Promise<YouTubeVideo[]> {
  return (await fetchYouTubeVideoPage(request)).videos;
}
