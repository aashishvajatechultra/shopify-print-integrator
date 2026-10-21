# Security notes — Print Integrator Remix app

## Secrets must never live in source

| Variable | Where to set | Notes |
|----------|--------------|--------|
| `SHOPIFY_API_KEY` | Railway / host env | Public client id (also in `shopify.app.toml`) |
| `SHOPIFY_API_SECRET` | Railway / host env **only** | Never commit. Rotate if ever leaked. |
| `ODOO_BASE_URL` | Railway / host env | No hardcoded production hosts in code |
| `ODOO_ADMIN_*` | Railway / host env | Optional XML-RPC fallback; leave empty if unused |
| `ODOO_PROVISION_SECRET` | Railway / host env | Optional shared secret with Odoo |

`.env` is gitignored. Use `.env.example` as a template with placeholders only.

## Known historical leak (action required)

Git history once contained a hardcoded `SHOPIFY_API_SECRET` fallback in `webhooks.jsx`
(removed in commit `ef9fd6f`). **Rotate the Client secret in Shopify Partner Dashboard**
and update Railway env before App Store submission. Old secret values in git history
must be treated as compromised.

## App Store readiness checklist

- [x] `AppDistribution.AppStore` + `unstable_newEmbeddedAuthStrategy` (session tokens)
- [x] GDPR compliance webhooks subscribed (`customers/data_request`, `customers/redact`, `shop/redact`)
- [x] HMAC verification on `/webhooks`
- [x] No `SHOPIFY_API_SECRET` hardcoded in current tree
- [x] No default `admin`/`admin` Odoo credentials in code
- [x] Odoo JWT not returned in parent `app.jsx` loader JSON
- [ ] Partner Dashboard: privacy policy URL + app listing screenshots
- [ ] Railway: confirm all env vars set (no missing `SHOPIFY_*` / `ODOO_BASE_URL`)
- [ ] Rotate API secret if this repo was ever shared/public
