export const OFFICIAL_URLS = {
  home: "https://weread.qq.com/",
  shelf: "https://weread.qq.com/web/shelf"
} as const;

export type OfficialAction = keyof typeof OFFICIAL_URLS;

export function officialUriForAction(action: unknown): string | undefined {
  if (action === "home" || action === "shelf") {
    return OFFICIAL_URLS[action];
  }
  return undefined;
}
