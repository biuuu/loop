/** Request a small square image only from Netease's image CDN. */
export function neteaseCover(value: string, size: number): string {
  if (!Number.isSafeInteger(size) || size < 1) return value;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      (url.hostname !== 'music.126.net' &&
        !url.hostname.endsWith('.music.126.net'))
    )
      return value;
    url.searchParams.set('param', `${size}y${size}`);
    return url.href;
  } catch {
    return value;
  }
}
