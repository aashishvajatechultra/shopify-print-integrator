# Shopify Product Designer App

A Shopify app that adds a **"Customize This Product"** button to product pages. Clicking it redirects the customer to your Odoo Product Designer where they can personalize the product, save their design, and return to the Shopify cart.

## How It Works

```
Customer on Shopify → Clicks "Customize" → Odoo Designer → Saves Design → Back to Shopify Cart
```

## Tech Stack

- **Framework**: Remix + Shopify App Remix library
- **UI**: Shopify Polaris
- **Database**: SQLite (dev) / Postgres (production) via Prisma
- **Theme Integration**: Shopify Theme App Extension (Liquid blocks)

## Setup & Development

### 1. Prerequisites
- Node.js 18+
- [Shopify CLI](https://shopify.dev/docs/apps/tools/cli) (`npm install -g @shopify/cli`)
- A [Shopify Partner account](https://partners.shopify.com) (FREE)

### 2. Create your Shopify App on Partner Dashboard
1. Go to https://partners.shopify.com
2. Apps → Create App → Create app manually
3. Copy the **Client ID** and **Client Secret**

### 3. Install dependencies
```bash
cd shopify_product_designer_app
npm install
```

### 4. Configure environment
```bash
cp .env.example .env
# Edit .env with your Shopify app credentials
```

### 5. Run locally
```bash
npm run dev
```

## Deployment (Free Options)

| Platform | Free Tier | Notes |
|----------|-----------|-------|
| [Railway](https://railway.app) | $5 credit/month | Easiest setup |
| [Fly.io](https://fly.io) | 3 shared VMs free | Good performance |
| [Render](https://render.com) | 1 free web service | May sleep after 15min |

## Publishing to Shopify App Store

1. Deploy to production
2. Update `SHOPIFY_APP_URL` to your production URL
3. In Shopify Partner Dashboard → Apps → your app → Distribution → App Store
4. Fill in app listing details, screenshots, etc.
5. Submit for review (Shopify reviews within 5-7 days)

## Theme Extension

The app installs a **Theme App Extension** — a Liquid block that merchants can add to any section of their product page using the theme editor. No theme code changes needed!

The block has these settings (configurable per-product or globally):
- **Odoo Base URL** — your Odoo instance URL
- **Button Text** — customize the label
- **Button Style** — primary or secondary

## Redirect URL Format

```
https://your-odoo.com/designer/shopify/{product_id}
  ?shop={shop.permanent_domain}
  &variant_id={selected_variant_id}
  &return_url={cart_url}
  &customer_id={customer_id}
```
