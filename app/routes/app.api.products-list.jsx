import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server.js";
import { callOdooJson } from "../lib/shopifyProductFetch.server.js";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const odooBaseUrl = (url.searchParams.get("odooBaseUrl") || "").replace(/\/$/, "");

  // Bypass Shopify admin check if Odoo token is present
  if (!token) {
    try {
      await authenticate.admin(request);
    } catch (err) {
      if (err instanceof Response) throw err;
      console.error("products-list auth error:", err);
      return json({ success: false, error: "Shopify session missing.", products: [] }, { status: 401 });
    }
  }
  if (!token || !odooBaseUrl) {
    return json({ success: false, error: "Missing token or Odoo URL.", products: [] });
  }

  try {
    const result = await callOdooJson(odooBaseUrl, "/api/shopify/products", token, {});
    return json({
      success: !!result.success,
      products: result.products || [],
      error: result.error || null,
    });
  } catch (err) {
    console.error("products-list loader error:", err);
    return json({ success: false, error: err.message, products: [] });
  }
};
