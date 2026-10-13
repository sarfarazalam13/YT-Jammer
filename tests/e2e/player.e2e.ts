import { expect, test, type Page } from "@playwright/test";

async function keepSmokeTestLocal(page: Page) {
  await page.route("**/*", (route) => {
    const hostname = new URL(route.request().url()).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" ? route.continue() : route.abort();
  });
}

test("room lobby remains usable", async ({ page }) => {
  await keepSmokeTestLocal(page);
  await page.goto("/", { waitUntil: "domcontentloaded", timeout: 10_000 });
  await expect(page.getByRole("heading", { name: "Start together." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create a room" })).toBeVisible();
  await expect(page.getByLabel("Join with a room code")).toBeEditable();
});

test("player modes are presentation-only and mini player stays compliant", async ({ page }) => {
  await keepSmokeTestLocal(page);
  await page.goto("/?room=smoke-room", { waitUntil: "domcontentloaded", timeout: 10_000 });

  const player = page.locator("#player");
  await expect(player).toHaveClass(/mode-video/);
  await page.getByRole("button", { name: "Mini player", exact: true }).click();
  await expect(player).toHaveClass(/mode-compact/);

  if (test.info().project.name === "mobile-chromium") {
    const frame = page.locator(".mode-compact .player-frame");
    await expect(frame).toBeVisible();
    const box = await frame.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(200);
    expect(box?.height).toBeGreaterThanOrEqual(200);
  }
});

test("Surf searches automatically after typing", async ({ page }) => {
  await keepSmokeTestLocal(page);
  await page.route("https://www.googleapis.com/youtube/v3/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/search")) {
      await route.fulfill({ json: { items: [{ id: { videoId: "abcdefghijk" }, snippet: { title: "Continuous result", channelTitle: "YT Jam Tests", thumbnails: {} } }] } });
      return;
    }
    await route.fulfill({ json: { items: [{ id: "abcdefghijk", snippet: { title: "Continuous result", channelTitle: "YT Jam Tests", thumbnails: {} }, contentDetails: { duration: "PT3M" } }] } });
  });
  await page.goto("/?room=smoke-room", { waitUntil: "domcontentloaded", timeout: 10_000 });
  const playerTop = await page.locator("#player").evaluate((element) => element.getBoundingClientRect().top + window.scrollY);
  const queueTop = await page.locator(".queue-card").evaluate((element) => element.getBoundingClientRect().top + window.scrollY);
  await page.getByRole("button", { name: "Surf YouTube" }).click();
  const search = page.getByLabel("Search YouTube or paste a video or playlist link");
  await expect(search).toBeFocused();
  await expect(page.locator(".surf-panel")).toBeVisible();
  await search.fill("lofi");
  await expect(page.getByText("Continuous result")).toBeVisible({ timeout: 5_000 });
  await expect.poll(() => page.locator("#player").evaluate((element) => element.getBoundingClientRect().top + window.scrollY)).toBe(playerTop);
  await expect.poll(() => page.locator(".queue-card").evaluate((element) => element.getBoundingClientRect().top + window.scrollY)).toBe(queueTop);
});

test("mixed YouTube links keep the linked song usable when playlist import fails", async ({ page }) => {
  await keepSmokeTestLocal(page);
  await page.route("https://www.googleapis.com/youtube/v3/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/playlistItems")) {
      await route.fulfill({ status: 404, json: { error: { errors: [{ reason: "playlistNotFound" }] } } });
      return;
    }
    await route.fulfill({ json: { items: [{
      id: "K9R7KcaettM",
      snippet: { title: "Linked song", channelTitle: "YT Jam Tests", thumbnails: {} },
      contentDetails: { duration: "PT3M12S" },
      status: { embeddable: true, privacyStatus: "public" },
    }] } });
  });
  await page.goto("/?room=smoke-room", { waitUntil: "domcontentloaded", timeout: 10_000 });
  await page.getByRole("button", { name: "Surf YouTube" }).click();
  await page.getByLabel("Search YouTube or paste a video or playlist link").fill("https://www.youtube.com/watch?v=K9R7KcaettM\\&list=PL5DigwkkJqqR439Nr1LJxaSuU1liDW7pJ\\&index=1\u00a0");
  await expect(page.getByText("Linked song", { exact: true })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole("button", { name: "Play linked song" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Queue song" })).toBeVisible();
  await expect(page.getByText(/Playlist import is unavailable/)).toBeVisible();
  await expect(page.getByText(/No embeddable videos found/)).toHaveCount(0);
});
