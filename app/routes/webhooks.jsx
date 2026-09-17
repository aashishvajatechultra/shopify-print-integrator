import { authenticate } from "../shopify.server.js";
import db from "../db.server.js";
import crypto from "crypto";

export const loader = async () => {
  return new Response("Webhook endpoint alive", { status: 200 });
};

/**
 * Verify Shopify Webhook HMAC Signature according to:
 * https://shopify.dev/docs/apps/build/webhooks/verify-deliveries#hmac-verification
 */
function verifyHmac(rawBuffer, hmacHeader, secret) {
  if (!hmacHeader || !secret) return false;
  try {
    const generatedHash = crypto
      .createHmac("sha256", secret)
      .update(rawBuffer)
      .digest("base64");

    const a = Buffer.from(generatedHash, "utf8");
    const b = Buffer.from(hmacHeader, "utf8");

    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export const action = async ({ request }) => {
  const hmacHeader =
    request.headers.get("x-shopify-hmac-sha256") ||
    request.headers.get("X-Shopify-Hmac-Sha256");

  const secret = process.env.SHOPIFY_API_SECRET;

  // 1. Missing HMAC header -> Reject immediately with 401
  if (!hmacHeader) {
    console.warn("[Webhook]: Missing X-Shopify-Hmac-Sha256 header. Rejecting with 401.");
    return new Response("Unauthorized: Missing HMAC header", { status: 401 });
  }

  // 2. Read raw bytes and verify HMAC Signature
  let isValidCustomHmac = false;
  try {
    const clonedRequest = request.clone();
    const arrayBuf = await clonedRequest.arrayBuffer();
    const rawBuffer = Buffer.from(arrayBuf);
    const rawText = rawBuffer.toString("utf8");

    isValidCustomHmac =
      verifyHmac(rawBuffer, hmacHeader, secret) ||
      verifyHmac(Buffer.from(rawText, "utf8"), hmacHeader, secret);
  } catch (err) {
    console.error("[Webhook Body Read Error]:", err);
  }

  // Reject invalid / tampered HMAC with 401 Unauthorized
  if (!isValidCustomHmac) {
    console.warn("[Webhook]: Invalid HMAC signature header detected. Rejecting with 401.");
    return new Response("Unauthorized: Invalid HMAC signature", { status: 401 });
  }

  // 3. Process valid webhook (Return 200 OK for valid HMAC)
  try {
    const { topic, shop, session, payload } = await authenticate.webhook(request);

    console.log(`[Webhook] Received: ${topic} for shop: ${shop}`);

    switch (topic) {
      case "APP_UNINSTALLED":
        if (session) {
          await db.session.deleteMany({ where: { shop } });
          if (db.shopConfig) {
            await db.shopConfig.deleteMany({ where: { shop } });
          }
        }
        break;

      case "PRODUCTS_CREATE":
      case "PRODUCTS_UPDATE":
        if (payload) {
          syncProductToOdoo(shop, payload, "upsert").catch(err => {
            console.error("[Webhook Sync Error]:", err);
          });
        }
        break;

      case "PRODUCTS_DELETE":
        if (payload?.id) {
          syncProductToOdoo(shop, payload, "delete").catch(err => {
            console.error("[Webhook Delete Error]:", err);
          });
        }
        break;

      case "CUSTOMERS_DATA_REQUEST":
      case "CUSTOMERS_REDACT":
      case "SHOP_REDACT":
        break;

      default:
        break;
    }

    return new Response("OK", { status: 200 });
  } catch (e) {
    if (e instanceof Response && e.status === 401) {
      return e;
    }
    // HMAC signature is already verified valid -> Return 200 OK
    return new Response("OK", { status: 200 });
  }
};


async function syncProductToOdoo(shop, payload, mode = "upsert") {
  try {
    let config = await db.shopConfig.findUnique({ where: { shop } }).catch(() => null);

    // Fallback: use Railway env vars when DB is empty (SQLite ephemeral)
    const odooBaseUrl = config?.odooBaseUrl || process.env.ODOO_BASE_URL;
    if (!odooBaseUrl) {
      console.warn("[Webhook Sync]: No odooBaseUrl for shop", shop, "— skipping");
      return;
    }

    const base = odooBaseUrl.replace(/\/$/, "");

    // ── DELETE mode ──────────────────────────────────────────────────────────
    if (mode === "delete") {
      const shopifyProductId = String(payload.id);
      console.log(`[Webhook] Product deleted in Shopify: ${shopifyProductId} for ${shop}`);
      // Odoo side: mark mapping as inactive via the product-sync endpoint
      await fetch(`${base}/api/shopify/webhook/product-sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shop_domain: shop,
          products: [{
            shopify_product_id: shopifyProductId,
            status: "ARCHIVED",  // Mark as archived so it disappears from active list
          }],
        }),
        signal: AbortSignal.timeout(10000),
      });
      return;
    }

    // ── UPSERT mode (CREATE / UPDATE) ────────────────────────────────────────
    const variants = payload.variants || [];
    const firstVariant = variants[0];
    const mainImageUrl =
      payload.image?.src ||
      payload.images?.[0]?.src ||
      "";

    // Map shopify variant IDs
    const variantIds = variants.map(v => String(v.id));

    const productData = {
      shopify_product_id: String(payload.id),   // ← correct field name for Odoo
      title: payload.title || "",
      description: payload.body_html || "",
      price: firstVariant ? `$${firstVariant.price}` : "0.00",
      image: mainImageUrl,
      image_url: mainImageUrl,
      status: (payload.status || "active").toUpperCase(),
      category: payload.product_type || "Uncategorized",
      product_type: payload.product_type || "",
      handle: payload.handle || "",
      shopify_variant_ids: variantIds,
      variant_ids: variantIds,
      taxable: variants.some(v => v.taxable === true),
    };

    console.log(`[Webhook] Syncing product "${productData.title}" (${productData.shopify_product_id}) to Odoo for ${shop}`);

    const resp = await fetch(`${base}/api/shopify/webhook/product-sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        shop_domain: shop,
        products: [productData],
      }),
      signal: AbortSignal.timeout(15000),
    });

    const result = await resp.json().catch(() => ({}));
    console.log(`[Webhook] Odoo sync result:`, result);

  } catch (err) {
    console.error("[Webhook syncProductToOdoo error]:", err);
  }
}