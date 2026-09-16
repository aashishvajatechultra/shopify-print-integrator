/**
 * odooTokenSync.server.js
 *
 * Pushes the Shopify access_token to the remote Odoo server dynamically.
 * Dual strategy:
 *   1. Custom endpoint /api/shopify/store-token (works after Odoo restart with new code)
 *   2. XML-RPC fallback (works ALWAYS - uses Odoo's built-in API, no custom code needed)
 *
 * Called on every page load from app._index.jsx loader.
 */

const ODOO_DB = process.env.ODOO_DB || "pod_shopify";
const ODOO_USER = process.env.ODOO_ADMIN_USER || "admin";
const ODOO_PASS = process.env.ODOO_ADMIN_PASS || "admin";

/**
 * Normalize a shop domain to plain form (no protocol, no trailing slash).
 */
function normalizeDomain(shop) {
  return shop.trim().toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
}

/**
 * Try the custom /api/shopify/store-token endpoint.
 * Returns true on success, false otherwise.
 */
async function tryCustomEndpoint(odooBaseUrl, shop, accessToken, odooToken, refreshToken = "", tokenExpiresAt = null) {
  try {
    const url = `${odooBaseUrl.replace(/\/$/, "")}/api/shopify/store-token`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "call",
        id: 1,
        params: {
          token: odooToken || "",
          shop_domain: shop,
          access_token: accessToken,
          refresh_token: refreshToken || "",
          token_expires_at: tokenExpiresAt || "",
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
    const data = await resp.json();
    if (data?.result?.success) {
      console.log(`[TokenSync] ✓ Custom endpoint saved token for: ${shop}`);
      return true;
    }
    console.warn(`[TokenSync] Custom endpoint response:`, data?.result || data?.error);
  } catch (e) {
    console.warn(`[TokenSync] Custom endpoint unavailable:`, e.message);
  }
  return false;
}

/**
 * Build a simple XML-RPC method call payload.
 */
function buildXmlRpc(method, ...args) {
  const serialize = (v) => {
    if (typeof v === "number" && Number.isInteger(v)) return `<int>${v}</int>`;
    if (typeof v === "string") return `<string>${v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</string>`;
    if (typeof v === "boolean") return `<boolean>${v ? 1 : 0}</boolean>`;
    if (Array.isArray(v)) return `<array><data>${v.map(serialize).join("")}</data></array>`;
    if (v && typeof v === "object") {
      const members = Object.entries(v)
        .map(([k, val]) => `<member><name>${k}</name><value>${serialize(val)}</value></member>`)
        .join("");
      return `<struct>${members}</struct>`;
    }
    return `<nil/>`;
  };
  const params = args.map(a => `<param><value>${serialize(a)}</value></param>`).join("");
  return `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${params}</params></methodCall>`;
}

/**
 * Parse a single integer from an XML-RPC response.
 */
function parseXmlRpcInt(text) {
  const m = text.match(/<(?:int|i4)>(\d+)<\/(?:int|i4)>/);
  return m ? parseInt(m[1]) : null;
}

/**
 * Parse a boolean result from an XML-RPC response.
 */
function parseXmlRpcBool(text) {
  return text.includes("<boolean>1</boolean>");
}

/**
 * Fallback: push token via Odoo's built-in XML-RPC API.
 * Works on ANY Odoo server without custom code or restart.
 */
async function tryXmlRpcFallback(odooBaseUrl, shop, accessToken, refreshToken = "", tokenExpiresAt = null) {
  const base = odooBaseUrl.replace(/\/$/, "");
  const normalized = normalizeDomain(shop);

  try {
    // Step 1: Authenticate
    const authXml = buildXmlRpc("authenticate", ODOO_DB, ODOO_USER, ODOO_PASS, {});
    const authResp = await fetch(`${base}/xmlrpc/2/common`, {
      method: "POST",
      headers: { "Content-Type": "text/xml" },
      body: authXml,
      signal: AbortSignal.timeout(8000),
    });
    const authText = await authResp.text();
    const uid = parseXmlRpcInt(authText);
    if (!uid) {
      console.error("[TokenSync] XML-RPC auth failed");
      return false;
    }

    const rpc = async (model, method, args, kwargs = {}) => {
      const xml = buildXmlRpc("execute_kw", ODOO_DB, uid, ODOO_PASS, model, method, args, kwargs);
      const r = await fetch(`${base}/xmlrpc/2/object`, {
        method: "POST",
        headers: { "Content-Type": "text/xml" },
        body: xml,
        signal: AbortSignal.timeout(8000),
      });
      return r.text();
    };

    // Step 2: Find tu.store by shop domain
    const searchText = await rpc("tu.store", "search",
      [[["shopify_url", "=ilike", normalized]]],
      { limit: 1 }
    );
    let storeId = parseXmlRpcInt(searchText);

    // Step 3: Create tu.store if not found (merchant_id may be required - handle gracefully)
    if (!storeId) {
      console.log(`[TokenSync] tu.store not found, attempting create for: ${normalized}`);
      try {
        // Resolve or create a merchant to associate with the store
        const mSearchText = await rpc("tu.merchant", "search", [[[]]], { limit: 1 });
        let merchantId = parseXmlRpcInt(mSearchText);
        if (!merchantId) {
          const mCreateText = await rpc("tu.merchant", "create", [{ name: `Merchant (${normalized})`, shopify_account_id: normalized }]);
          merchantId = parseXmlRpcInt(mCreateText);
        }
        const createData = { name: normalized, shopify_url: normalized };
        if (merchantId) createData.merchant_id = merchantId;

        const createText = await rpc("tu.store", "create", [createData]);
        storeId = parseXmlRpcInt(createText);
      } catch (createErr) {
        console.warn(`[TokenSync] tu.store create fallback: ${createErr.message}`);
        const retryText = await rpc("tu.store", "search",
          [[["shopify_url", "=", normalized]]],
          { limit: 1 }
        );
        storeId = parseXmlRpcInt(retryText);
      }
    }

    if (!storeId) {
      console.error("[TokenSync] Could not find or create tu.store for:", normalized);
      return false;
    }

    // Step 4: Write access_token + refresh_token + expiry to tu.store
    const writeData = { access_token: accessToken };
    if (refreshToken) writeData.refresh_token = refreshToken;
    if (tokenExpiresAt) writeData.token_expires_at = tokenExpiresAt;
    const writeText = await rpc("tu.store", "write", [[storeId], writeData]);
    if (parseXmlRpcBool(writeText)) {
      console.log(`[TokenSync] ✓ XML-RPC saved token fields to tu.store for: ${normalized}`);
    }

    // Step 5: Also update shopify.store.api_key
    const legacySearch = await rpc("shopify.store", "search",
      [[["shop_domain", "=ilike", normalized]]],
      { limit: 1 }
    );
    let legacyId = parseXmlRpcInt(legacySearch);

    if (!legacyId) {
      const legacyCreate = await rpc("shopify.store", "create",
        [{ name: normalized, shop_domain: normalized }]
      );
      legacyId = parseXmlRpcInt(legacyCreate);
    }

    if (legacyId) {
      await rpc("shopify.store", "write", [[legacyId], { api_key: accessToken }]);
      console.log(`[TokenSync] ✓ XML-RPC saved api_key to shopify.store for: ${normalized}`);
    }

    return true;
  } catch (e) {
    console.error("[TokenSync] XML-RPC fallback error:", e.message);
    return false;
  }
}

/**
 * Main export: push Shopify access_token to Odoo.
 *
 * Strategy:
 *   1. Try custom /api/shopify/store-token endpoint
 *   2. If that fails, try XML-RPC (always available)
 *
 * Fire-and-forget — does not block the page load.
 */
export function syncShopifyTokenToOdoo(odooBaseUrl, shop, accessToken, odooToken = "", refreshToken = "", tokenExpiresAt = null) {
  if (!odooBaseUrl || !shop || !accessToken) return;

  Promise.resolve()
    .then(() => tryCustomEndpoint(odooBaseUrl, shop, accessToken, odooToken, refreshToken, tokenExpiresAt))
    .then((ok) => {
      if (!ok) return tryXmlRpcFallback(odooBaseUrl, shop, accessToken, refreshToken, tokenExpiresAt);
    })
    .catch((e) => console.error("[TokenSync] Unexpected error:", e));
}
