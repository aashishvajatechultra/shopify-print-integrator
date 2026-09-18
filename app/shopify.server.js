import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import { PrismaClient } from "@prisma/client";
import { Session } from "@shopify/shopify-api";

const prisma = new PrismaClient();

// Helper to sanitize shop name
function sanitizeShopName(shop) {
  if (!shop) return "";
  let cleanShop = shop.toString().trim().toLowerCase();
  cleanShop = cleanShop.replace(/^https?:\/\//, "");
  cleanShop = cleanShop.split("/")[0];
  if (!cleanShop.endsWith(".myshopify.com") && !cleanShop.endsWith(".shopify.io")) {
    cleanShop = `${cleanShop}.myshopify.com`;
  }
  return cleanShop;
}

// Helper to refresh access token using refresh token
async function refreshAccessToken(shop, refreshToken) {
  const body = {
    client_id: process.env.SHOPIFY_API_KEY,
    client_secret: process.env.SHOPIFY_API_SECRET || "",
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  };

  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000), // Prevent ETIMEDOUT hangs
  });

  if (!response.ok) {
    const errBody = await response.text();
    console.error("Token refresh request failed:", errBody);
    return null;
  }

  return await response.json();
}

class CustomPrismaSessionStorage extends PrismaSessionStorage {
  constructor(prismaClient) {
    super(prismaClient);
  }

  sessionToRow(session) {
    const row = super.sessionToRow(session);
    row.refreshToken = session.refreshToken || null;
    row.refreshTokenExpires = session.refreshTokenExpires || null;
    return row;
  }

  rowToSession(row) {
    const session = super.rowToSession(row);
    if (session) {
      session.refreshToken = row.refreshToken;
      session.refreshTokenExpires = row.refreshTokenExpires;
    }
    return session;
  }

  async findSessionsByShop(shop) {
    const sessions = await super.findSessionsByShop(shop);
    return (sessions || []).filter(
      (s) => !(s.accessToken && s.accessToken.startsWith("shpat_"))
    );
  }

  async loadSession(id) {
    const session = await super.loadSession(id);
    if (!session) return undefined;

    // Reject all legacy non-expiring shpat_ tokens so @shopify/shopify-app-remix performs fresh tokenExchange
    if (session.accessToken && session.accessToken.startsWith("shpat_")) {
      return undefined;
    }

    // If there's no refresh token on offline sessions, force session to be expired
    if (!session.isOnline && !session.refreshToken) {
      session.expires = new Date(0);
      return session;
    }

    // Automatically refresh if token is expired or close to expiry (within 5 minutes)
    if (session.refreshToken && session.expires && session.expires.getTime() - 300000 < Date.now()) {
      try {
        const refreshedData = await refreshAccessToken(session.shop, session.refreshToken);
        if (refreshedData) {
          session.accessToken = refreshedData.access_token;
          session.expires = new Date(Date.now() + refreshedData.expires_in * 1000);
          session.refreshToken = refreshedData.refresh_token;
          if (refreshedData.refresh_token_expires_in) {
            session.refreshTokenExpires = new Date(Date.now() + refreshedData.refresh_token_expires_in * 1000);
          } else {
            session.refreshTokenExpires = null;
          }

          // Save the refreshed session back to the DB
          await this.storeSession(session);
        }
      } catch (error) {
        console.error(`=== Failed to refresh session ${id}: ===`, error);
      }
    }

    return session;
  }
}

// ── Startup guard ────────────────────────────────────────────────────────
// If these are missing/empty in production (e.g. not set in Render's
// Environment tab), the app used to boot anyway with an empty API secret —
// which silently breaks OAuth AND webhook HMAC verification with no clear
// error. Fail loudly at startup instead, so the real cause shows up in the
// deploy logs immediately.
const REQUIRED_ENV_VARS = ["SHOPIFY_API_KEY", "SHOPIFY_API_SECRET", "SHOPIFY_APP_URL"];
const missingEnvVars = REQUIRED_ENV_VARS.filter((key) => !process.env[key] || !process.env[key].trim());
if (missingEnvVars.length > 0) {
  throw new Error(
    `[shopify.server] Missing required environment variable(s): ${missingEnvVars.join(", ")}. ` +
    `Set these in your hosting provider's Environment settings (e.g. Render → Environment tab) ` +
    `using the values from Shopify Partner Dashboard → App setup → Client credentials.`
  );
}

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  apiVersion: ApiVersion.July26,
  scopes: ["read_products", "write_products", "write_script_tags", "read_script_tags"],
  appUrl: process.env.SHOPIFY_APP_URL || process.env.APP_URL || process.env.HOST || "",
  authPathPrefix: "/auth",
  sessionStorage: new CustomPrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  future: {
    unstable_newEmbeddedAuthStrategy: true,
  },
  // ── Auto-register webhooks so Shopify sends real-time product events ──────
  // When a merchant adds/updates a product in Shopify, we get notified
  // and immediately push it to Odoo — fully automatic, no manual action needed.
  webhooks: {
    PRODUCTS_CREATE: {
      deliveryMethod: "http",
      callbackUrl: "/webhooks",
    },
    PRODUCTS_UPDATE: {
      deliveryMethod: "http",
      callbackUrl: "/webhooks",
    },
    PRODUCTS_DELETE: {
      deliveryMethod: "http",
      callbackUrl: "/webhooks",
    },
    APP_UNINSTALLED: {
      deliveryMethod: "http",
      callbackUrl: "/webhooks",
    },
  },
  // ─────────────────────────────────────────────────────────────────────────
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

// Monkey patch tokenExchange to request expiring tokens
if (shopify?.api?.auth) {
  shopify.api.auth.tokenExchange = async ({ shop, sessionToken, requestedTokenType }) => {
    await shopify.api.session.decodeSessionToken(sessionToken);

    const cleanShop = sanitizeShopName(shop);

    const body = {
      client_id: shopify.api.config.apiKey,
      client_secret: shopify.api.config.apiSecretKey,
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: sessionToken,
      subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
      requested_token_type: requestedTokenType,
      expiring: 1, // request expiring tokens
    };

    const response = await fetch(`https://${cleanShop}/admin/oauth/access_token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error("Token exchange request failed:", errBody);
      throw new Error(`Token exchange failed: ${errBody}`);
    }

    const responseBody = await response.json();

    const isOnline = Boolean(responseBody.associated_user);
    const getSessionExpiration = (expires_in) => new Date(Date.now() + expires_in * 1000);

    let sessionId;
    let expires;
    let onlineAccessInfo;

    if (isOnline) {
      const { access_token, scope, ...rest } = responseBody;
      sessionId = shopify.api.session.getJwtSessionId(shop, `${rest.associated_user.id}`);
      onlineAccessInfo = rest;
      expires = getSessionExpiration(rest.expires_in);
    } else {
      sessionId = shopify.api.session.getOfflineId(shop);
      if (responseBody.expires_in) {
        expires = getSessionExpiration(responseBody.expires_in);
      }
    }

    const session = new Session({
      id: sessionId,
      shop: cleanShop,
      state: "",
      isOnline,
      accessToken: responseBody.access_token,
      scope: responseBody.scope,
      expires,
      ...(isOnline ? { onlineAccessInfo } : {}),
    });

    // Attach refresh token fields dynamically so our custom session storage can pick them up
    session.refreshToken = responseBody.refresh_token || null;
    if (responseBody.refresh_token_expires_in) {
      session.refreshTokenExpires = new Date(Date.now() + responseBody.refresh_token_expires_in * 1000);
    } else {
      session.refreshTokenExpires = null;
    }

    return { session };
  };
}


export default shopify;
export const apiVersion = ApiVersion.July26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;

export { prisma };