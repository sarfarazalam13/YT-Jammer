import { extractYouTubeVideoId, isTrustedYouTubeThumbnail, YOUTUBE_VIDEO_ID_PATTERN, type YouTubeVideo } from "./sync";

const API_ROOT = "https://www.googleapis.com/youtube/v3";
const CACHE_PREFIX = "yt-jam:youtube:v4:";
const CACHE_INDEX_KEY = `${CACHE_PREFIX}index`;
const BUDGET_KEY = "yt-jam:youtube:search-budget:v1";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_LIMIT = 100;
const SEARCH_DAILY_LIMIT = 15;
const MAX_BACKOFF_MS = 30 * 60 * 1000;
const PLAYLIST_LIMIT = 50;

export const youtubeApiKey = (import.meta.env.VITE_YOUTUBE_API_KEY ?? "").trim();

type Fetcher = typeof fetch;
export type YouTubePage = { videos: YouTubeVideo[]; nextPageToken: string | null; cached?: boolean; skippedCount?: number };
export type PlaylistPreview = { playlistId: string; highlightedVideoId: string | null; highlightedIndex: number | null; videos: YouTubeVideo[]; skippedCount: number };
export type YouTubeInput =
  | { kind: "popular" }
  | { kind: "search"; query: string }
  | { kind: "video"; videoId: string }
  | { kind: "playlist"; playlistId: string }
  | { kind: "video-playlist"; videoId: string; playlistId: string; index: number | null };
type CacheEntry<T> = { savedAt: number; accessedAt: number; value: T };
type BudgetRecord = { day: string; count: number; cooldownUntil: number; backoffMs: number; quotaUntil: number };

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

export class YouTubeDiscoveryError extends Error {
  constructor(message: string, public readonly status: number, public readonly reason: string, public readonly retryAt: number | null, public readonly scope: "search" | "all") {
    super(message);
    this.name = "YouTubeDiscoveryError";
  }
}

const inFlight = new Map<string, Promise<YouTubePage>>();

export function parseIsoDuration(value: string): number {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value);
  if (!match) return 0;
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

export function browserRegion(language = navigator.language, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  const timeZoneRegion: Record<string, string> = { "Asia/Calcutta": "IN", "Asia/Kolkata": "IN" };
  if (timeZoneRegion[timeZone]) return timeZoneRegion[timeZone];
  const region = language.split("-")[1]?.toUpperCase();
  return region && /^[A-Z]{2}$/.test(region) ? region : "US";
}

function pacificDay(now: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
}

export function nextPacificMidnight(now = Date.now()): number {
  const current = pacificDay(now);
  let low = now;
  let high = now + 27 * 60 * 60 * 1000;
  while (high - low > 1_000) {
    const middle = Math.floor((low + high) / 2);
    if (pacificDay(middle) === current) low = middle;
    else high = middle;
  }
  return high;
}

function defaultBudget(now: number): BudgetRecord {
  return { day: pacificDay(now), count: 0, cooldownUntil: 0, backoffMs: 0, quotaUntil: 0 };
}

function readBudget(storage: Storage | null, now: number): BudgetRecord {
  if (!storage) return defaultBudget(now);
  try {
    const parsed = JSON.parse(storage.getItem(BUDGET_KEY) ?? "null") as Partial<BudgetRecord> | null;
    if (!parsed || parsed.day !== pacificDay(now)) return defaultBudget(now);
    return { day: parsed.day, count: Number.isInteger(parsed.count) ? Math.max(0, Number(parsed.count)) : 0, cooldownUntil: Number(parsed.cooldownUntil) || 0, backoffMs: Number(parsed.backoffMs) || 0, quotaUntil: Number(parsed.quotaUntil) || 0 };
  } catch { return defaultBudget(now); }
}

function writeBudget(storage: Storage | null, value: BudgetRecord): void {
  try { storage?.setItem(BUDGET_KEY, JSON.stringify(value)); } catch { /* Optional persistence. */ }
}

export function getSearchBudgetState(storage: Storage | null = typeof localStorage === "undefined" ? null : localStorage, now = Date.now()) {
  const budget = readBudget(storage, now);
  return { remaining: Math.max(0, SEARCH_DAILY_LIMIT - budget.count), limit: SEARCH_DAILY_LIMIT, retryAt: Math.max(budget.cooldownUntil, budget.quotaUntil) || null, available: budget.count < SEARCH_DAILY_LIMIT && budget.cooldownUntil <= now && budget.quotaUntil <= now };
}

function ensureApiAvailable(storage: Storage | null, now: number): void {
  const budget = readBudget(storage, now);
  if (budget.cooldownUntil <= now) return;
  throw new YouTubeDiscoveryError(`YouTube discovery is cooling down until ${new Date(budget.cooldownUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`, 429, "rateLimitExceeded", budget.cooldownUntil, "all");
}

function cacheKey(kind: string, value: string, regionCode: string, pageToken?: string): string {
  return `${CACHE_PREFIX}${kind}:${regionCode}:${value.trim().toLowerCase()}:${pageToken || "first"}`;
}

export function readVideoCache(storage: Storage | null, key: string, now = Date.now()): YouTubePage | null {
  if (!storage) return null;
  try {
    const parsed = JSON.parse(storage.getItem(key) ?? "null") as CacheEntry<YouTubePage> | null;
    if (!parsed || now - parsed.savedAt > CACHE_TTL_MS || !Array.isArray(parsed.value?.videos)) return null;
    parsed.accessedAt = now;
    storage.setItem(key, JSON.stringify(parsed));
    return { ...parsed.value, cached: true };
  } catch { return null; }
}

export function writeVideoCache(storage: Storage | null, key: string, page: YouTubePage, now = Date.now()): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify({ savedAt: now, accessedAt: now, value: { videos: page.videos, nextPageToken: page.nextPageToken, skippedCount: page.skippedCount } } satisfies CacheEntry<YouTubePage>));
    const index = JSON.parse(storage.getItem(CACHE_INDEX_KEY) ?? "[]") as Array<{ key: string; accessedAt: number }>;
    const next = [{ key, accessedAt: now }, ...index.filter((entry) => entry.key !== key)].sort((a, b) => b.accessedAt - a.accessedAt);
    next.slice(CACHE_LIMIT).forEach((entry) => storage.removeItem(entry.key));
    storage.setItem(CACHE_INDEX_KEY, JSON.stringify(next.slice(0, CACHE_LIMIT)));
  } catch { /* Discovery still works when storage is unavailable or full. */ }
}

function cleanText(value: unknown, fallback: string, maxLength: number): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maxLength) : fallback;
}

export function parseVideoItems(items: unknown, durations: ReadonlyMap<string, number> = new Map()): YouTubeVideo[] {
  if (!Array.isArray(items)) return [];
  return items.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    const idValue = typeof item.id === "string" ? item.id : item.id && typeof item.id === "object" ? (item.id as Record<string, unknown>).videoId : null;
    if (typeof idValue !== "string" || !YOUTUBE_VIDEO_ID_PATTERN.test(idValue)) return [];
    const snippet = item.snippet && typeof item.snippet === "object" ? item.snippet as Record<string, unknown> : {};
    const thumbnails = snippet.thumbnails && typeof snippet.thumbnails === "object" ? snippet.thumbnails as Record<string, unknown> : {};
    const preferred = ["high", "medium", "default"].map((key) => thumbnails[key]).find((thumbnail) => thumbnail && typeof thumbnail === "object") as Record<string, unknown> | undefined;
    const candidateThumbnail = typeof preferred?.url === "string" ? preferred.url : "";
    const details = item.contentDetails && typeof item.contentDetails === "object" ? item.contentDetails as Record<string, unknown> : {};
    const status = item.status && typeof item.status === "object" ? item.status as Record<string, unknown> : {};
    if (status.embeddable === false || status.privacyStatus === "private") return [];
    return [{ videoId: idValue, title: cleanText(snippet.title, "YouTube video", 200), channelTitle: cleanText(snippet.channelTitle, "YouTube", 120), thumbnailUrl: isTrustedYouTubeThumbnail(candidateThumbnail) ? candidateThumbnail : `https://i.ytimg.com/vi/${idValue}/hqdefault.jpg`, durationSeconds: durations.get(idValue) ?? (typeof details.duration === "string" ? parseIsoDuration(details.duration) : 0) }];
  });
}

export function filterVideoItemsForRegion(items: unknown, regionCode: string): unknown[] {
  if (!Array.isArray(items)) return [];
  const region = regionCode.toUpperCase();
  return items.filter((raw) => {
    if (!raw || typeof raw !== "object") return false;
    const item = raw as Record<string, unknown>;
    const details = item.contentDetails && typeof item.contentDetails === "object" ? item.contentDetails as Record<string, unknown> : {};
    const restriction = details.regionRestriction && typeof details.regionRestriction === "object" ? details.regionRestriction as Record<string, unknown> : null;
    if (!restriction) return true;
    const allowed = Array.isArray(restriction.allowed) ? restriction.allowed.map(String) : null;
    const blocked = Array.isArray(restriction.blocked) ? restriction.blocked.map(String) : [];
    return allowed ? allowed.includes(region) : !blocked.includes(region);
  });
}

export function normalizeYouTubeInput(value: string): string {
  let candidate = value.trim();
  const markdownLink = /^\[[\s\S]*?\]\((https?:\/\/[^)]+)\)$/.exec(candidate);
  if (markdownLink?.[1]) candidate = markdownLink[1];
  if (candidate.startsWith("<") && candidate.endsWith(">")) candidate = candidate.slice(1, -1);
  return candidate.replace(/\\([&?=#])/g, "$1").trim();
}

export function parseYouTubeInput(value: string): YouTubeInput {
  const candidate = normalizeYouTubeInput(value);
  if (!candidate) return { kind: "popular" };
  const rawVideoId = extractYouTubeVideoId(candidate);
  if (rawVideoId && !candidate.includes("list=")) return { kind: "video", videoId: rawVideoId };
  try {
    const url = new URL(candidate);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    if (["youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"].includes(hostname)) {
      const playlistId = url.searchParams.get("list");
      if (playlistId && /^[A-Za-z0-9_-]{10,100}$/.test(playlistId)) {
        if (rawVideoId) {
          const rawIndex = Number(url.searchParams.get("index"));
          return { kind: "video-playlist", videoId: rawVideoId, playlistId, index: Number.isInteger(rawIndex) && rawIndex > 0 ? rawIndex : null };
        }
        return { kind: "playlist", playlistId };
      }
      if (rawVideoId) return { kind: "video", videoId: rawVideoId };
    }
  } catch { /* Treat non-URLs as search text. */ }
  return { kind: "search", query: candidate };
}

export function playlistVideosFromLinked(videos: YouTubeVideo[], videoId: string | null, index: number | null): YouTubeVideo[] {
  const seen = new Set<string>();
  const unique = videos.filter((video) => {
    if (seen.has(video.videoId)) return false;
    seen.add(video.videoId);
    return true;
  });
  const videoIndex = videoId ? unique.findIndex((video) => video.videoId === videoId) : -1;
  const fallbackIndex = index !== null && index > 0 && index <= unique.length ? index - 1 : 0;
  return unique.slice(videoIndex >= 0 ? videoIndex : fallbackIndex, PLAYLIST_LIMIT);
}

export function pickNextUnplayedVideo(videos: YouTubeVideo[], playedVideoIds: ReadonlySet<string>): YouTubeVideo | null {
  return videos.find((video) => !playedVideoIds.has(video.videoId)) ?? null;
}

function retryAfterMs(response: Response, now: number): number | null {
  const value = response.headers?.get?.("Retry-After");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return now + Math.max(0, seconds) * 1000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

async function requestJson(url: URL, fetcher: Fetcher, signal: AbortSignal | undefined, storage: Storage | null, now: number, scope: "search" | "all"): Promise<Record<string, unknown>> {
  const response = await fetcher(url, { signal });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (response.ok) {
    const budget = readBudget(storage, now);
    if (budget.backoffMs || budget.cooldownUntil) writeBudget(storage, { ...budget, backoffMs: 0, cooldownUntil: 0 });
    return body;
  }
  const error = body.error && typeof body.error === "object" ? body.error as Record<string, unknown> : {};
  const errors = Array.isArray(error.errors) ? error.errors : [];
  const reason = errors[0] && typeof errors[0] === "object" ? String((errors[0] as Record<string, unknown>).reason ?? "") : "";
  const budget = readBudget(storage, now);
  if (response.status === 429) {
    const nextBackoff = Math.min(MAX_BACKOFF_MS, Math.max(60_000, budget.backoffMs ? budget.backoffMs * 2 : 60_000));
    const retryAt = retryAfterMs(response as Response, now) ?? now + nextBackoff;
    writeBudget(storage, { ...budget, cooldownUntil: retryAt, backoffMs: nextBackoff });
    throw new YouTubeDiscoveryError(`YouTube is rate-limiting discovery. Try again after ${new Date(retryAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`, 429, reason, retryAt, "all");
  }
  if (response.status === 403 && /quota/i.test(reason)) {
    const retryAt = nextPacificMidnight(now);
    writeBudget(storage, scope === "search" ? { ...budget, quotaUntil: retryAt } : { ...budget, cooldownUntil: retryAt });
    throw new YouTubeDiscoveryError(scope === "search" ? "YouTube search quota is exhausted until the next Pacific midnight." : "YouTube API quota is exhausted until the next Pacific midnight.", 403, reason, retryAt, scope);
  }
  if (response.status === 400 || response.status === 403) throw new YouTubeDiscoveryError("YouTube API key is invalid or not allowed for this site.", response.status, reason, null, scope);
  throw new YouTubeDiscoveryError(`YouTube discovery failed (${response.status}).`, response.status, reason, null, scope);
}

function requireApiKey(apiKey: string): void {
  if (!apiKey.trim()) throw new Error("Add VITE_YOUTUBE_API_KEY to .env.local to enable Surf.");
}

async function fetchVideoDetails(ids: string[], request: YouTubeRequest): Promise<YouTubeVideo[]> {
  const uniqueIds = [...new Set(ids.filter((id) => YOUTUBE_VIDEO_ID_PATTERN.test(id)))].slice(0, 50);
  if (!uniqueIds.length) return [];
  const { apiKey, fetcher = fetch, signal, storage = typeof localStorage === "undefined" ? null : localStorage, now = Date.now(), regionCode = browserRegion() } = request;
  requireApiKey(apiKey);
  const key = cacheKey("ids", [...uniqueIds].sort().join(","), regionCode);
  const cached = readVideoCache(storage, key, now);
  if (cached) return cached.videos;
  ensureApiAvailable(storage, now);
  const url = new URL(`${API_ROOT}/videos`);
  url.search = new URLSearchParams({ part: "snippet,contentDetails,status", id: uniqueIds.join(","), key: apiKey }).toString();
  const body = await requestJson(url, fetcher, signal, storage, now, "all");
  const videos = parseVideoItems(filterVideoItemsForRegion(body.items, regionCode));
  writeVideoCache(storage, key, { videos, nextPageToken: null }, now);
  return videos;
}

export async function fetchVideosByIds(ids: string[], request: Omit<YouTubeRequest, "query" | "pageToken">): Promise<YouTubeVideo[]> {
  return fetchVideoDetails(ids, request);
}

export async function fetchYouTubePlaylist(input: Extract<YouTubeInput, { kind: "playlist" | "video-playlist" }>, request: Omit<YouTubeRequest, "query" | "pageToken">): Promise<PlaylistPreview> {
  const { apiKey, fetcher = fetch, signal, storage = typeof localStorage === "undefined" ? null : localStorage, now = Date.now(), regionCode = browserRegion() } = request;
  requireApiKey(apiKey);
  if (input.playlistId.startsWith("RD")) throw new Error("YouTube generated Mix playlists cannot be imported. Use a public playlist link instead.");
  const key = cacheKey("playlist", input.playlistId, regionCode);
  const cached = readVideoCache(storage, key, now);
  const highlightedVideoId = input.kind === "video-playlist" ? input.videoId : null;
  const highlightedIndex = input.kind === "video-playlist" ? input.index : null;
  if (cached) return { playlistId: input.playlistId, highlightedVideoId, highlightedIndex, videos: cached.videos, skippedCount: cached.skippedCount ?? 0 };
  ensureApiAvailable(storage, now);
  const url = new URL(`${API_ROOT}/playlistItems`);
  url.search = new URLSearchParams({ part: "contentDetails", playlistId: input.playlistId, maxResults: String(PLAYLIST_LIMIT), key: apiKey }).toString();
  const body = await requestJson(url, fetcher, signal, storage, now, "all");
  const items = Array.isArray(body.items) ? body.items : [];
  const ids = items.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const details = (raw as Record<string, unknown>).contentDetails;
    const id = details && typeof details === "object" ? (details as Record<string, unknown>).videoId : null;
    return typeof id === "string" && YOUTUBE_VIDEO_ID_PATTERN.test(id) ? [id] : [];
  });
  if (!ids.length) throw new Error("This playlist is private, empty, or unavailable.");
  const videos = await fetchVideoDetails(ids, request);
  const skippedCount = Math.max(0, ids.length - videos.length);
  writeVideoCache(storage, key, { videos, nextPageToken: null, skippedCount }, now);
  return { playlistId: input.playlistId, highlightedVideoId, highlightedIndex, videos, skippedCount };
}

export async function fetchPopularVideoPage(request: Omit<YouTubeRequest, "query">): Promise<YouTubePage> {
  const { apiKey, fetcher = fetch, signal, pageToken, storage = typeof localStorage === "undefined" ? null : localStorage, now = Date.now(), regionCode = browserRegion() } = request;
  requireApiKey(apiKey);
  const key = cacheKey("popular", "music", regionCode, pageToken);
  const cached = readVideoCache(storage, key, now);
  if (cached) return cached;
  ensureApiAvailable(storage, now);
  const url = new URL(`${API_ROOT}/videos`);
  url.search = new URLSearchParams({ part: "snippet,contentDetails,status", chart: "mostPopular", videoCategoryId: "10", maxResults: "25", regionCode, key: apiKey, ...(pageToken ? { pageToken } : {}) }).toString();
  const body = await requestJson(url, fetcher, signal, storage, now, "all");
  const page = { videos: parseVideoItems(filterVideoItemsForRegion(body.items, regionCode)), nextPageToken: typeof body.nextPageToken === "string" ? body.nextPageToken : null };
  writeVideoCache(storage, key, page, now);
  return page;
}

export async function fetchYouTubeVideoPage(request: YouTubeRequest): Promise<YouTubePage> {
  const { apiKey, query, regionCode = browserRegion(), signal, pageToken, fetcher = fetch, storage = typeof localStorage === "undefined" ? null : localStorage, now = Date.now() } = request;
  requireApiKey(apiKey);
  const normalizedQuery = query?.trim();
  if (!normalizedQuery) return fetchPopularVideoPage({ ...request, regionCode });
  const key = cacheKey("search", normalizedQuery, regionCode, pageToken);
  const cached = readVideoCache(storage, key, now);
  if (cached) return cached;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const budget = readBudget(storage, now);
  const retryAt = Math.max(budget.cooldownUntil, budget.quotaUntil);
  if (retryAt > now) throw new YouTubeDiscoveryError(`YouTube search is cooling down until ${new Date(retryAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`, retryAt === budget.quotaUntil ? 403 : 429, retryAt === budget.quotaUntil ? "quotaExceeded" : "rateLimitExceeded", retryAt, "search");
  if (budget.count >= SEARCH_DAILY_LIMIT) throw new YouTubeDiscoveryError("This device has used its 15 YouTube searches for today. Popular, links, playlists, and cached results still work.", 429, "clientDailyLimit", nextPacificMidnight(now), "search");
  writeBudget(storage, { ...budget, count: budget.count + 1 });
  const promise = (async () => {
    const searchUrl = new URL(`${API_ROOT}/search`);
    searchUrl.search = new URLSearchParams({ part: "snippet", type: "video", videoEmbeddable: "true", videoSyndicated: "true", safeSearch: "moderate", maxResults: "12", regionCode, q: normalizedQuery, key: apiKey, ...(pageToken ? { pageToken } : {}) }).toString();
    const searchBody = await requestJson(searchUrl, fetcher, signal, storage, now, "search");
    const preliminary = parseVideoItems(searchBody.items);
    const videos = preliminary.length ? await fetchVideoDetails(preliminary.map((video) => video.videoId), request) : [];
    const byId = new Map(videos.map((video) => [video.videoId, video]));
    const ordered = preliminary.flatMap((video) => byId.get(video.videoId) ? [byId.get(video.videoId)!] : []);
    const page = { videos: ordered, nextPageToken: typeof searchBody.nextPageToken === "string" ? searchBody.nextPageToken : null };
    writeVideoCache(storage, key, page, now);
    return page;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

export async function fetchYouTubeVideos(request: YouTubeRequest): Promise<YouTubeVideo[]> {
  return (await fetchYouTubeVideoPage(request)).videos;
}
