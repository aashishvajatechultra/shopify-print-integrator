/**
 * Shared Odoo env helpers — never hardcode hosts or credentials in source.
 */

/**
 * @returns {string} Absolute Odoo base URL without trailing slash, or "".
 */
export function getOdooBaseUrl() {
  const raw = (process.env.ODOO_BASE_URL || "").trim();
  return raw.replace(/\/$/, "");
}

/**
 * Credentials for optional XML-RPC fallback.
 * Returns null when unset so callers can skip instead of using weak defaults.
 */
export function getOdooXmlRpcAuth() {
  const db = (process.env.ODOO_DB || "").trim();
  const user = (process.env.ODOO_ADMIN_USER || "").trim();
  const pass = (process.env.ODOO_ADMIN_PASS || "").trim();
  if (!db || !user || !pass) return null;
  return { db, user, pass };
}
