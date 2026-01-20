import {
  Card,
  Badge,
  Button,
  IndexFilters,
  IndexTable,
  Text,
  useSetIndexFiltersMode,
  IndexFiltersMode,
  ChoiceList,
  TextField,
} from "@shopify/polaris";
import type { TabProps, IndexFiltersProps } from "@shopify/polaris";
import { PrintIcon } from "@shopify/polaris-icons";
import {
  useFetcher,
  useLoaderData,
  useNavigate,
  useRevalidator,
  useSearchParams,
} from "@remix-run/react";
import { authenticate } from "app/shopify.server";
import db from "../db.server";
import { ActionFunctionArgs, LoaderFunctionArgs, json } from "@remix-run/node";
import { useEffect, useState, useMemo, useCallback } from "react";

/* ===========================
   LOADER & ACTION (INVARIATI)
=========================== */
// ... (Mantieni il tuo loader e action esattamente come sono, non servono modifiche lì)

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const savedViews = await db.inventoryView.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "asc" },
  });
  return json({ shop: session.shop, savedViews });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const _action = formData.get("_action");

  if (_action === "createView") {
    await db.inventoryView.create({
      data: {
        shop: session.shop,
        name: formData.get("name") as string,
        tabId: formData.get("tabId") as string,
        filters: formData.get("filters") as string,
        query: formData.get("query") as string,
        sort: formData.get("sort") as string,
      },
    });
    return json({ success: true });
  }

  if (_action === "deleteView") {
    const tabId = formData.get("tabId") as string;
    await db.inventoryView.delete({ where: { tabId } });
    return json({ success: true });
  }

  const after = formData.get("after")?.toString() || null;
  const query = `query InventoryTransfers($first: Int!, $after: String) {
    inventoryTransfers(first: $first, after: $after, sortKey: ID) {
      edges {
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

  const response = await admin.graphql(query, { variables: { first: 15, after } });
  const responseJson = await response.json();

  return json({
    inventoryTransfers: responseJson.data.inventoryTransfers.edges.map((edge: any) => edge.node),
    pageInfo: responseJson.data.inventoryTransfers.pageInfo,
  });
};

/* ===========================
   COMPONENT
=========================== */
type TabItem = { id: string; name: string };

export default function Index() {
  const { savedViews } = useLoaderData<typeof loader>();
  const inventoryFetcher = useFetcher<any>();
  const viewFetcher = useFetcher<any>();
  const revalidator = useRevalidator();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [rawTransfers, setRawTransfers] = useState<any[]>([]);
  const [pageInfo, setPageInfo] = useState({ hasNextPage: false, endCursor: null });
  const [tabsState, setTabsState] = useState<TabItem[]>([]);
  const [selected, setSelected] = useState(0);

  // --- STATO DEI FILTRI (Separati per chiarezza e compatibilità Polaris) ---
  const [queryValue, setQueryValue] = useState("");
  const [sortSelected, setSortSelected] = useState(["transfer asc"]);
  
  const [statusFilter, setStatusFilter] = useState<string[] | undefined>(undefined);
  const [originFilter, setOriginFilter] = useState<string | undefined>(undefined);
  const [destinationFilter, setDestinationFilter] = useState<string | undefined>(undefined);

  const { mode, setMode } = useSetIndexFiltersMode();

  /* ---------------- Sync tabs from DB ---------------- */
  useEffect(() => {
    setTabsState([
      { id: "tab-all", name: "All" },
      { id: "tab-received", name: "Received" },
      { id: "tab-notreceived", name: "Not received" },
      ...savedViews.map(v => ({ id: v.tabId, name: v.name })),
    ]);
  }, [savedViews]);

  /* ---------------- Restore filters on tab change ---------------- */
  useEffect(() => {
    const view = savedViews.find(v => v.tabId === tabsState[selected]?.id);
    
    // Reset di base
    setStatusFilter(undefined);
    setOriginFilter(undefined);
    setDestinationFilter(undefined);
    setQueryValue("");
    setSortSelected(["transfer asc"]);

    // Logica Tabs predefinite
    if (tabsState[selected]?.id === "tab-received") {
      setStatusFilter(["RECEIVED"]);
    } else if (tabsState[selected]?.id === "tab-notreceived") {
      setStatusFilter(["IN_TRANSIT"]); // O altro status non ricevuto
    }

    // Logica Viste Salvate dal DB
    if (view) {
      if (view.query) setQueryValue(view.query);
      if (view.sort) setSortSelected([view.sort]);
      
      // Parsiamo i filtri salvati nel DB
      if (view.filters) {
        try {
          const parsedFilters = JSON.parse(view.filters);
          parsedFilters.forEach((f: any) => {
            if (f.key === "status") setStatusFilter(f.value);
            if (f.key === "origin") setOriginFilter(f.value);
            if (f.key === "destination") setDestinationFilter(f.value);
          });
        } catch (e) {
          console.error("Error parsing filters", e);
        }
      }
    }
  }, [selected, tabsState, savedViews]);

  /* ---------------- Fetch inventory ---------------- */
  useEffect(() => {
    inventoryFetcher.submit({}, { method: "post" });
  }, []);

  useEffect(() => {
    if (inventoryFetcher.data?.inventoryTransfers) {
      const newTransfers = inventoryFetcher.data.inventoryTransfers;
      setRawTransfers(prev =>
        inventoryFetcher.formData?.get("after") ? [...prev, ...newTransfers] : newTransfers
      );
      setPageInfo(inventoryFetcher.data.pageInfo);
    }
  }, [inventoryFetcher.data]);

  /* ---------------- Handlers dei Filtri ---------------- */
  const handleStatusChange = useCallback((value: string[]) => setStatusFilter(value), []);
  const handleOriginChange = useCallback((value: string) => setOriginFilter(value), []);
  const handleDestinationChange = useCallback((value: string) => setDestinationFilter(value), []);

  const handleFiltersClearAll = useCallback(() => {
    setStatusFilter(undefined);
    setOriginFilter(undefined);
    setDestinationFilter(undefined);
    setQueryValue("");
  }, []);

  // --- DEFINIZIONE FILTRI (Questo fa apparire il pulsante "Aggiungi filtro") ---
  const filters = [
    {
      key: "status",
      label: "Status",
      filter: (
        <ChoiceList
          title="Status"
          titleHidden
          choices={[
            { label: "Received", value: "RECEIVED" },
            { label: "In transit", value: "IN_TRANSIT" },
            { label: "Pending", value: "PENDING" },
          ]}
          selected={statusFilter || []}
          onChange={handleStatusChange}
          allowMultiple
        />
      ),
      shortcut: true,
    },
    {
      key: "origin",
      label: "Origin",
      filter: (
        <TextField
          label="Origin"
          value={originFilter || ""}
          onChange={handleOriginChange}
          autoComplete="off"
          labelHidden
        />
      ),
    },
    {
      key: "destination",
      label: "Destination",
      filter: (
        <TextField
          label="Destination"
          value={destinationFilter || ""}
          onChange={handleDestinationChange}
          autoComplete="off"
          labelHidden
        />
      ),
    },
  ];

  // --- APPLIED FILTERS (Le "bolle" sotto la barra) ---
  const appliedFilters: IndexFiltersProps["appliedFilters"] = [];
  
  if (statusFilter && statusFilter.length > 0) {
    appliedFilters.push({
      key: "status",
      label: `Status: ${statusFilter.join(", ")}`,
      onRemove: () => setStatusFilter(undefined),
    });
  }
  if (originFilter) {
    appliedFilters.push({
      key: "origin",
      label: `Origin: ${originFilter}`,
      onRemove: () => setOriginFilter(undefined),
    });
  }
  if (destinationFilter) {
    appliedFilters.push({
      key: "destination",
      label: `Destination: ${destinationFilter}`,
      onRemove: () => setDestinationFilter(undefined),
    });
  }

  /* ---------------- View CRUD ---------------- */
  const onCreateNewView = async (name: string) => {
    const tabId = `tab-${crypto.randomUUID()}`;
    
    // Ricostruiamo l'array JSON per il DB basato sugli stati attuali
    const filtersToSave = [];
    if (statusFilter) filtersToSave.push({ key: 'status', value: statusFilter });
    if (originFilter) filtersToSave.push({ key: 'origin', value: originFilter });
    if (destinationFilter) filtersToSave.push({ key: 'destination', value: destinationFilter });

    viewFetcher.submit(
      {
        _action: "createView",
        name,
        tabId,
        filters: JSON.stringify(filtersToSave),
        query: queryValue,
        sort: sortSelected[0],
      },
      { method: "post" }
    );

    revalidator.revalidate();
    setMode(IndexFiltersMode.Default);
    return true;
  };

  const deleteView = (tabId: string) => {
    viewFetcher.submit({ _action: "deleteView", tabId }, { method: "post" });
    setSelected(0);
    revalidator.revalidate();
  };

  /* ---------------- Tabs Configuration ---------------- */
  const tabs: TabProps[] = tabsState.map((tab, index) => ({
    content: tab.name,
    index,
    id: tab.id,
    isLocked: index <= 2,
    actions: index > 2 ? [{ type: "delete", onPrimaryAction: () => deleteView(tab.id) }] : [],
  }));

  /* ---------------- Filtering Logic (Aggiornata) ---------------- */
  const filteredTransfers = useMemo(() => {
    let data = [...rawTransfers];

    // Status Filter
    if (statusFilter && statusFilter.length > 0) {
      data = data.filter(t => statusFilter.includes(t.status));
    }

    // Origin Filter
    if (originFilter) {
      data = data.filter(t => t.origin?.name?.toLowerCase().includes(originFilter.toLowerCase()));
    }

    // Destination Filter
    if (destinationFilter) {
      data = data.filter(t => t.destination?.name?.toLowerCase().includes(destinationFilter.toLowerCase()));
    }

    // Query Search
    if (queryValue) {
      const term = queryValue.toLowerCase();
      data = data.filter(
        t =>
          t.name.toLowerCase().includes(term) ||
          t.origin?.name?.toLowerCase().includes(term) ||
          t.destination?.name?.toLowerCase().includes(term)
      );
    }

    // Sorting
    const [field, dir] = sortSelected[0].split(" ");
    data.sort((a, b) => {
      let aVal = field === "qty" ? a.totalQuantity : a.id;
      let bVal = field === "qty" ? b.totalQuantity : b.id;
      if (aVal < bVal) return dir === "asc" ? -1 : 1;
      if (aVal > bVal) return dir === "asc" ? 1 : -1;
      return 0;
    });

    return data;
  }, [rawTransfers, statusFilter, originFilter, destinationFilter, queryValue, sortSelected]);

  /* ---------------- Render ---------------- */
  return (
    <Card padding="0">
      <IndexFilters
        sortOptions={[
          { label: "Transfer", value: "transfer asc", directionLabel: "Ascending" },
          { label: "Transfer", value: "transfer desc", directionLabel: "Descending" },
          { label: "Quantity", value: "qty asc", directionLabel: "Ascending" },
          { label: "Quantity", value: "qty desc", directionLabel: "Descending" }
        ]}
        sortSelected={sortSelected}
        queryValue={queryValue}
        onQueryChange={setQueryValue}
        onQueryClear={() => setQueryValue("")}
        onSort={setSortSelected}
        primaryAction={{
          type: "save-as",
          onAction: onCreateNewView,
          disabled: queryValue === "" && !statusFilter && !originFilter && !destinationFilter,
        }}
        cancelAction={{ onAction: () => setMode(IndexFiltersMode.Default) }}
        tabs={tabs}
        selected={selected}
        onSelect={setSelected}
        canCreateNewView
        onCreateNewView={onCreateNewView}
        mode={mode}
        setMode={setMode}
        // --- QUESTE SONO LE PROPS MAGICHE ---
        filters={filters} // Definisce cosa appare nel menu "Aggiungi filtro"
        appliedFilters={appliedFilters} // Definisce le bolle attive
        onClearAll={handleFiltersClearAll}
      />

      <IndexTable
        resourceName={{ singular: "transfer", plural: "transfers" }}
        itemCount={filteredTransfers.length}
        headings={[
          { title: "Transfer" },
          { title: "Origin" },
          { title: "Destination" },
          { title: "Status" },
          { title: "Total qty" },
          { title: "Received qty" },
          { title: "Action" },
        ]}
        selectable={false}
      >
        {filteredTransfers.map((t, idx) => {
          
          const transferId = t.id.split("/").pop();

          return (
            <IndexTable.Row key={t.id} id={t.id} position={idx}>
              <IndexTable.Cell>
                <Text as="span" fontWeight="semibold">{t.name}</Text>
              </IndexTable.Cell>
              <IndexTable.Cell>{t.origin?.name || "-"}</IndexTable.Cell>
              <IndexTable.Cell>{t.destination?.name || "-"}</IndexTable.Cell>
              <IndexTable.Cell>
                <Badge tone={t.status === "RECEIVED" ? "success" : "info"}>{t.status}</Badge>
              </IndexTable.Cell>
              <IndexTable.Cell>{t.totalQuantity}</IndexTable.Cell>
              <IndexTable.Cell>{t.receivedQuantity}</IndexTable.Cell>
              <IndexTable.Cell>
                <Button 
                    icon={PrintIcon} 
                    onClick={() => {
                      // Mantiene tutti i parametri attuali (host, id_token, etc.)
                      // e naviga alla pagina corretta
                      navigate(`/app/${transferId}/ddttransfer?${searchParams.toString()}`);
                    }}
                  >
                  Print
                </Button>
              </IndexTable.Cell>
            </IndexTable.Row>
          );
        })}
      </IndexTable>

      {pageInfo.hasNextPage && (
        <div style={{ padding: 16, display: "flex", justifyContent: "center" }}>
          <Button
            onClick={() =>
              inventoryFetcher.submit({ after: pageInfo.endCursor }, { method: "post" })
            }
          >
            Load more
          </Button>
        </div>
      )}
    </Card>
  );
}