export function isSupportedSourceUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:' || protocol === 'data:';
  } catch {
    return false;
  }
}
