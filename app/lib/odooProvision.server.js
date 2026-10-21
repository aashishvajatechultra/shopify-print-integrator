/**
 * odooProvision.server.js
 *
 * Auto-provisions an Odoo internal manager user + merchant/store from the
 * Shopify embedded session so App Store reviewers never hit Design Studio signup.
 */

/**
 * Resolve staff/shop email for provisioning.
 */
export async function resolveShopifyStaffEmail(session, admin) {
  const associated =
    session?.onlineAccessInfo?.associated_user?.email ||
    session?.onlineAccessInfo?.associated_user?.account_owner_email ||
    "";
  if (associated) return associated;

  if (admin && typeof admin.graphql === "function") {
    try {
      const resp = await admin.graphql(`#graphql
        query ShopEmail {
          shop { email name }
        }
      `);
      const json = await resp.json();
      const email = json?.data?.shop?.email;
      if (email) return email;
    } catch (e) {
      console.warn("[Provision] Could not fetch shop email:", e.message);
    }
  }

  const shop = (session?.shop || "").replace(/\.myshopify\.com$/i, "");
  return shop ? `${shop}@shopify-merchant.local` : "";
}

/**
 * Call Odoo /api/shopify/auto-provision and return { token, account } or null.
 */
export async function provisionOdooMerchant(odooBaseUrl, {
  shop,
  email,
  name = "",
  accessToken = "",
  refreshToken = "",
  tokenExpiresAt = null,
}) {
  if (!odooBaseUrl || !shop || !email) return null;

  const url = `${odooBaseUrl.replace(/\/$/, "")}/api/shopify/auto-provision`;
  const secret = process.env.ODOO_PROVISION_SECRET || "";

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "call",
        id: 1,
        params: {
          shop_domain: shop,
          email,
          name: name || email.split("@")[0],
          access_token: accessToken || "",
          refresh_token: refreshToken || "",
          token_expires_at: tokenExpiresAt || "",
          secret,
        },
      }),
      signal: AbortSignal.timeout(12000),
    });
    const data = await resp.json();
    const result = data?.result;
    if (result?.success && result?.token) {
      console.log(`[Provision] ✓ Odoo user provisioned for ${shop}: ${email}`);
      return result;
    }
    console.warn("[Provision] Odoo response:", result || data?.error);
  } catch (e) {
    console.warn("[Provision] Failed:", e.message);
  }
  return null;
}
