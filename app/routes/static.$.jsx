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
