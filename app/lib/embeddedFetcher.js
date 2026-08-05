/** Preserve ?shop=&host= for embedded Shopify fetcher requests. */
export function embeddedApiPath(path, locationSearch = "") {
  const qs = (locationSearch || "").replace(/^\?/, "");
  if (!qs) return path;
  return path.includes("?") ? `${path}&${qs}` : `${path}?${qs}`;
}

export function embeddedApiSearchParams(locationSearch = "") {
  return new URLSearchParams((locationSearch || "").replace(/^\?/, ""));
}
