declare module "youtube-player" {
  export type YouTubePlayerListener = {
    name: string;
    handler: (event: unknown) => void;
  };

  export type YouTubePlayerController = {
    on(eventName: string, listener: (event: unknown) => void): YouTubePlayerListener;
    off(listener: YouTubePlayerListener): void;
    destroy(): Promise<void>;
  };

  export type YouTubePlayerOptions = {
    width?: string | number;
    height?: string | number;
    videoId?: string;
    playerVars?: Record<string, string | number>;
  };

  export default function createYouTubePlayer(
    element: HTMLElement,
    options?: YouTubePlayerOptions,
  ): YouTubePlayerController;
}
