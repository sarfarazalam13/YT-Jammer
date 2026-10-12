export const ROOM_ID_PATTERN = /^[a-z0-9-]{4,32}$/;

const ROOM_WORDS = [
  "amber",
  "cedar",
  "coral",
  "cosmic",
  "echo",
  "indigo",
  "lunar",
  "neon",
  "orbit",
  "velvet",
] as const;

export function normalizeRoomId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 32);
}

export function isValidRoomId(value: string): boolean {
  return ROOM_ID_PATTERN.test(value);
}

export function roomIdFromSearch(search: string): string | null {
  const candidate = normalizeRoomId(new URLSearchParams(search).get("room") ?? "");
  return isValidRoomId(candidate) ? candidate : null;
}

export function createRoomId(random = Math.random): string {
  const first = ROOM_WORDS[Math.floor(random() * ROOM_WORDS.length) % ROOM_WORDS.length];
  const second = ROOM_WORDS[Math.floor(random() * ROOM_WORDS.length) % ROOM_WORDS.length];
  const suffix = Math.floor(random() * 36 ** 4)
    .toString(36)
    .padStart(4, "0");
  return `${first}-${second}-${suffix}`;
}

export function roomUrl(roomId: string, location: Pick<Location, "origin" | "pathname">): string {
  const url = new URL(location.pathname, location.origin);
  url.searchParams.set("room", roomId);
  return url.toString();
}
