// websocket.$.jsx — proxy Odoo WebSocket/longpolling requests
// Odoo 17+ uses /websocket for its bus/longpolling endpoint.
// Without this route Remix returns 404 and Odoo loses real-time updates.

import { handleProxy } from "./odoo-frame.$.jsx";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\//, "");
  return handleProxy(request, path);
};

export const action = async ({ request }) => {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\//, "");
  return handleProxy(request, path);
};
