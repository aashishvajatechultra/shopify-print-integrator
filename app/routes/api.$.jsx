// app/routes/api.$.jsx
// Catch-all route for `/api/*` requests.
// Forwards any uncaught `/api` calls directly to Odoo proxy handler.

import { handleProxy } from "./odoo-frame.$.jsx";

export const loader = async ({ request, params }) => {
  return handleProxy(request, "api/" + (params["*"] || ""));
};

export const action = async ({ request, params }) => {
  return handleProxy(request, "api/" + (params["*"] || ""));
};
