import { describe, expect, it, vi } from "vitest";
import {
  fetchYouTubeVideos,
  fetchYouTubeVideoPage,
  parseIsoDuration,
  parseVideoItems,
  pickNextUnplayedVideo,
  readVideoCache,
  writeVideoCache,
} from "./youtube";

describe("YouTube discovery helpers", () => {
  it("parses ISO video durations", () => {
    expect(parseIsoDuration("PT4M13S")).toBe(253);
    expect(parseIsoDuration("PT1H2M3S")).toBe(3723);
    expect(parseIsoDuration("invalid")).toBe(0);
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
    expect(readVideoCache(storage, "cache", 2_000)).toEqual(page);
    expect(readVideoCache(storage, "cache", 1_000 + 16 * 60 * 1000)).toBeNull();
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
    const page = await fetchYouTubeVideoPage({ apiKey: "key", pageToken: "page-1", fetcher, storage: null });
    expect(page.nextPageToken).toBe("page-2");
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("pageToken=page-1");
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
