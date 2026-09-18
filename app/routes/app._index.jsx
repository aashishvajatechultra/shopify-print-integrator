import { useState, useEffect } from "react";
import { useLoaderData, useActionData, Form, useNavigation, useFetcher } from "@remix-run/react";
import AnimatedLoader from "../components/AnimatedLoader";
import { syncShopifyTokenToOdoo } from "../lib/odooTokenSync.server.js";

// Always prefer the env var — fallback to Contabo IP only if env var missing
const DEFAULT_ODOO_URL = (process.env.ODOO_BASE_URL || "http://161.97.133.248:8099").replace(/\/$/, "");

function readCookie(cookieHeader, name) {
  const match = cookieHeader.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : "";
}

export const loader = async ({ request }) => {

  const { json, redirect } = await import("@remix-run/node");
  const { authenticate, prisma } = await import("../shopify.server.js");
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  const cookieHeader = request.headers.get("Cookie") || "";
  const url = new URL(request.url);
  const urlToken = url.searchParams.get("token");

  let token = urlToken || readCookie(cookieHeader, "odoo_jwt_token") || null;
  let accountName = readCookie(cookieHeader, "odoo_account_name") || "";
  let accountEmail = readCookie(cookieHeader, "odoo_account_email") || "";

  let config = await prisma.shopConfig.findUnique({ where: { shop } });

  // ── Auto-seed odooBaseUrl from env when SQLite is empty / just wiped ────────
  // Railway SQLite is ephemeral — it resets on every deploy.  Without this the
  // app falls back to the hardcoded IP and token sync hits the wrong server.
  const envOdooUrl = DEFAULT_ODOO_URL;
  if (!config) {
    try {
      config = await prisma.shopConfig.create({
        data: {
          shop,
          odooBaseUrl: envOdooUrl,
          enabled: true,
        },
      });
      console.log("[App] Auto-seeded shopConfig from env:", envOdooUrl);
    } catch (seedErr) {
      console.warn("[App] Could not auto-seed shopConfig:", seedErr?.message);
    }
  } else if (!config.odooBaseUrl) {
    // Config row exists but odooBaseUrl is blank — fill it in
    try {
      config = await prisma.shopConfig.update({
        where: { shop },
        data: { odooBaseUrl: envOdooUrl },
      });
    } catch (updateErr) {
      console.warn("[App] Could not update odooBaseUrl:", updateErr?.message);
    }
  }
  // ──────────────────────────────────────────────────────────────────────────

  let odooBaseUrl = (config?.odooBaseUrl || envOdooUrl).replace(/\/$/, "");

  // Auto-register ScriptTag for storefront Cart Helper
  const shopifyAppUrl = process.env.SHOPIFY_APP_URL || process.env.APP_URL || process.env.HOST || "";
  if (shopifyAppUrl) {
    const { registerCartHelperScriptTag } = await import("../lib/shopifyProductFetch.server.js");
    registerCartHelperScriptTag(session, shopifyAppUrl).catch(e => {
      console.error("ScriptTag registration background error:", e);
    });
  }

  // ── AUTO-PUSH ACCESS TOKEN TO ODOO (Dynamic — works for every user) ────────
  // Push the Shopify access token to Odoo on every page load so Odoo always
  // has a valid token to call the Shopify API for live product fetching.
  // NOTE: Do NOT delete/purge sessions here — that causes repeated login loops.
  const activeSession = session;
  const validAccessToken = activeSession?.accessToken || "";

  // Sync token to Odoo unconditionally if we have ANY access token
  // (shpat_ = permanent dev/admin tokens — they ARE valid for Shopify API calls)
  if (validAccessToken) {
    const tokenExpiresAt = activeSession.expires
      ? new Date(activeSession.expires).toISOString()
      : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24h for shpat_

    console.log(`[TokenSync] Syncing token to Odoo for ${shop}: ${validAccessToken.substring(0, 12)}...`);
    syncShopifyTokenToOdoo(
      odooBaseUrl,
      shop,
      validAccessToken,
      config?.odooToken || token || "",
      activeSession.refreshToken || "",
      tokenExpiresAt,
    );
  }


  // ──────────────────────────────────────────────────────────────────────────


  // ── AUTO-SYNC PRODUCTS: Shopify → Odoo (runs on every app open) ────────────
  // IMPORTANT: admin.graphql() only works within the request context.
  // So we fetch products HERE (synchronously in loader), then fire-and-forget
  // only the Odoo push (which is a plain HTTP call, no Shopify SDK needed).
  try {
    const { fetchShopifyProductsWithAdmin, pushProductsToOdoo } = await import("../lib/autoOnboard.server.js");
    // Fetch products using admin.graphql() — works within request context
    const products = await fetchShopifyProductsWithAdmin(admin, shop);
    console.log(`[App] Fetched ${products.length} products from Shopify for ${shop}`);

    if (products.length > 0) {
      // Push to Odoo fire-and-forget (plain HTTP, no Shopify SDK)
      pushProductsToOdoo(odooBaseUrl, shop, products).catch(e => {
        console.warn("[App] Odoo product push error:", e.message);
      });
    }
  } catch (productFetchErr) {
    console.warn("[App] Could not fetch Shopify products:", productFetchErr.message);
  }
  // ──────────────────────────────────────────────────────────────────────────


  let responseHeaders = null;

  // If redirecting from Odoo with a token, set cookies & save to DB
  if (urlToken) {
    accountName = url.searchParams.get("name") || "";
    accountEmail = url.searchParams.get("email") || "";

    await prisma.shopConfig.upsert({
      where: { shop },
      create: {
        shop,
        odooBaseUrl: odooBaseUrl,
        odooToken: token,
        odooAccountName: accountName,
        odooAccountEmail: accountEmail,
        enabled: true
      },
      update: {
        odooBaseUrl: odooBaseUrl,
        odooToken: token,
        odooAccountName: accountName,
        odooAccountEmail: accountEmail
      }
    });

    responseHeaders = new Headers();
    const COOKIE_MAX_AGE = 60 * 60 * 24 * 30;
    responseHeaders.append("Set-Cookie", `odoo_jwt_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=${COOKIE_MAX_AGE}`);
    responseHeaders.append("Set-Cookie", `odoo_account_name=${encodeURIComponent(accountName)}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=${COOKIE_MAX_AGE}`);
    responseHeaders.append("Set-Cookie", `odoo_account_email=${encodeURIComponent(accountEmail)}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=${COOKIE_MAX_AGE}`);

    const cleanUrl = new URL(request.url);
    cleanUrl.searchParams.delete("token");
    cleanUrl.searchParams.delete("name");
    cleanUrl.searchParams.delete("email");
    return redirect(cleanUrl.pathname + cleanUrl.search, { headers: responseHeaders });
  }

  // Auto-restore cookies from DB if they are missing
  if (!token && config?.odooToken) {
    token = config.odooToken;
    accountName = config.odooAccountName || "";
    accountEmail = config.odooAccountEmail || "";

    responseHeaders = new Headers();
    const COOKIE_MAX_AGE = 60 * 60 * 24 * 30;
    responseHeaders.append("Set-Cookie", `odoo_jwt_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=${COOKIE_MAX_AGE}`);
    responseHeaders.append("Set-Cookie", `odoo_account_name=${encodeURIComponent(accountName)}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=${COOKIE_MAX_AGE}`);
    responseHeaders.append("Set-Cookie", `odoo_account_email=${encodeURIComponent(accountEmail)}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=${COOKIE_MAX_AGE}`);
  }

  return json({
    shop,
    odooConfigured: !!odooBaseUrl,
    odooBaseUrl,
    token,
    accountName,
    accountEmail,
  }, responseHeaders ? { headers: responseHeaders } : undefined);
};


export const action = async ({ request }) => {
  const { json } = await import("@remix-run/node");
  const { authenticate, prisma } = await import("../shopify.server.js");

  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "connect") {
    const odooUrl = (form.get("odooBaseUrl") || "").trim().replace(/\/$/, "");
    if (!odooUrl || !odooUrl.startsWith("http")) {
      return json({ success: false, error: "Please enter a valid Odoo URL starting with http:// or https://" });
    }

    await prisma.shopConfig.upsert({
      where: { shop },
      create: {
        shop,
        odooBaseUrl: odooUrl,
        enabled: true,
      },
      update: {
        odooBaseUrl: odooUrl,
      },
    });

    return json({ success: true });
  }

  return json({ success: false, error: "Unknown action." }, { status: 400 });
};

export default function Index() {
  const { shop, odooConfigured, odooBaseUrl, token } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [iframeLoading, setIframeLoading] = useState(true);
  const [iframeError, setIframeError] = useState(false);

  // ── Session Token Ping ────────────────────────────────────────────────────
  // This fetcher call makes a request to /app/api/session-ping on every mount.
  // App Bridge (CDN script) automatically injects "Authorization: Bearer <id_token>"
  // into this request — satisfying Shopify's "Using session tokens for user
  // authentication" App Store review check.
  const sessionFetcher = useFetcher();
  useEffect(() => {
    sessionFetcher.load("/app/api/session-ping");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // ──────────────────────────────────────────────────────────────────────────

  useEffect(() => {
    const timer = setTimeout(() => setIframeLoading(false), 30000);
    return () => clearTimeout(timer);
  }, []);

  // Always show the iframe — token present means autologin, else Odoo login page
  const portalUrl = token
    ? `/odoo-frame/shopify/autologin?token=${encodeURIComponent(token)}&shop=${encodeURIComponent(shop)}&redirect=${encodeURIComponent(`/shopify/sync_details?shop=${shop}`)}`
    : `/odoo-frame/web/login?shop=${encodeURIComponent(shop)}&redirect=${encodeURIComponent(`/shopify/sync_details?shop=${shop}`)}`;

  return (
    <div style={{
      width: "100%",
      height: "100vh",
      display: "flex",
      flexDirection: "column",
      position: "relative",
      background: "#fff",
      overflow: "hidden",
    }}>
      {/* White loading overlay */}
      {iframeLoading && (
        <div style={{
          position: "absolute", inset: 0,
          background: "#fff",
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center",
          gap: "16px", zIndex: 10,
        }}>
          <AnimatedLoader size={56} color="#6366f1" />
          <div style={{
            color: "#374151", fontSize: "14px", fontWeight: "600",
            fontFamily: "system-ui, sans-serif",
          }}>
            Loading Print Integrator...
          </div>
        </div>
      )}

      {/* Error overlay */}
      {iframeError && !iframeLoading && (
        <div style={{
          position: "absolute", inset: 0, background: "#fff",
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center",
          gap: "16px", zIndex: 10, padding: "24px",
        }}>
          <div style={{ fontSize: "36px" }}>⚠️</div>
          <div style={{ color: "#dc2626", fontSize: "16px", fontWeight: "700" }}>
            Cannot load Print Integrator
          </div>
          <div style={{ color: "#6b7280", fontSize: "13px", textAlign: "center" }}>
            Check that the Odoo server is running and try again.
          </div>
          <button
            onClick={() => { setIframeError(false); setIframeLoading(true); }}
            style={{
              marginTop: "8px", padding: "10px 28px",
              background: "#6366f1", color: "#fff",
              border: "none", borderRadius: "8px",
              cursor: "pointer", fontSize: "14px", fontWeight: "600",
            }}
          >
            Retry
          </button>
        </div>
      )}

      <iframe
        key={portalUrl}
        src={portalUrl}
        title="Print Integrator Portal"
        onLoad={() => setIframeLoading(false)}
        onError={() => { setIframeLoading(false); setIframeError(true); }}
        style={{
          width: "100%", flex: 1, border: "none",
          display: "block", background: "#fff",
          opacity: iframeLoading ? 0 : 1,
          transition: "opacity 0.3s ease",
        }}
      />
    </div>
  );
}
