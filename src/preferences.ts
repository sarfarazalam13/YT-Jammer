export type PlayerModePreference = "video" | "compact";

export type PlayerPreferences = {
  mode: PlayerModePreference;
  volume: number;
  muted: boolean;
  playbackEnabled: boolean;
};

export const DEFAULT_PLAYER_PREFERENCES: PlayerPreferences = {
  mode: "video",
  volume: 100,
  muted: false,
  playbackEnabled: true,
};

const STORAGE_KEY = "yt-jam:player-preferences";

export function readPlayerPreferences(storage: Storage | null): PlayerPreferences {
  if (!storage) return DEFAULT_PLAYER_PREFERENCES;
  try {
    const value = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null") as Record<string, unknown> | null;
    if (!value) {
      const legacyMode = storage.getItem("yt-jam:player-mode");
      return { ...DEFAULT_PLAYER_PREFERENCES, mode: legacyMode === "compact" ? "compact" : "video" };
    }
    return {
      mode: value.mode === "compact" ? "compact" : "video",
      volume: typeof value.volume === "number" && Number.isFinite(value.volume)
        ? Math.min(100, Math.max(0, Math.round(value.volume)))
        : DEFAULT_PLAYER_PREFERENCES.volume,
      muted: value.muted === true,
      playbackEnabled: value.playbackEnabled !== false,
    };
  } catch {
    return DEFAULT_PLAYER_PREFERENCES;
  }
}

export function writePlayerPreferences(storage: Storage | null, value: PlayerPreferences): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Playback remains usable when storage is blocked or full.
  }
}
