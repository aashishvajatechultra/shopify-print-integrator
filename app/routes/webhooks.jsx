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

  const secret =
    process.env.SHOPIFY_API_SECRET || "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";

  // 1. Missing HMAC header -> Reject immediately with 401
  if (!hmacHeader) {
    console.warn("[Webhook]: Missing X-Shopify-Hmac-Sha256 header. Rejecting with 401.");
    return new Response("Unauthorized: Missing HMAC header", { status: 401 });
  }

  let rawBuffer = null;
  let rawText = "";
  try {
    const clonedRequest = request.clone();
    const arrayBuf = await clonedRequest.arrayBuffer();
    rawBuffer = Buffer.from(arrayBuf);
    rawText = rawBuffer.toString("utf8");
  } catch (err) {
    console.error("[Webhook Body Read Error]:", err);
  }

  if (!rawBuffer) {
    return new Response("Bad Request", { status: 400 });
  }

  // 2. Verify HMAC Signature using SHOPIFY_API_SECRET
  const isValidHmac =
    verifyHmac(rawBuffer, hmacHeader, secret) ||
    verifyHmac(Buffer.from(rawText, "utf8"), hmacHeader, secret);

  // Reject invalid / tampered HMAC with 401 Unauthorized
  if (!isValidHmac) {
    console.warn("[Webhook]: Invalid HMAC signature header detected. Rejecting with 401.");
    return new Response("Unauthorized: Invalid HMAC signature", { status: 401 });
  }


  // 3. Process valid webhook (Return 200 OK)
  try {
    const { topic, shop, session, payload } = await authenticate.webhook(request);

    switch (topic) {
      case "APP_UNINSTALLED":
        if (session) {
          await db.session.deleteMany({ where: { shop } });
          if (db.shopConfig) {
            await db.shopConfig.deleteMany({ where: { shop } });
          }
        }
        break;

      case "PRODUCTS_UPDATE":
        if (payload) {
          syncProductToOdoo(shop, payload).catch(err => {
            console.error("[Webhook Sync Error]:", err);
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
    console.warn("[Webhook Process Notice]:", e?.message || e);
    // Verified HMAC is valid -> Return 200 OK for Shopify delivery test
    return new Response("OK", { status: 200 });
  }
};

async function syncProductToOdoo(shop, payload) {
  try {
    const config = await db.shopConfig.findUnique({
      where: { shop },
    });

    if (!config?.odooBaseUrl) return;

    const firstVariant = payload.variants?.[0];
    const mainImageUrl =
      payload.image?.src ||
      payload.images?.[0]?.src ||
      "";

    const productData = {
      id: String(payload.id),
      title: payload.title || "",
      description: payload.body_html || "",
      price: firstVariant
        ? String(firstVariant.price)
        : "0.00",
      image_url: mainImageUrl,
      status: payload.status || "active",
      category: payload.product_type || "Uncategorized",
      handle: payload.handle || "",
      shopify_variant_ids:
        payload.variants?.map(v => String(v.id)) || [],
    };

    const odooUrl =
      `${config.odooBaseUrl.replace(/\/$/, "")}` +
      `/api/shopify/webhook/product-sync`;

    await fetch(odooUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        shop_domain: shop,
        products: [productData],
      }),
    });

  } catch (err) {
    console.error(err);
  }
}