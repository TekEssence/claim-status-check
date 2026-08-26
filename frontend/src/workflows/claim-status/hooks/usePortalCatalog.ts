import { useMemo, useState } from "react";
import { claimStatusPortalRegistry } from "../registry";
import type { PortalId } from "../shared/model";

export function usePortalCatalog(forcedPortalId: PortalId | null, pathname: string) {
  const [selectedPortalId, setSelectedPortalId] = useState<PortalId | null>(null);
  const [portalSearch, setPortalSearch] = useState("");
  const [portalFilter, setPortalFilter] = useState<"all" | PortalId>("all");
  const [portalSort, setPortalSort] = useState<"name-asc" | "name-desc">("name-asc");
  const [portalLayout, setPortalLayout] = useState<"grid" | "list">("grid");
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const effectivePortalId = forcedPortalId ?? (pathname === "/claim-status" ? null : selectedPortalId);
  const availablePortals = claimStatusPortalRegistry;
  const selectedPortal = effectivePortalId
    ? availablePortals.find((portal) => portal.id === effectivePortalId) ?? null
    : null;
  const filteredPortals = useMemo(() => {
    const query = portalSearch.trim().toLowerCase();
    return availablePortals
      .filter((portal) => {
        const searchable = `${portal.name} ${portal.description} ${portal.id}`.toLowerCase();
        return (!query || searchable.includes(query)) &&
          (portalFilter === "all" || portal.id === portalFilter);
      })
      .sort((left, right) => portalSort === "name-asc"
        ? left.name.localeCompare(right.name)
        : right.name.localeCompare(left.name));
  }, [portalFilter, portalSearch, portalSort]);

  return {
    availablePortals, effectivePortalId, filteredPortals, filterMenuOpen,
    portalFilter, portalLayout, portalSearch, portalSort, selectedPortal,
    selectedPortalId, setFilterMenuOpen, setPortalFilter, setPortalLayout,
    setPortalSearch, setPortalSort, setSelectedPortalId,
  };
}
