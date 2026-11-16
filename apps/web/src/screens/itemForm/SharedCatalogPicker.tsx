import { useRef, useState } from "react";
import type { SharedCatalogEntry, SharedCatalogPage } from "@mytowncart-billing/connector-mytowncart";
import { getConnector } from "../../lib/marketplace";

export function SharedCatalogPicker({ onSelect }: { onSelect: (entry: SharedCatalogEntry) => Promise<void> }) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState<SharedCatalogPage | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadedSearch, setLoadedSearch] = useState("");
  const requestId = useRef(0);
  const find = async (number = 1) => {
    const request = ++requestId.current;
    setBusy(true); setError(""); setPage(null);
    const term = number === 1 ? search : loadedSearch;
    try {
      const result = await getConnector().searchSharedCatalog(term, number);
      if (request !== requestId.current) return;
      setPage(result); setPageNumber(number); setLoadedSearch(term);
    } catch (err) {
      if (request === requestId.current) setError(err instanceof Error ? err.message : "Catalog unavailable. You can still enter the item manually.");
    } finally { if (request === requestId.current) setBusy(false); }
  };
  const select = async (entry: SharedCatalogEntry) => {
    setBusy(true); setError("");
    try { await onSelect(entry); setPage(null); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  return <section className="rounded-xl border border-gray-200 bg-white p-6 space-y-3">
    <h2 className="font-bold text-gray-900">Find in MyTownCart catalog</h2>
    <p className="text-sm text-gray-600">Choose the exact pack to fill details and an approved photo. Enter your own price, tax and opening stock. Manual entry works offline.</p>
    <div className="flex gap-2">
      <input aria-label="Catalog name or barcode" className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-2" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void find(); } }} placeholder="Scan/type barcode or product name" />
      <button type="button" disabled={busy} onClick={() => void find()} className="rounded-lg bg-blue-600 px-4 py-2 text-white disabled:opacity-50">{busy ? "Loading…" : "Search"}</button>
    </div>
    {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
    {page?.results.length === 0 ? <p className="text-sm text-gray-600">No matches. Enter this item manually.</p> : null}
    {page?.results.map((entry) => <div key={entry.id} className="flex items-center justify-between gap-3 border-t border-gray-100 py-3">
      <div><p className="font-semibold">{entry.display_name}</p><p className="text-sm text-gray-600">{[entry.brand_name, entry.category_name, entry.barcode].filter(Boolean).join(" · ")}</p></div>
      <button type="button" disabled={busy} onClick={() => void select(entry)} className="shrink-0 rounded-lg border border-blue-600 px-3 py-2 text-blue-700 disabled:opacity-50">Use this pack</button>
    </div>)}
    {page ? <div className="flex gap-3">
      {pageNumber > 1 ? <button type="button" disabled={busy} onClick={() => void find(pageNumber - 1)}>Previous</button> : null}
      {page.next ? <button type="button" disabled={busy} onClick={() => void find(pageNumber + 1)}>Next</button> : null}
    </div> : null}
  </section>;
}
