/**
 * autoOnboard.server.js
 *
 * Runs automatically when a new Shopify store installs the app.
 * Does the following in a single fire-and-forget call:
 *   1. Push the Shopify access_token to Odoo (via store-token endpoint + XML-RPC fallback)
 *   2. Fetch ALL products from the store via Shopify GraphQL
 *   3. Bulk-push them to Odoo's webhook product-sync endpoint
 *
 * This guarantees that the sync_details page shows ALL products the moment
 * a merchant opens the app for the first time (or after a Railway redeploy wipe).
 */

const SHOPIFY_API_VERSION = "2024-10";

const PRODUCTS_QUERY = `
  query SyncProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          title
          status
          handle
          productType
          featuredImage {
            url
          }
          variants(first: 50) {
            edges {
              node {
                id
                price
                taxable
              }
            }
          }
        }
      }
    }
  }
`;

function gidToId(gid) {
  if (!gid) return "";
  const parts = String(gid).split("/");
  return parts[parts.length - 1] || gid;
}

function mapNode(node) {
  const variants = (node.variants?.edges || []).map(e => e.node);
  const firstVariant = variants[0];
  const variantIds = variants.map(v => gidToId(v?.id));
  const taxable = variants.some(v => v?.taxable === true);

  return {
    shopify_product_id: gidToId(node.id),
    title: node.title || "",
    status: node.status || "ACTIVE",
    handle: node.handle || "",
    category: node.productType || "Uncategorized",
    product_type: node.productType || "",
    image: node.featuredImage?.url || "",
    price: firstVariant?.price ? `$${firstVariant.price}` : "0.00",
    variant_ids: variantIds,
    shopify_variant_ids: variantIds,
    taxable,
  };
}

/**
 * Fetch all products from a Shopify store via GraphQL (paginates through all pages).
 */
async function fetchAllProducts(shop, accessToken, pageSize = 50) {
  const allProducts = [];
  let after = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const resp = await fetch(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query: PRODUCTS_QUERY.trim(),
          variables: { first: pageSize, after },
        }),
        signal: AbortSignal.timeout(30000),
      }
    );

    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Shopify GraphQL error (${resp.status}): ${txt.slice(0, 200)}`);
    }

    const json = await resp.json();

    if (json.errors?.length) {
      throw new Error(json.errors.map(e => e.message).join("; "));
    }

    const connection = json?.data?.products;
    if (!connection) throw new Error("Shopify returned no products data.");

    for (const edge of connection.edges || []) {
      if (edge?.node) allProducts.push(mapNode(edge.node));
    }

    hasNextPage = connection.pageInfo?.hasNextPage || false;
    after = connection.pageInfo?.endCursor || null;
  }

  return allProducts;
}

/**
 * Push products to Odoo's webhook endpoint (no auth token required).
 */
async function pushProductsToOdoo(odooBaseUrl, shopDomain, products) {
  const url = `${odooBaseUrl.replace(/\/$/, "")}/api/shopify/webhook/product-sync`;

  // Push in batches of 25 to avoid large payload timeouts
  const BATCH = 25;
  let totalCreated = 0;
  let totalUpdated = 0;

  for (let i = 0; i < products.length; i += BATCH) {
    const batch = products.slice(i, i + BATCH);
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shop_domain: shopDomain, products: batch }),
        signal: AbortSignal.timeout(20000),
      });
      const data = await resp.json().catch(() => ({}));
      totalCreated += data.created || 0;
      totalUpdated += data.updated || 0;
    } catch (batchErr) {
      console.warn(`[AutoOnboard] Batch ${i}-${i + BATCH} failed:`, batchErr.message);
    }
  }

  return { created: totalCreated, updated: totalUpdated };
}

/**
 * Persist a fresh Shopify access token back to the Prisma SQLite Session row.
 * This ensures Odoo's Python service always reads a valid (non-expired) token
 * when it queries the SQLite DB directly.
 *
 * @param {string} shop        - e.g. "my-store.myshopify.com"
 * @param {string} accessToken - The fresh access token from authenticate.admin()
 */
async function persistFreshTokenToSqlite(shop, accessToken) {
  try {
    const { prisma } = await import("../shopify.server.js");

    // Calculate new expiry: 60 minutes from now (Shopify standard expiring token lifetime)
    const newExpires = new Date(Date.now() + 60 * 60 * 1000);

    // Update the offline session row for this shop via Prisma
    const result = await prisma.session.updateMany({
      where: {
        shop,
        id: { startsWith: "offline_" },
        isOnline: false,
      },
      data: {
        accessToken,
        expires: newExpires,
      },
    });

    if (result.count > 0) {
      console.log(`[AutoOnboard] ✓ Persisted fresh token to SQLite for: ${shop} (${result.count} row(s))`);
    } else {
      console.warn(`[AutoOnboard] No SQLite Session row found to update for: ${shop}`);
    }
  } catch (err) {
    // Non-fatal — just log it
    console.warn(`[AutoOnboard] Could not persist token to SQLite for ${shop}:`, err.message);
  }
}

/**
 * Main auto-onboarding function — call this fire-and-forget on new install.
 *
 * @param {object} session   - Shopify session (has .shop and .accessToken)
 * @param {string} odooBaseUrl - Production Odoo URL
 */
export async function autoOnboardStore(session, odooBaseUrl) {
  const { shop, accessToken } = session;
  if (!shop || !accessToken || !odooBaseUrl) {
    console.warn("[AutoOnboard] Missing required params, skipping.");
    return;
  }

  const base = odooBaseUrl.replace(/\/$/, "");
  console.log(`[AutoOnboard] Starting onboarding for: ${shop}`);

  // ── Step 0: Persist the fresh token from this session into SQLite ───────────
  // authenticate.admin() may have refreshed an expired token. Write it to the
  // SQLite Session row so Odoo can read a valid token immediately.
  await persistFreshTokenToSqlite(shop, accessToken);
  // ────────────────────────────────────────────────────────────────────────────

  try {
    // Step 1: Fetch all products from Shopify
    console.log(`[AutoOnboard] Fetching products from Shopify for: ${shop}`);
    const products = await fetchAllProducts(shop, accessToken);
    console.log(`[AutoOnboard] Fetched ${products.length} products from Shopify.`);

    if (products.length === 0) {
      console.log("[AutoOnboard] No products found, skipping push.");
      return;
    }

    // Step 2: Push to Odoo
    console.log(`[AutoOnboard] Pushing ${products.length} products to Odoo...`);
    const result = await pushProductsToOdoo(base, shop, products);
    console.log(
      `[AutoOnboard] ✓ Done for ${shop}: created=${result.created} updated=${result.updated}`
    );
  } catch (err) {
    console.error(`[AutoOnboard] Error for ${shop}:`, err.message);
  }
}
