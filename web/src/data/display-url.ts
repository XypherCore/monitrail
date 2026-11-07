/** Display projection for untrusted stored URLs. Never fall back to the input. */
export function displayMonitorUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return `${url.origin}${url.pathname}${url.search ? "?…" : ""}`;
    }
  } catch {
    // Legacy data can contain malformed URLs.
  }
  return "URL unavailable";
}
