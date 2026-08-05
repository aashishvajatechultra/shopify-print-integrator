import { useState } from "react";
import { json } from "@remix-run/node";
import { Form, useActionData } from "@remix-run/react";
import { AppProvider, Button, Card, FormLayout, Page, Text, TextField } from "@shopify/polaris";
import enTranslations from "@shopify/polaris/locales/en.json";
import { login } from "../shopify.server.js";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");

  if (shop) {
    return login(request);
  }

  return json({ showForm: true });
};

export const action = async ({ request }) => {
  const errors = {};
  // Clone request before reading body so login() can also read it
  const cloned = request.clone();
  const formData = await cloned.formData();
  const shop = formData.get("shop");

  if (!shop) {
    errors.shop = "Shop is required";
  }

  if (Object.keys(errors).length > 0) {
    return json({ errors }, { status: 400 });
  }

  return login(request);
};

export default function Login() {
  const actionData = useActionData();
  const [shop, setShop] = useState("");

  return (
    <AppProvider i18n={enTranslations}>
      <Page>
        <Card>
          <Form method="post">
            <FormLayout>
              <Text as="h2" variant="headingMd">
                Log in
              </Text>
              <TextField
                type="text"
                name="shop"
                label="Shop domain"
                value={shop}
                onChange={setShop}
                autoComplete="on"
                error={actionData?.errors?.shop}
              />
              <Button submit variant="primary">
                Log in
              </Button>
            </FormLayout>
          </Form>
        </Card>
      </Page>
    </AppProvider>
  );
}
