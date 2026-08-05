import { Outlet, useLoaderData } from "@remix-run/react";
import { AppProvider } from "@shopify/polaris";
import enTranslations from "@shopify/polaris/locales/en.json";
import "@shopify/polaris/build/esm/styles.css";

function readCookie(cookieHeader, name) {
  const match = cookieHeader.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : "";
}

export const loader = async ({ request }) => {
  const { json } = await import("@remix-run/node");
  const { authenticate, prisma } = await import("../shopify.server.js");

  const url = new URL(request.url);
  const shopParam = url.searchParams.get("shop") || "";
  const tokenParam = url.searchParams.get("token") || "";

  const cookieHeader = request.headers.get("Cookie") || "";
  let token = tokenParam || readCookie(cookieHeader, "odoo_jwt_token") || null;
  let shop = shopParam || readCookie(cookieHeader, "shopify_shop_domain") || null;

  let session = null;

  try {
    const authResult = await authenticate.admin(request);
    session = authResult?.session;
    if (session?.shop) {
      shop = session.shop;
    }
  } catch (err) {
    if (!token || !shop) {
      if (err instanceof Response) throw err;
      throw err;
    }
  }

  // Auto-restore cookies / save query parameters to cookies
  let responseHeaders = null;
  const COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

  if (tokenParam || shopParam) {
    responseHeaders = new Headers();
    if (tokenParam) {
      responseHeaders.append("Set-Cookie", `odoo_jwt_token=${encodeURIComponent(tokenParam)}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=${COOKIE_MAX_AGE}`);
    }
    if (shopParam) {
      responseHeaders.append("Set-Cookie", `shopify_shop_domain=${encodeURIComponent(shopParam)}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=${COOKIE_MAX_AGE}`);
    }
  }

  const config = shop ? await prisma.shopConfig.findUnique({ where: { shop } }) : null;

  // Auto-restore cookies from DB if they are missing
  if (!token && config?.odooToken) {
    token = config.odooToken;
    const accountName = config.odooAccountName || "";
    const accountEmail = config.odooAccountEmail || "";

    if (!responseHeaders) responseHeaders = new Headers();
    responseHeaders.append("Set-Cookie", `odoo_jwt_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=${COOKIE_MAX_AGE}`);
    responseHeaders.append("Set-Cookie", `odoo_account_name=${encodeURIComponent(accountName)}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=${COOKIE_MAX_AGE}`);
    responseHeaders.append("Set-Cookie", `odoo_account_email=${encodeURIComponent(accountEmail)}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=${COOKIE_MAX_AGE}`);
  }

  const isAuthenticated = !!token;
  const odooBaseUrl = config?.odooBaseUrl || "http://161.97.133.248:8099";

  return json(
    { polarisTranslations: enTranslations, isAuthenticated, shop, token, odooBaseUrl },
    responseHeaders ? { headers: responseHeaders } : undefined
  );
};

export default function AppLayout() {
  const { polarisTranslations } = useLoaderData();

  return (
    <AppProvider i18n={polarisTranslations}>
      <Outlet />
    </AppProvider>
  );
}
