// app/routes/odoo-frame.$.jsx
// Catch-all HTTPS proxy: /odoo-frame/* → Odoo HTTP server
// Fixes Mixed Content: all Odoo traffic goes Node.js server-side.

const ODOO_ORIGIN = (process.env.ODOO_BASE_URL || "http://161.97.133.248:8099").replace(/\/$/, "");
const PROXY_PREFIX = "/odoo-frame";

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "transfer-encoding", "te",
  "trailer", "upgrade", "proxy-authorization", "proxy-authenticate",
  "content-length",
]);

// All Odoo path prefixes that need proxying
const ODOO_PREFIXES = [
  "/web", "/shopify", "/api", "/mail", "/longpolling",
  "/bus", "/website", "/print_integrator", "/print_integrator_website",
  "/shop", "/odoo", "/discuss", "/product", "/static",
  "/roseglass_backend", "/tus_product_personalizer", "/shopify_product_designer",
  "/shopify_product_designer_cart_extend", "/base", "/mail",
];

const ODOO_PATHS_JSON = JSON.stringify(ODOO_PREFIXES);
// Regex alternation for HTML rewriting
const PATH_ALT = "web|shopify|api|mail|bus|longpolling|website|print_integrator|print_integrator_website|shop|odoo|discuss|product|static|roseglass_backend|tus_product_personalizer|shopify_product_designer|shopify_product_designer_cart_extend|base";

// JS injected into HTML — patches fetch/XHR/forms/anchor clicks
const JS_PATCH = `<script id="__odoo_proxy_patch__">
(function(){
  if(window.__odooProxyPatched) return;
  window.__odooProxyPatched = true;
  var PFX="${PROXY_PREFIX}";
  var PATHS=${ODOO_PATHS_JSON};
  function needs(url){
    if(!url||typeof url!=="string") return false;
    if(url.startsWith("http://")||url.startsWith("https://")||
       url.startsWith("blob:")||url.startsWith("data:")||
       url.startsWith(PFX)) return false;
    // Known Odoo path prefixes
    if(PATHS.some(function(p){
      return url===p||url.startsWith(p+"/")||url.startsWith(p+"?");
    })) return true;
    // General fallback: any Odoo module's static or views files
    // Matches /module_name/static/... or /module_name/views/... patterns
    if(/^\/[a-z][a-z0-9_]+\/(?:static|views|controllers|models)\//.test(url)) return true;
    return false;
  }
  function rw(url){ return needs(url)?PFX+url:url; }

  // Patch fetch
  var oF=window.fetch;
  window.fetch=function(inp,init){
    if(typeof inp==="string"){
      inp=rw(inp);
    } else if(inp&&inp.url){
      // Request.url is always absolute — extract pathname to check needs()
      try{
        var ru=new URL(inp.url);
        if(ru.origin===window.location.origin){
          var rrel=ru.pathname+(ru.search||"");
          if(needs(rrel)) inp=new Request(window.location.origin+PFX+rrel,inp);
        }
      }catch(rex){}
    }
    return oF.call(this,inp,init);
  };

  // Patch XHR
  var oO=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(){
    var a=Array.prototype.slice.call(arguments);
    if(typeof a[1]==="string"){
      // Handle both relative paths and absolute same-origin URLs
      try{
        var xu=new URL(a[1]);
        if(xu.origin===window.location.origin){
          var xrel=xu.pathname+(xu.search||"");
          if(needs(xrel)) a[1]=window.location.origin+PFX+xrel;
        }
      }catch(xex){
        // Relative URL — use normal rw()
        a[1]=rw(a[1]);
      }
    }
    return oO.apply(this,a);
  };

  // Intercept form submissions (native, not caught by fetch/XHR)
  document.addEventListener("submit",function(e){
    var f=e.target;
    if(!f||!f.action) return;
    try{
      var u=new URL(f.action);
      if(u.origin===window.location.origin&&needs(u.pathname)){
        f.action=window.location.origin+PFX+u.pathname+u.search;
      }
    }catch(ex){}
  },true);

  // Intercept anchor clicks with absolute paths
  document.addEventListener("click",function(e){
    var a=e.target.closest("a[href]");
    if(!a) return;
    var href=a.getAttribute("href");
    if(href&&needs(href)){
      e.preventDefault();
      window.location.href=PFX+href;
    }
  },true);
})();
</script>`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildUpstreamHeaders(req, origin) {
  const h = new Headers();
  for (const [k, v] of req.headers.entries()) {
    const kl = k.toLowerCase();
    if (HOP_BY_HOP.has(kl) || kl === "host") continue;
    if (kl === "origin") { h.set("Origin", origin); continue; }
    if (kl === "referer") {
      try {
        let p = new URL(v).pathname;
        if (p.startsWith(PROXY_PREFIX)) {
          p = p.slice(PROXY_PREFIX.length) || "/";
        }
        h.set("Referer", origin + p + new URL(v).search);
      } catch { }
      continue;
    }
    h.set(k, v);
  }
  h.set("X-Forwarded-Proto", "https");
  h.set("X-Forwarded-Host", new URL(req.url).host);
  return h;
}

function fixCookie(v) {
  let c = v.replace(/;\s*Domain=[^;]+/gi, "");
  c = c.replace(/;\s*SameSite=\w+/gi, "");
  c += "; SameSite=None; Secure";
  if (!c.includes("Path=")) c += "; Path=/";
  return c;
}

function buildRespHeaders(odooHeaders) {
  const out = new Headers();
  for (const [k, v] of odooHeaders.entries()) {
    const kl = k.toLowerCase();
    if (HOP_BY_HOP.has(kl)) continue;
    if (["x-frame-options", "content-security-policy",
      "content-security-policy-report-only", "set-cookie"].includes(kl)) continue;
    out.set(k, v);
  }

  // Properly handle multiple Set-Cookie headers without comma-merging corruption
  if (typeof odooHeaders.getSetCookie === "function") {
    for (const cookie of odooHeaders.getSetCookie()) {
      out.append("Set-Cookie", fixCookie(cookie));
    }
  } else {
    const rawCookie = odooHeaders.get("set-cookie");
    if (rawCookie) {
      out.append("Set-Cookie", fixCookie(rawCookie));
    }
  }

  out.set("X-Frame-Options", "ALLOWALL");
  out.set("Content-Security-Policy",
    "frame-ancestors *; default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;");
  return out;
}

function rewriteLoc(loc, origin, pfx) {
  if (!loc) return "/";
  if (loc.startsWith(origin)) return pfx + (loc.slice(origin.length) || "/");
  if (loc.startsWith("/") && !loc.startsWith(pfx)) return pfx + loc;
  return loc;
}

// ─── Content rewriting ────────────────────────────────────────────────────────

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function rewriteHtml(html, pfx, origin) {
  let out = html;

  // 1. Replace full origin URLs
  out = out.replace(new RegExp(escapeRe(origin), "g"), pfx);

  // 2. Rewrite HTML attribute absolute paths (double-quoted)
  const dqRe = new RegExp(
    `((?:href|src|action|data-url|data-src|data-href|poster)\\s*=\\s*")(/(${PATH_ALT})[^"]*)(")`, "gi"
  );
  out = out.replace(dqRe, (_m, attr, path, _g, close) => attr + pfx + path + close);

  // 3. Single-quoted attributes
  const sqRe = new RegExp(
    `((?:href|src|action|data-url|data-src|data-href|poster)\\s*=\\s*')(/(${PATH_ALT})[^']*)(')`, "gi"
  );
  out = out.replace(sqRe, (_m, attr, path, _g, close) => attr + pfx + path + close);

  // 4. url() in inline styles
  const urlRe = new RegExp(
    `url\\((['"]{0,1})(/(${PATH_ALT})[^'"()\\s]+)\\1\\)`, "g"
  );
  out = out.replace(urlRe, (_m, q, path) => `url(${q}${pfx}${path}${q})`);

  // 5. Inject JS patch using function replacer (avoids $1 misinterpretation)
  out = out.replace(/(<head[^>]*>)/i, (m) => m + "\n" + JS_PATCH);

  return out;
}

function rewriteCss(css, pfx, origin) {
  let out = css.replace(new RegExp(escapeRe(origin), "g"), pfx);
  const urlRe = new RegExp(
    `url\\((['"]{0,1})(/(${PATH_ALT})[^'"()\\s]+)\\1\\)`, "g"
  );
  out = out.replace(urlRe, (_m, q, path) => `url(${q}${pfx}${path}${q})`);
  return out;
}

// DO NOT rewrite JS — minified JS regex rewriting causes syntax errors.
// Runtime fetch/XHR patch + form/anchor interceptors handle everything.
const passthroughJs = (js) => js;

// ─── Core proxy ───────────────────────────────────────────────────────────────

export async function handleProxy(request, splatPath) {
  const inUrl = new URL(request.url);
  const odooUrl = ODOO_ORIGIN + "/" + splatPath + inUrl.search;

  console.log(`[Odoo Proxy] ${request.method} ${inUrl.pathname} -> Upstream: ${odooUrl}`);

  let resp;
  try {
    const body = /^(GET|HEAD)$/.test(request.method) ? undefined : await request.arrayBuffer();
    resp = await fetch(odooUrl, {
      method: request.method,
      headers: buildUpstreamHeaders(request, ODOO_ORIGIN),
      body,
      redirect: "manual",
    });
    console.log(`[Odoo Proxy] Response from upstream ${odooUrl}: ${resp.status}`);
  } catch (err) {
    console.error(`[Odoo Proxy] Fetch error for ${odooUrl}:`, err);
    const html = `<!DOCTYPE html><html><head><title>Odoo Unreachable</title>
<style>body{font-family:system-ui;background:#0f172a;color:#e2e8f0;padding:40px;text-align:center}
h2{color:#f87171}code{background:#1e293b;padding:4px 8px;border-radius:4px;font-size:13px}</style></head>
<body><h2>Cannot reach Odoo server</h2>
<p>Target: <code>${odooUrl}</code></p>
<p style="color:#64748b;font-size:13px">${err.message}</p>
<button onclick="location.reload()" style="margin-top:20px;padding:10px 24px;background:#6366f1;color:#fff;border:none;border-radius:8px;cursor:pointer">Retry</button>
</body></html>`;
    return new Response(html, { status: 502, headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  // Redirects
  if (resp.status >= 300 && resp.status < 400) {
    const loc = resp.headers.get("location") || "/";
    const headers = buildRespHeaders(resp.headers);
    headers.set("Location", rewriteLoc(loc, ODOO_ORIGIN, PROXY_PREFIX));
    return new Response(null, { status: resp.status, headers });
  }

  const ct = (resp.headers.get("content-type") || "").toLowerCase();
  const headers = buildRespHeaders(resp.headers);
  headers.delete("Content-Length");

  if (ct.includes("text/html")) {
    headers.set("Content-Type", "text/html; charset=utf-8");
    return new Response(rewriteHtml(await resp.text(), PROXY_PREFIX, ODOO_ORIGIN), { status: resp.status, headers });
  }
  if (ct.includes("text/css")) {
    return new Response(rewriteCss(await resp.text(), PROXY_PREFIX, ODOO_ORIGIN), { status: resp.status, headers });
  }
  if (ct.includes("javascript")) {
    return new Response(passthroughJs(await resp.text()), { status: resp.status, headers });
  }

  // Binary: images, fonts, json — stream as-is
  return new Response(resp.body, { status: resp.status, headers });
}

// ─── Remix exports ────────────────────────────────────────────────────────────
export const loader = async ({ request, params }) => handleProxy(request, params["*"] || "");
export const action = async ({ request, params }) => handleProxy(request, params["*"] || "");
