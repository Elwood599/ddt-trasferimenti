import {
  Card,
  Badge,
  Button,
  IndexFilters,
  IndexTable,
  Text,
  TabProps,
  IndexFiltersProps,
  useIndexResourceState,
  useSetIndexFiltersMode,
} from "@shopify/polaris";
import { ViewIcon, PrintIcon } from "@shopify/polaris-icons";
import { useFetcher, useLoaderData, useLocation, useNavigate } from "@remix-run/react";
import { authenticate } from "app/shopify.server";
import { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useCallback, useEffect, useState } from "react";
import { createApp } from "@shopify/app-bridge";
import { Redirect } from "@shopify/app-bridge/actions";

/* ===========================
   LOADER
=========================== */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  return {
    shop: session.shop,
    apiKey: process.env.SHOPIFY_API_KEY || "",
  };
};

/* ===========================
   ACTION → InventoryTransfers
=========================== */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const first = 15;
  const form = await request.formData();
  const after = form.get("after")?.toString() || null;

  const query = `query InventoryTransfers($first: Int!, $after: String) {
    inventoryTransfers(first: $first, after: $after, sortKey: ID) {
      edges {
        cursor
        node {
          id
          name
          referenceName
          status
          totalQuantity
          receivedQuantity
          origin { name }
          destination { name }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }`;

  const response = await admin.graphql(query, {
    variables: { first, after },
  });
 
  const json = await response.json();
  
  const inventoryTransfers = json.data.inventoryTransfers.edges.map(
    (edge: any) => edge.node
  );

  const pageInfo = json.data.inventoryTransfers.pageInfo;

  return { inventoryTransfers, pageInfo };
};

/* ===========================
   FRONTEND COMPONENT
=========================== */
export default function Index() {
  const { shop, apiKey } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();

  const [transfers, setTransfers] = useState<any[]>([]);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [endCursor, setEndCursor] = useState<string | null>(null);

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const getHost = () => {
    const urlHost = new URLSearchParams(window.location.search).get("host");
    if (urlHost) {
      sessionStorage.setItem("shopify_host", urlHost);
      return urlHost;
    }
    return sessionStorage.getItem("shopify_host") || "";
  };

  /* ------------------ Tabs ------------------ */
  const [itemStrings, setItemStrings] = useState(["All", "Received", "Not received"]);

  const deleteView = (index: number) => {
    const newItemStrings = [...itemStrings];
    newItemStrings.splice(index, 1);
    setItemStrings(newItemStrings);
    setSelected(0);
  };

  const duplicateView = async (name: string) => {
    setItemStrings([...itemStrings, name]);
    setSelected(itemStrings.length);
    await sleep(1);
    return true;
  };

  const tabs: TabProps[] = itemStrings.map((item, index) => ({
    content: item,
    index,
    onAction: () => {},
    id: `${item}-${index}`,
    isLocked: index === 0,
    actions:
      index === 0
        ? []
        : [
            {
              type: "rename",
              onAction: () => {},
              onPrimaryAction: async (value: string): Promise<boolean> => {
                const newItems = tabs.map((it, idx) =>
                  idx === index ? value : it.content
                );
                setItemStrings(newItems);
                await sleep(1);
                return true;
              },
            },
            {
              type: "duplicate",
              onPrimaryAction: async (value: string): Promise<boolean> => {
                duplicateView(value);
                return true;
              },
            },
            { type: "edit" },
            {
              type: "delete",
              onPrimaryAction: async () => {
                deleteView(index);
                return true;
              },
            },
          ],
  }));

  const [selected, setSelected] = useState(0);
  const onCreateNewView = async (value: string) => {
    setItemStrings([...itemStrings, value]);
    setSelected(itemStrings.length);
    return true;
  };

  /* ------------------ Index Filters ------------------ */
  const sortOptions: IndexFiltersProps["sortOptions"] = [
    { label: "Quantity", value: "qty asc", directionLabel: "Ascending" },
    { label: "Quantity", value: "qty desc", directionLabel: "Descending" },
    { label: "Status", value: "status asc", directionLabel: "A-Z" },
    { label: "Status", value: "status desc", directionLabel: "Z-A" },
  ];

  const [sortSelected, setSortSelected] = useState(["qty asc"]);
  const { mode, setMode } = useSetIndexFiltersMode();

  const [queryValue, setQueryValue] = useState("");
  const handleFiltersQueryChange = useCallback((value: string) => setQueryValue(value), []);

  const appliedFilters: IndexFiltersProps["appliedFilters"] = [];

  const resourceName = { singular: "transfer", plural: "transfers" };

  const { selectedResources, allResourcesSelected, handleSelectionChange } =
    useIndexResourceState(transfers);

  /* ------------------ Fetch initial transfers ------------------ */
  useEffect(() => {
    fetcher.submit({}, { method: "post" });
  }, []);

  /* ------------------ Process data ------------------ */
  useEffect(() => {
    if (fetcher.data?.inventoryTransfers) {
      const raw = fetcher.data.inventoryTransfers;

      if (fetcher.data.pageInfo) {
        setHasNextPage(fetcher.data.pageInfo.hasNextPage);
        setEndCursor(fetcher.data.pageInfo.endCursor);
      }

      /* ----- Filtering by tabs ----- */
      const filteredByTab = raw.filter((t: any) => {
        if (itemStrings[selected] === "Received") return t.receivedQuantity >= t.totalQuantity;
        if (itemStrings[selected] === "Not received") return t.receivedQuantity < t.totalQuantity;
        return true;
      });

      /* ----- Filtering by search ----- */
      const filteredByQuery = filteredByTab.filter((t: any) => {
        if (!queryValue) return true;
        const term = queryValue.toLowerCase();
        return (
          t.referenceName?.toLowerCase().includes(term) ||
          t.origin?.name?.toLowerCase().includes(term) ||
          t.destination?.name?.toLowerCase().includes(term)
        );
      });

      /* ----- Sorting ----- */
      const sorted = [...filteredByQuery].sort((a, b) => {
        const [field, dir] = sortSelected[0].split(" ");

        let aVal = 0,
          bVal = 0;

        if (field === "qty") {
          aVal = a.totalQuantity;
          bVal = b.totalQuantity;
        }
        if (field === "status") {
          aVal = a.status;
          bVal = b.status;
        }

        if (aVal < bVal) return dir === "asc" ? -1 : 1;
        if (aVal > bVal) return dir === "asc" ? 1 : -1;
        return 0;
      });

      /* ----- Convert to rows for IndexTable ----- */
        const parsed = sorted.map((t: any) => {
        
          const transferId = t.id.split("/").pop()!;

          return {
            name: (
              <Text variant="bodyMd" fontWeight="semibold">
                {t.name}
              </Text>
            ),
            origin: t.origin?.name || "-",
            destination: t.destination?.name || "-",
            status: <Badge>{t.status}</Badge>,
            total: t.totalQuantity,
            received: t.receivedQuantity,
            printTransfer: (
              <Button
                icon={PrintIcon}
                onClick={() => {
                  const host = getHost();
                  const params = new URLSearchParams();
                  if (host) params.set("host", host);

                  navigate(`/app/${transferId}/ddttransfer?${params.toString()}`);
                }}
              >
                Print DDT
              </Button>
            ),
          };
        });

      setTransfers(parsed);
    }
  }, [fetcher, selected, queryValue, sortSelected]);

  /* ------------------ Row markup ------------------ */
  const rowMarkup = transfers.map((t: any, idx: number) => (
    <IndexTable.Row key={idx} id={String(idx)} position={idx}>
      <IndexTable.Cell>{t.name}</IndexTable.Cell>
      <IndexTable.Cell>{t.origin}</IndexTable.Cell>
      <IndexTable.Cell>{t.destination}</IndexTable.Cell>
      <IndexTable.Cell>{t.status}</IndexTable.Cell>
      <IndexTable.Cell>{t.total}</IndexTable.Cell>
      <IndexTable.Cell>{t.received}</IndexTable.Cell>
      <IndexTable.Cell>{t.printTransfer}</IndexTable.Cell>
    </IndexTable.Row>
  ));

  /* ===========================
     RENDER
  =========================== */
  return (
    <Card>
      <IndexFilters
        sortOptions={sortOptions}
        sortSelected={sortSelected}
        queryValue={queryValue}
        queryPlaceholder="Search transfers"
        onQueryChange={handleFiltersQueryChange}
        onQueryClear={() => setQueryValue("")}
        onSort={setSortSelected}
        primaryAction={{
          type: "save-as",
          onAction: onCreateNewView,
        }}
        cancelAction={{ onAction: () => {} }}
        tabs={tabs}
        selected={selected}
        onSelect={setSelected}
        canCreateNewView
        appliedFilters={appliedFilters}
        mode={mode}
        setMode={setMode}
        filters={[]}
        hideFilters
      />

      <IndexTable
        resourceName={resourceName}
        itemCount={transfers.length}
        headings={[
          { title: "Transfer" },
          { title: "Origin" },
          { title: "Destination" },
          { title: "Status" },
          { title: "Total qty" },
          { title: "Received qty" },
          { title: "DDT" },
        ]}
        selectable={false}
        selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
        onSelectionChange={handleSelectionChange}
      >
        {rowMarkup}
      </IndexTable>

      {hasNextPage && (
        <div style={{ padding: "16px", textAlign: "center" }}>
          <Button
            onClick={() => {
              const formData = new FormData();
              formData.append("after", endCursor || "");
              fetcher.submit(formData, { method: "post" });
            }}
            loading={fetcher.state === "submitting"}
          >
            Load more
          </Button>
        </div>
      )}
    </Card>
  );
}
