import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server.js";
import { fetchAllShopifyProducts, callOdooJson } from "../lib/shopifyProductFetch.server.js";
import db from "../db.server.js";

export const action = async ({ request }) => {
  const form = await request.clone().formData();
  const token = form.get("token");
  const shopFromForm = form.get("shop");
  const odooBaseUrl = (form.get("odooBaseUrl") || "").replace(/\/$/, "");

  let admin;
  let session;

  // IMPORTANT: Always use authenticate.admin() via session token (Token Exchange flow).
  // Never fall back to unauthenticated.admin() with offline sessions — doing so
  // uses deprecated permanent offline tokens (shpat_) which triggers:
  //   "Deprecated offline token use detected" in Partner Dashboard
  //   and FAILS the "Using session tokens for user authentication" App Store check.
  try {
    const authResult = await authenticate.admin(request);
    admin = authResult.admin;
    session = authResult.session;
  } catch (err) {
    if (err instanceof Response) throw err;
    console.error("products-sync auth error:", err);
    return json(
      { success: false, error: "Shopify session expired. Please refresh the app page." },
      { status: 401 },
    );
  }

  const intent = form.get("intent");

  if (!token || !odooBaseUrl) {
    return json({ success: false, error: "Odoo connection required. Please login first." }, { status: 400 });
  }

  try {
    if (intent === "detect") {
      const shopifyProducts = await fetchAllShopifyProducts(session);
      const preview = await callOdooJson(
        odooBaseUrl,
        "/api/shopify/products/preview-sync",
        token,
        { products: shopifyProducts },
      );
      if (!preview.success) {
        return json({ success: false, error: preview.error || "Preview failed." }, { status: 400 });
      }
      return json({
        success: true,
        shop: session.shop,
        preview: preview.preview || [],
        counts: preview.counts || {},
        total: preview.total || 0,
      });
    }

    if (intent === "sync") {
      const productsJson = form.get("products");
      const products = productsJson ? JSON.parse(productsJson) : [];
      if (!products.length) {
        return json({ success: false, error: "No products selected." }, { status: 400 });
      }
      const result = await callOdooJson(
        odooBaseUrl,
        "/api/shopify/products/sync-items",
        token,
        { products },
      );
      if (!result.success) {
        return json({ success: false, error: result.error || "Sync failed." }, { status: 400 });
      }
      await db.shopConfig.updateMany({
        where: { shop: session.shop },
        data: { updatedAt: new Date() },
      });
      return json({
        success: true,
        created: result.created,
        updated: result.updated,
        total: result.total,
        products: result.products || [],
      });
    }

    return json({ success: false, error: "Unknown action." }, { status: 400 });
  } catch (err) {
    if (err instanceof Response) throw err;
    console.error("products-sync action error:", err);
    const msg = err?.message || String(err);
    return json({ success: false, error: msg || "Sync request failed." }, { status: 500 });
  }
};
