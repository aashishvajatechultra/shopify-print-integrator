const PRODUCTS_QUERY = `#graphql
  query SyncProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          title
          status
          handle
          productType
          featuredImage {
            url
          }
          variants(first: 50) {
            edges {
              node {
                id
                price
              }
            }
          }
        }
      }
    }
  }
`;

function gidToId(gid) {
  if (!gid) return "";
  const parts = String(gid).split("/");
  return parts[parts.length - 1] || gid;
}

function mapNode(node) {
  const firstVariant = node.variants?.edges?.[0]?.node;
  const priceLabel = firstVariant?.price ? `$${firstVariant.price}` : "";
  const variantIds = (node.variants?.edges || []).map((e) => gidToId(e.node?.id));

  return {
    shopify_product_id: gidToId(node.id),
    title: node.title,
    status: node.status,
    handle: node.handle,
    product_type: node.productType || "",
    category: node.productType || "Uncategorized",
    image: node.featuredImage?.url || "",
    price: priceLabel,
    variant_ids: variantIds,
  };
}


const SHOPIFY_API_VERSION = "2024-10";

export async function fetchAllShopifyProducts(session, pageSize = 50) {
  const { shop, accessToken } = session;

  console.log("\n=== DIRECT FETCH DEBUG ===");
  console.log("Shop:", shop);
  console.log("Token prefix:", accessToken ? accessToken.substring(0, 15) : "MISSING");
  console.log("API Version:", SHOPIFY_API_VERSION);
  console.log("==========================\n");

  const products = [];
  let after = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await fetch(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query: PRODUCTS_QUERY.replace("#graphql", "").trim(),
          variables: { first: pageSize, after },
        }),
      },
    );

    console.log("Response status:", response.status);

    if (!response.ok) {
      const text = await response.text();
      console.error("Error body:", text);
      throw new Error(
        `Shopify API error (${response.status}): ${text.slice(0, 300)}`,
      );
    }

    const json = await response.json();

    if (json.errors?.length) {
      console.error("GraphQL errors:", JSON.stringify(json.errors, null, 2));
      throw new Error(json.errors.map((e) => e.message).join("; "));
    }

    const connection = json?.data?.products;
    if (!connection) {
      throw new Error("Failed to fetch Shopify products.");
    }

    for (const edge of connection.edges || []) {
      if (edge?.node) products.push(mapNode(edge.node));
    }

    hasNextPage = connection.pageInfo?.hasNextPage;
    after = connection.pageInfo?.endCursor || null;
  }

  console.log("Total products fetched:", products.length);
  return products;
}




export async function callOdooJson(odooBaseUrl, path, token, payload) {
  const response = await fetch(`${odooBaseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ngrok-skip-browser-warning": "true",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      params: { token, ...payload },
    }),
  });

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    return {
      success: false,
      error: `Odoo returned non-JSON (${response.status}). Check Odoo URL and module upgrade.`,
    };
  }

  if (data.error) {
    return {
      success: false,
      error:
        data.error.message ||
        data.error.data?.message ||
        "Odoo API error.",
    };
  }

  return data.result || {
    success: false,
    error: "Invalid Odoo response.",
  };
}

export async function registerCartHelperScriptTag(session, shopifyAppUrl) {
  const { shop, accessToken } = session;
  const scriptUrl = `${shopifyAppUrl.replace(/\/$/, "")}/cart-helper.js`;

  try {
    // 1. Fetch existing ScriptTags
    const getResponse = await fetch(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/script_tags.json`,
      {
        method: "GET",
        headers: {
          "X-Shopify-Access-Token": accessToken,
        },
      }
    );

    if (getResponse.ok) {
      const getJson = await getResponse.json();
      const scriptTags = getJson.script_tags || [];

      // Delete any old/outdated ScriptTags for cart-helper.js
      for (const tag of scriptTags) {
        if (tag.src && tag.src.includes("cart-helper.js") && tag.src !== scriptUrl) {
          console.log("=== Deleting old/outdated ScriptTag:", tag.src, "===");
          try {
            await fetch(
              `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/script_tags/${tag.id}.json`,
              {
                method: "DELETE",
                headers: {
                  "X-Shopify-Access-Token": accessToken,
                },
              }
            );
          } catch (delErr) {
            console.error("Failed to delete ScriptTag:", tag.id, delErr);
          }
        }
      }

      const alreadyRegistered = scriptTags.some(tag => tag.src === scriptUrl);

      if (alreadyRegistered) {
        console.log("=== Cart Helper ScriptTag is already registered ===");
        return;
      }
    }

    // 2. Register new ScriptTag
    console.log("=== Registering Cart Helper ScriptTag ===");
    const registerResponse = await fetch(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/script_tags.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          script_tag: {
            event: "onload",
            src: scriptUrl,
          },
        }),
      }
    );

    if (registerResponse.ok) {
      console.log("=== Cart Helper ScriptTag registered successfully ===");
    } else {
      const errText = await registerResponse.text();
      console.error("Failed to register ScriptTag:", errText);
    }
  } catch (err) {
    console.error("Error in registerCartHelperScriptTag:", err);
  }
}