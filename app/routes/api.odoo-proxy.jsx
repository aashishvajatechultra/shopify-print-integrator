// app/routes/api.odoo-proxy.jsx
// ─────────────────────────────────────────────────────────────────────────────
// Server-side proxy: forwards every request from the HTTPS Remix app to the
// plain-HTTP Odoo server, so the browser never sees a mixed-content load.
//
// Usage:  iframe src="/api/odoo-proxy?path=/shopify/autologin&token=xxx&shop=yyy"
// All other paths: /api/odoo-proxy?path=/web/login  etc.
// ─────────────────────────────────────────────────────────────────────────────

const ODOO_BASE_URL = process.env.ODOO_BASE_URL || "http://161.97.133.248:8099";

/**
 * Strip hop-by-hop headers that must not be forwarded.
 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authorization",
  "proxy-authenticate",
]);

function forwardHeaders(request) {
  const headers = new Headers();
  for (const [key, value] of request.headers.entries()) {
    if (!HOP_BY_HOP.has(key.toLowerCase()) && key.toLowerCase() !== "host") {
      headers.set(key, value);
    }
  }
  // Tell Odoo it is behind a proxy serving HTTPS
  headers.set("X-Forwarded-Proto", "https");
  headers.set("X-Forwarded-For", "127.0.0.1");
  return headers;
}

/**
 * Rewrite absolute Odoo URLs inside HTML/JS/CSS so they route back through
 * this proxy instead of directly to the HTTP Odoo server.
 */
function rewriteBody(text, odooOrigin, proxyBase) {
  // Replace http://odoo-origin with /api/odoo-proxy?path=
  // Handles href="http://...", src="http://...", url(http://...) etc.
  return text
    .replace(
      new RegExp(odooOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
      proxyBase
    )
    // Rewrite absolute Odoo paths (/web/..., /shopify/...) embedded in JSON or HTML
    .replace(/\\"\/web\//g, `\\"/api/odoo-proxy?path=/web/`)
    .replace(/\\"\/shopify\//g, `\\"/api/odoo-proxy?path=/shopify/`);
}

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  // Build the Odoo target URL: take ?path= and forward all other query params
  const odooPath = url.searchParams.get("path") || "/web/login";
  url.searchParams.delete("path");

  // Rebuild remaining query params to append to odoo path
  const remainingParams = url.searchParams.toString();
  const odooUrl = `${ODOO_BASE_URL}${odooPath}${remainingParams ? `?${remainingParams}` : ""}`;

  try {
    const odooResp = await fetch(odooUrl, {
      method: "GET",
      headers: forwardHeaders(request),
      redirect: "manual", // handle redirects ourselves
    });

    // Handle redirects from Odoo – rewrite Location header
    if (odooResp.status >= 300 && odooResp.status < 400) {
      const location = odooResp.headers.get("location") || "/";
      let newLocation = location;
      if (location.startsWith(ODOO_BASE_URL)) {
        const redirectPath = location.slice(ODOO_BASE_URL.length);
        newLocation = `/api/odoo-proxy?path=${encodeURIComponent(redirectPath)}`;
      } else if (location.startsWith("/")) {
        newLocation = `/api/odoo-proxy?path=${encodeURIComponent(location)}`;
      }
      return new Response(null, {
        status: odooResp.status,
        headers: {
          Location: newLocation,
          "Cache-Control": "no-store",
        },
      });
    }

    const contentType = odooResp.headers.get("content-type") || "";
    const responseHeaders = new Headers();

    // Forward safe response headers
    for (const [key, value] of odooResp.headers.entries()) {
      if (!HOP_BY_HOP.has(key.toLowerCase())) {
        if (key.toLowerCase() === "set-cookie") {
          // Make cookies work cross-origin inside the HTTPS iframe
          let cookie = value;
          if (!cookie.includes("SameSite=")) cookie += "; SameSite=None";
          else cookie = cookie.replace(/SameSite=\w+/i, "SameSite=None");
          if (!cookie.includes("Secure")) cookie += "; Secure";
          responseHeaders.append("Set-Cookie", cookie);
        } else if (key.toLowerCase() !== "content-security-policy" &&
          key.toLowerCase() !== "x-frame-options") {
          responseHeaders.set(key, value);
        }
      }
    }

    // Allow embedding in Shopify iframe
    responseHeaders.set("X-Frame-Options", "ALLOWALL");
    responseHeaders.set(
      "Content-Security-Policy",
      "frame-ancestors *"
    );

    // For text content: rewrite Odoo URLs to route via proxy
    if (
      contentType.includes("text/html") ||
      contentType.includes("text/css") ||
      contentType.includes("application/javascript") ||
      contentType.includes("text/javascript")
    ) {
      const text = await odooResp.text();
      const proxyBase = "/api/odoo-proxy?path=";
      const rewritten = rewriteBody(text, ODOO_BASE_URL, proxyBase);
      return new Response(rewritten, {
        status: odooResp.status,
        headers: responseHeaders,
      });
    }

    // Binary content: stream as-is
    return new Response(odooResp.body, {
      status: odooResp.status,
      headers: responseHeaders,
    });
  } catch (err) {
    console.error("[odoo-proxy] fetch error:", err);
    return new Response(
      `<html><body><h2>Odoo connection error</h2><p>${err.message}</p><p>Odoo URL: ${odooUrl}</p></body></html>`,
      { status: 502, headers: { "Content-Type": "text/html" } }
    );
  }
};

// POST proxy (for Odoo form submissions, JSON-RPC calls)
export const action = async ({ request }) => {
  const url = new URL(request.url);
  const odooPath = url.searchParams.get("path") || "/web/dataset/call_kw";
  url.searchParams.delete("path");
  const remainingParams = url.searchParams.toString();
  const odooUrl = `${ODOO_BASE_URL}${odooPath}${remainingParams ? `?${remainingParams}` : ""}`;

  try {
    const body = await request.arrayBuffer();
    const odooResp = await fetch(odooUrl, {
      method: "POST",
      headers: forwardHeaders(request),
      body,
      redirect: "manual",
    });

    const contentType = odooResp.headers.get("content-type") || "";
    const responseHeaders = new Headers();

    for (const [key, value] of odooResp.headers.entries()) {
      if (!HOP_BY_HOP.has(key.toLowerCase())) {
        if (key.toLowerCase() === "set-cookie") {
          let cookie = value;
          if (!cookie.includes("SameSite=")) cookie += "; SameSite=None";
          else cookie = cookie.replace(/SameSite=\w+/i, "SameSite=None");
          if (!cookie.includes("Secure")) cookie += "; Secure";
          responseHeaders.append("Set-Cookie", cookie);
        } else if (key.toLowerCase() !== "content-security-policy" &&
          key.toLowerCase() !== "x-frame-options") {
          responseHeaders.set(key, value);
        }
      }
    }

    responseHeaders.set("X-Frame-Options", "ALLOWALL");
    responseHeaders.set("Content-Security-Policy", "frame-ancestors *");

    if (
      contentType.includes("text/html") ||
      contentType.includes("application/javascript") ||
      contentType.includes("text/javascript") ||
      contentType.includes("text/css")
    ) {
      const text = await odooResp.text();
      const rewritten = rewriteBody(text, ODOO_BASE_URL, "/api/odoo-proxy?path=");
      return new Response(rewritten, { status: odooResp.status, headers: responseHeaders });
    }

    return new Response(odooResp.body, { status: odooResp.status, headers: responseHeaders });
  } catch (err) {
    console.error("[odoo-proxy] POST error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
};
