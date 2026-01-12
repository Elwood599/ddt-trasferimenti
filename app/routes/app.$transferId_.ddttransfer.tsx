import { useCallback } from "react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, json } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Badge,
  Banner,
  BlockStack,
} from "@shopify/polaris";
import { PrintIcon } from "@shopify/polaris-icons";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { Liquid } from "liquidjs";
import fs from "fs";
import path from "path";

/* ----------------------------------------------------------
   LOADER
---------------------------------------------------------- */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const transferId = params.transferId;

  if (!transferId) {
    throw new Response("Transfer ID missing", { status: 400 });
  }

  const transferGid = `gid://shopify/InventoryTransfer/${transferId}`;

  try {
    /* ----------------------------------------------------------
       1. Fetch transfer with pagination
    ---------------------------------------------------------- */

    let hasNextPage = true;
    let cursor: string | null = null;
    let transfer: any = null;
    const allLineItems: any[] = [];

    const transferQuery = `
      query GetInventoryTransfer($id: ID!, $after: String) {
        inventoryTransfer(id: $id) {
          id
          name
          referenceName
          dateCreated
          status
          origin {
            name
            address {
              address1
              address2
              city
              zip
              province
              country
            }
            location {
              metafield (namespace: "location", key: "partita_iva") {
                value
              }
            }
          }
          destination {
            name
            address {
              address1
              address2
              city
              zip
              province
              country
            }
          }
          lineItems(first: 100, after: $after) {
            edges {
              cursor
              node {
                id
                totalQuantity
                inventoryItem {
                  id
                  sku
                  variant {
                    title
                    product {
                      title
                    }
                  }
                }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }`;

    while (hasNextPage) {
      const response: Response = await admin.graphql(transferQuery, {
        variables: { id: transferGid, after: cursor },
      });
      const result = await response.json();

      if (!result.data?.inventoryTransfer) {
        throw new Response("inventoryTransfer not found", { status: 404 });
      }

      if (!transfer) transfer = result.data.inventoryTransfer;

      const lineItemsPage = result.data.inventoryTransfer.lineItems;

      // Push items
      for (const edge of lineItemsPage.edges) {
        allLineItems.push(edge.node);
      }

      hasNextPage = lineItemsPage.pageInfo.hasNextPage;
      cursor = lineItemsPage.pageInfo.endCursor;
    }

    /* ----------------------------------------------------------
       2. Render Liquid template
    ---------------------------------------------------------- */
    const engine = new Liquid();
    const templatePath = path.join(process.cwd(), "template-ddt.liquid");
    const templateContent = fs.readFileSync(templatePath, "utf8");

    engine.registerFilter("format_address", (address: any) => {
      if (!address) return "";
      const parts = [
        address.address1,
        address.address2,
        `${address.zip || ""} ${address.city || ""}`.trim(),
        address.province,
        address.country,
      ].filter(Boolean);
      return parts.join(", ");
    });

    engine.registerFilter("date", (value: string, format: string) => {
      const date = new Date(value);
      if (format.includes("%d/%m/%Y")) {
        const day = String(date.getDate()).padStart(2, "0");
        const month = String(date.getMonth() + 1).padStart(2, "0");
        const year = date.getFullYear();
        return `${day}/${month}/${year}`;
      }
      return date.toLocaleDateString("it-IT");
    });

    const renderedHtml = await engine.parseAndRender(templateContent, {
      transfer,
      origin: transfer.origin,
      destination: transfer.destination,
      items: allLineItems,
    });

    return json({ renderedHtml });

  } catch (error) {
    console.error("[DDT ERROR]", error);
    throw new Response("Failed to generate DDT", { status: 500 });
  }
};


/* ----------------------------------------------------------
   COMPONENT
---------------------------------------------------------- */
export default function ProformaInvoicePage() {
  const { renderedHtml } = useLoaderData<typeof loader>();

  const handlePrint = useCallback(() => {
    window.print();
  }, []);

  return (
    <>
      <style>{`
        .transfer-page-container {
          background: #f6f6f7;
          min-height: 100vh;
          padding: 24px;
        }

        .transfer-wrapper {
          width: 210mm;
          margin: 0 auto;
          background: white;
          box-shadow: 0 1px 3px rgba(0,0,0,0.1);
          border-radius: 8px;
        }

        @media print {
          body {
            background: white;
          }
          .transfer-page-container {
            padding: 0;
            background: white;
          }
          .transfer-wrapper {
            box-shadow: none;
            border-radius: 0;
            padding: 0;
            max-width: 100%;
          }
          .Polaris-Page-Header,
          .Polaris-Navigation,
          .Polaris-Box,
          [data-polaris-layer],
          nav, header {
            display: none !important;
          }
        }
      `}</style>

      <Page
        backAction={{ content: "Back", url: "/app" }}
        primaryAction={{
          content: "Stampa",
          icon: PrintIcon,
          onAction: handlePrint,
        }}
      >
        <Layout>
          <Layout.Section>
            <div className="transfer-page-container">
              <div className="transfer-wrapper">
                <div
                  dangerouslySetInnerHTML={{ __html: renderedHtml }}
                />
              </div>
            </div>
          </Layout.Section>
        </Layout>
      </Page>
    </>
  );
}
