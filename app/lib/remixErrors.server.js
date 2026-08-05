/** Format Shopify Remix thrown Response / Error for UI. */
export async function formatRemixError(err) {
  if (err instanceof Response) {
    try {
      const data = await err.clone().json();
      const msg = data?.message || data?.error || data?.errors?.[0]?.message;
      if (msg) return msg;
    } catch {
      /* ignore */
    }
    return `Shopify request failed (${err.status}). Re-open the app from Shopify Admin.`;
  }
  return err?.message || "Request failed.";
}

export function formatRemixErrorSync(err) {
  if (err instanceof Response) {
    return `Shopify request failed (${err.status}). Re-open the app from Shopify Admin.`;
  }
  return err?.message || "Request failed.";
}
