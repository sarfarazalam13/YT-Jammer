import { describe, expect, it, vi } from "vitest";
import {
  browserRegion,
  filterVideoItemsForRegion,
  fetchPopularVideoPage,
  fetchYouTubePlaylist,
  fetchYouTubeVideos,
  fetchYouTubeVideoPage,
  getSearchBudgetState,
  normalizeYouTubeInput,
  parseYouTubeInput,
  parseIsoDuration,
  parseVideoItems,
  pickNextUnplayedVideo,
  playlistVideosFromLinked,
  readVideoCache,
  writeVideoCache,
} from "./youtube";

describe("YouTube discovery helpers", () => {
  function memoryStorage(): Storage {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => { values.delete(key); },
    } as unknown as Storage;
  }

  it("parses ISO video durations", () => {
    expect(parseIsoDuration("PT4M13S")).toBe(253);
    expect(parseIsoDuration("PT1H2M3S")).toBe(3723);
    expect(parseIsoDuration("invalid")).toBe(0);
  });

  it("uses the device timezone when it gives a more accurate playback region", () => {
    expect(browserRegion("en-US", "Asia/Calcutta")).toBe("IN");
    expect(browserRegion("fr-FR", "Europe/Paris")).toBe("FR");
  });

  it("filters videos blocked in or not allowed for the playback region", () => {
    const items = [
      { id: "dQw4w9WgXcQ", contentDetails: { regionRestriction: { blocked: ["IN"] } } },
      { id: "M7lc1UVf-VE", contentDetails: { regionRestriction: { allowed: ["US"] } } },
      { id: "jNQXAC9IVRw", contentDetails: {} },
    ];
    expect(filterVideoItemsForRegion(items, "IN")).toEqual([items[2]]);
  });

  it("parses safe video metadata and rejects malformed ids", () => {
    expect(parseVideoItems([
      {
        id: "dQw4w9WgXcQ",
        snippet: {
          title: "A title",
          channelTitle: "A channel",
          thumbnails: { high: { url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" } },
        },
        contentDetails: { duration: "PT3M10S" },
      },
      { id: "bad" },
    ])).toEqual([{
      videoId: "dQw4w9WgXcQ",
      title: "A title",
      channelTitle: "A channel",
      thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
      durationSeconds: 190,
    }]);
  });

  it("reads fresh cache entries and ignores expired entries", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    } as unknown as Storage;
    const videos = parseVideoItems([{ id: "dQw4w9WgXcQ", snippet: {} }]);
    const page = { videos, nextPageToken: "next" };
    writeVideoCache(storage, "cache", page, 1_000);
    expect(readVideoCache(storage, "cache", 2_000)).toMatchObject(page);
    expect(readVideoCache(storage, "cache", 1_000 + 25 * 60 * 60 * 1000)).toBeNull();
  });

  it("fails cleanly when the API key is missing", async () => {
    await expect(fetchYouTubeVideos({ apiKey: "", storage: null })).rejects.toThrow(
      "VITE_YOUTUBE_API_KEY",
    );
  });

  it("maps quota errors to an actionable message", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: { errors: [{ reason: "quotaExceeded" }] } }),
    });
    await expect(fetchYouTubeVideos({ apiKey: "key", fetcher, storage: null })).rejects.toThrow(
      "quota is exhausted",
    );
  });

  it("returns and forwards YouTube pagination tokens", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ nextPageToken: "page-2", items: [] }),
    });
    const page = await fetchYouTubeVideoPage({ apiKey: "key", query: "music", pageToken: "page-1", fetcher, storage: null });
    expect(page.nextPageToken).toBe("page-2");
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("pageToken=page-1");
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("videoSyndicated=true");
  });

  it("recognizes video and playlist links before treating input as search", () => {
    expect(parseYouTubeInput("https://youtu.be/dQw4w9WgXcQ")).toEqual({ kind: "video", videoId: "dQw4w9WgXcQ" });
    expect(parseYouTubeInput("https://www.youtube.com/playlist?list=PL1234567890")).toEqual({ kind: "playlist", playlistId: "PL1234567890" });
    expect(parseYouTubeInput("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1234567890&index=3")).toEqual({ kind: "video-playlist", videoId: "dQw4w9WgXcQ", playlistId: "PL1234567890", index: 3 });
    expect(parseYouTubeInput("lofi beats")).toEqual({ kind: "search", query: "lofi beats" });
  });

  it("normalizes copied mixed links with markdown, escaped separators, and Unicode whitespace", () => {
    const url = "https://www.youtube.com/watch?v=K9R7KcaettM&list=PL5DigwkkJqqR439Nr1LJxaSuU1liDW7pJ&index=1";
    expect(normalizeYouTubeInput(`[song](${url.replaceAll("&", "\\&")})\u00a0`)).toBe(url);
    expect(parseYouTubeInput(`${url}\u00a0`)).toEqual({
      kind: "video-playlist",
      videoId: "K9R7KcaettM",
      playlistId: "PL5DigwkkJqqR439Nr1LJxaSuU1liDW7pJ",
      index: 1,
    });
    expect(parseYouTubeInput("https://music.youtube.com/watch?v=K9R7KcaettM\\&list=PL5DigwkkJqqR439Nr1LJxaSuU1liDW7pJ\\&index=4")).toMatchObject({ kind: "video-playlist", index: 4 });
  });

  it("uses videos.list for Popular without spending a search request", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [] }) });
    const page = await fetchPopularVideoPage({ apiKey: "key", fetcher, storage: null });
    expect(page.videos).toEqual([]);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("chart=mostPopular");
    expect(String(fetcher.mock.calls[0]?.[0])).not.toContain("%2Fsearch");
  });

  it("rejects generated Mix playlists without making a request", async () => {
    const fetcher = vi.fn();
    await expect(fetchYouTubePlaylist(
      { kind: "playlist", playlistId: "RD1234567890" },
      { apiKey: "key", fetcher, storage: null },
    )).rejects.toThrow("generated Mix");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("loads a public playlist and filters it through batched video details", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [
        { contentDetails: { videoId: "dQw4w9WgXcQ" } },
        { contentDetails: { videoId: "M7lc1UVf-VE" } },
      ] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [
        { id: "dQw4w9WgXcQ", snippet: { title: "Playable" }, contentDetails: { duration: "PT3M" }, status: { embeddable: true } },
        { id: "M7lc1UVf-VE", snippet: { title: "Blocked" }, status: { embeddable: false } },
      ] }) });
    const preview = await fetchYouTubePlaylist(
      { kind: "video-playlist", playlistId: "PL1234567890", videoId: "dQw4w9WgXcQ", index: 1 },
      { apiKey: "key", fetcher, storage: null },
    );
    expect(preview.videos.map((video) => video.videoId)).toEqual(["dQw4w9WgXcQ"]);
    expect(preview.skippedCount).toBe(1);
    expect(preview.highlightedIndex).toBe(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("playlistItems");
    expect(String(fetcher.mock.calls[1]?.[0])).toContain("dQw4w9WgXcQ%2CM7lc1UVf-VE");
  });

  it("queues a mixed playlist from the linked song and removes duplicates", () => {
    const videos = parseVideoItems([
      { id: "jNQXAC9IVRw", snippet: { title: "First" } },
      { id: "dQw4w9WgXcQ", snippet: { title: "Linked" } },
      { id: "M7lc1UVf-VE", snippet: { title: "Next" } },
      { id: "dQw4w9WgXcQ", snippet: { title: "Duplicate" } },
    ]);
    expect(playlistVideosFromLinked(videos, "dQw4w9WgXcQ", 1).map((video) => video.videoId)).toEqual(["dQw4w9WgXcQ", "M7lc1UVf-VE"]);
    expect(playlistVideosFromLinked(videos, "missing-id", 2).map((video) => video.videoId)).toEqual(["dQw4w9WgXcQ", "M7lc1UVf-VE"]);
  });

  it("tracks the local uncached-search budget", () => {
    expect(getSearchBudgetState(null, Date.UTC(2026, 9, 13)).remaining).toBe(15);
  });

  it("honors Retry-After and persists a 429 cooldown", async () => {
    const storage = memoryStorage();
    const now = Date.UTC(2026, 9, 13, 12);
    const fetcher = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: { get: (name: string) => name === "Retry-After" ? "120" : null },
      json: async () => ({ error: { errors: [{ reason: "rateLimitExceeded" }] } }),
    });
    await expect(fetchYouTubeVideoPage({ apiKey: "key", query: "rate limited", fetcher, storage, now })).rejects.toThrow("rate-limiting");
    const budget = getSearchBudgetState(storage, now);
    expect(budget.available).toBe(false);
    expect(budget.retryAt).toBe(now + 120_000);
  });

  it("stops after fifteen uncached searches per Pacific day", async () => {
    const storage = memoryStorage();
    const now = Date.UTC(2026, 9, 13, 12);
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [] }) });
    for (let index = 0; index < 15; index += 1) {
      await fetchYouTubeVideoPage({ apiKey: "key", query: `unique search ${index}`, fetcher, storage, now });
    }
    expect(getSearchBudgetState(storage, now).remaining).toBe(0);
    await expect(fetchYouTubeVideoPage({ apiKey: "key", query: "one too many", fetcher, storage, now })).rejects.toThrow("15 YouTube searches");
  });

  it("selects the first unplayed video for the autoplay mix", () => {
    const videos = parseVideoItems([
      { id: "dQw4w9WgXcQ", snippet: {} },
      { id: "ox8lEnsxDag", snippet: {} },
    ]);
    expect(pickNextUnplayedVideo(videos, new Set(["dQw4w9WgXcQ"]))?.videoId).toBe("ox8lEnsxDag");
    expect(pickNextUnplayedVideo(videos, new Set(videos.map((video) => video.videoId)))).toBeNull();
  });
});
