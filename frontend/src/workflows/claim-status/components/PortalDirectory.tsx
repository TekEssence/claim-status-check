import { Search, SlidersHorizontal } from "lucide-react";
import Image from "next/image";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import type { claimStatusPortalRegistry } from "../registry";
import { PORTAL_UI_META } from "../portal-meta";
import type { PortalId } from "../shared/model";
type Portal = (typeof claimStatusPortalRegistry)[number];
type Setter<T> = Dispatch<SetStateAction<T>>;

export function PortalDirectory(p: {
  workflowRunsPanel: ReactNode; operationsRunningJobsPanel: ReactNode;
  portalSearch: string; setPortalSearch: Setter<string>;
  filterMenuOpen: boolean; setFilterMenuOpen: Setter<boolean>;
  portalFilter: "all" | PortalId; setPortalFilter: Setter<"all" | PortalId>;
  availablePortals: readonly Portal[]; filteredPortals: Portal[];
  portalSort: "name-asc" | "name-desc"; setPortalSort: Setter<"name-asc" | "name-desc">;
  portalLayout: "grid" | "list"; onPortalSelect: (id: PortalId) => void;
}) {
  const { workflowRunsPanel, operationsRunningJobsPanel, portalSearch, setPortalSearch,
    filterMenuOpen, setFilterMenuOpen, portalFilter, setPortalFilter,
    availablePortals, filteredPortals, portalSort, setPortalSort, portalLayout,
    onPortalSelect } = p;
  return (
    <>
{workflowRunsPanel}
              {operationsRunningJobsPanel}

              <div className="mt-5">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <label className="flex h-12 w-full items-center gap-3 rounded-[1rem] border border-sky-100 bg-white/95 px-4 shadow-[0_10px_28px_rgba(148,163,184,0.1)] lg:max-w-[24rem]">
                    <Search className="h-4 w-4 text-slate-400" strokeWidth={2.2} />
                    <input
                      type="text"
                      value={portalSearch}
                      onChange={(event) => setPortalSearch(event.target.value)}
                      placeholder="Search portals..."
                      className="w-full bg-transparent text-sm text-slate-800 outline-none placeholder:text-slate-400"
                    />
                  </label>
                  <div className="flex items-center gap-3 text-sm text-slate-500">
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => setFilterMenuOpen((open) => !open)}
                        className="inline-flex h-10 items-center gap-2 rounded-[0.95rem] border border-sky-100 bg-white/95 px-4 text-sm font-medium text-slate-700 shadow-[0_10px_24px_rgba(148,163,184,0.08)]"
                      >
                        <SlidersHorizontal className="h-4 w-4" strokeWidth={2.1} />
                        Filters
                      </button>
                      {filterMenuOpen && (
                        <div className="absolute right-0 top-full z-20 mt-2 w-52 rounded-[1rem] border border-sky-100 bg-white/98 p-2 shadow-[0_18px_44px_rgba(15,23,42,0.12)] backdrop-blur-xl">
                          <button
                            type="button"
                            onClick={() => {
                              setPortalFilter("all");
                              setFilterMenuOpen(false);
                            }}
                            className={`block w-full rounded-[0.8rem] px-3 py-2 text-left text-sm ${
                              portalFilter === "all" ? "bg-blue-50 text-blue-700" : "text-slate-700 hover:bg-sky-50"
                            }`}
                          >
                            All portals
                          </button>
                          {availablePortals.map((portal) => (
                            <button
                              key={`filter-${portal.id}`}
                              type="button"
                              onClick={() => {
                                setPortalFilter(portal.id as PortalId);
                                setFilterMenuOpen(false);
                              }}
                              className={`block w-full rounded-[0.8rem] px-3 py-2 text-left text-sm ${
                                portalFilter === portal.id ? "bg-blue-50 text-blue-700" : "text-slate-700 hover:bg-sky-50"
                              }`}
                            >
                              {portal.name}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setPortalSort((current) => (current === "name-asc" ? "name-desc" : "name-asc"))
                      }
                      className="inline-flex h-10 items-center gap-2 rounded-[0.95rem] border border-sky-100 bg-white/95 px-4 text-sm font-medium text-slate-700 shadow-[0_10px_24px_rgba(148,163,184,0.08)]"
                    >
                      Sort by
                      <span className="text-slate-500">{portalSort === "name-asc" ? "A-Z" : "Z-A"}</span>
                    </button>
                  </div>
                </div>

                <div className="mb-4 flex items-center justify-between gap-4">
                  <div>
                    <h2 className="text-sm font-semibold text-slate-900">Available Portals</h2>
                    <p className="mt-1 text-xs text-slate-500">Launch claim status automation workspaces</p>
                  </div>
                  <div className="text-xs text-slate-400">Showing {filteredPortals.length} of {availablePortals.length}</div>
                </div>

                {filteredPortals.length === 0 ? (
                  <div className="rounded-[1.4rem] border border-dashed border-sky-200 bg-white/80 px-6 py-10 text-center text-sm text-slate-500">
                    No portals matched your search. Try another keyword.
                  </div>
                ) : (
                  <div className={portalLayout === "grid" ? "grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" : "space-y-4"}>
                    {filteredPortals.map((portal) => {
                      const meta = PORTAL_UI_META[portal.id as PortalId];

                      return (
                        <button
                          key={portal.id}
                          type="button"
                          onClick={() => onPortalSelect(portal.id as PortalId)}
                          className={`group rounded-[1.35rem] border border-sky-100 bg-[linear-gradient(180deg,rgba(255,255,255,0.99)_0%,rgba(246,250,255,0.97)_100%)] p-4 text-left shadow-[0_16px_36px_rgba(148,163,184,0.12)] transition hover:-translate-y-0.5 hover:border-blue-400 hover:shadow-[0_22px_44px_rgba(59,130,246,0.14)] ${
                            portalLayout === "list" ? "flex items-start gap-4" : ""
                          }`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <span
                              className={`flex items-center justify-center overflow-hidden text-xs font-semibold shadow-inner ${
                                meta.logoSrc ? (meta.cardLogoFrameClassName ?? "h-10 w-[4.4rem] rounded-[1rem] px-2") : "h-10 w-10 rounded-2xl"
                              } ${meta.logoClassName}`}
                            >
                              {meta.logoSrc ? (
                                <Image
                                  src={meta.logoSrc}
                                  alt={`${portal.name} logo`}
                                  width={meta.cardLogoSize?.width ?? 56}
                                  height={meta.cardLogoSize?.height ?? 20}
                                  className={meta.cardLogoImageClassName ?? "h-5 w-full object-contain"}
                                />
                              ) : (
                                meta.shortCode
                              )}
                            </span>
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-1 text-[0.65rem] font-semibold text-emerald-600">
                              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                              Ready
                            </span>
                          </div>
                          <span className={`block ${portalLayout === "list" ? "flex-1" : ""}`}>
                            <span className={`${portalLayout === "grid" ? "mt-4" : ""} block text-base font-semibold tracking-[-0.03em] text-slate-950`}>{portal.name}</span>
                            <span className="mt-2 block text-[0.72rem] leading-5 text-slate-600">{portal.description}</span>
                            <span className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-[0.9rem] bg-[linear-gradient(90deg,#1f8bff_0%,#2563eb_44%,#2347ef_100%)] px-3 py-2.5 text-sm font-medium text-white shadow-[0_14px_26px_rgba(37,99,235,0.22)]">
                              Open Portal
                              <span aria-hidden="true">&rarr;</span>
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
    </>
  );
}
