import { useEffect, useRef, useState, type FormEvent } from "react";

const BLUE_SHIELD_GROUPS = [
  "AST",
  "BZA",
  "CTH",
  "DMA",
  "GEH",
  "JTC",
  "KMJ",
  "MAIN",
  "NSG",
  "SARMG",
  "SDOMG",
  "USA",
  "AHK",
  "BPH",
  "ESC",
  "FASC",
  "IENT",
  "IPMG",
  "IUMG",
  "KS-PC",
  "LCS",
  "MMG",
  "NUR",
  "Posada",
  "SMHR",
  "SSCE",
  "TAJ",
  "TAT",
  "TWL",
  "WMGU",
];

export function BlueShieldInputForm({
  canSubmit,
  group,
  isProcessing,
  resetCheckpoint,
  onCredentialFileChange,
  onGroupChange,
  onInputFileChange,
  onResetCheckpointChange,
  onSubmit,
}: {
  canSubmit: boolean;
  group: string;
  isProcessing: boolean;
  resetCheckpoint: boolean;
  onCredentialFileChange: (file: File | null) => void;
  onGroupChange: (group: string) => void;
  onInputFileChange: (file: File | null) => void;
  onResetCheckpointChange: (value: boolean) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const [isGroupDropdownOpen, setIsGroupDropdownOpen] = useState(false);
  const [groupSearch, setGroupSearch] = useState("");
  const normalizedGroupSearch = groupSearch.trim().toLowerCase();
  const filteredGroups = normalizedGroupSearch
    ? BLUE_SHIELD_GROUPS.filter((groupName) => groupName.toLowerCase().includes(normalizedGroupSearch))
    : BLUE_SHIELD_GROUPS;

  useEffect(() => {
    function closeDropdown(event: MouseEvent) {
      if (!dropdownRef.current?.contains(event.target as Node)) {
        setIsGroupDropdownOpen(false);
      }
    }

    document.addEventListener("mousedown", closeDropdown);
    return () => document.removeEventListener("mousedown", closeDropdown);
  }, []);

  return (
    <form className="mt-6 space-y-5" onSubmit={onSubmit}>
      <div>
        <label className="mb-2 block text-sm font-medium" htmlFor="blueShieldGroup">
          1. Select group
        </label>
        <div ref={dropdownRef} className="relative">
          <button
            type="button"
            id="blueShieldGroup"
            aria-expanded={isGroupDropdownOpen}
            aria-haspopup="listbox"
            onClick={() => setIsGroupDropdownOpen((isOpen) => !isOpen)}
            className="flex w-full items-center justify-between rounded-md border border-slate-300 bg-white p-2 text-left text-sm text-slate-900"
          >
            <span className={group ? "" : "text-slate-500"}>{group || "Choose the group"}</span>
            <span
              aria-hidden="true"
              className="h-2 w-2 border-b-2 border-r-2 border-slate-500 transition-transform"
              style={{ transform: isGroupDropdownOpen ? "rotate(225deg)" : "rotate(45deg)" }}
            />
          </button>

          {isGroupDropdownOpen ? (
            <div className="absolute z-20 mt-1 w-full rounded-md border border-slate-300 bg-white shadow-lg">
              <div className="border-b border-slate-200 p-2">
                <input
                  type="search"
                  value={groupSearch}
                  onChange={(event) => setGroupSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                    }
                  }}
                  placeholder="Search group"
                  className="block w-full rounded-md border border-slate-300 bg-white p-2 text-sm"
                  autoFocus
                />
              </div>
              <div className="max-h-56 overflow-y-auto py-1" role="listbox" aria-labelledby="blueShieldGroup">
                {filteredGroups.length ? (
                  filteredGroups.map((groupName) => (
                    <button
                      key={groupName}
                      type="button"
                      role="option"
                      aria-selected={groupName === group}
                      onClick={() => {
                        onGroupChange(groupName);
                        setGroupSearch("");
                        setIsGroupDropdownOpen(false);
                      }}
                      className={`block w-full px-3 py-2 text-left text-sm hover:bg-blue-50 ${
                        groupName === group ? "bg-blue-50 font-medium text-blue-700" : "text-slate-900"
                      }`}
                    >
                      {groupName}
                    </button>
                  ))
                ) : (
                  <div className="px-3 py-2 text-sm text-slate-500">No groups found</div>
                )}
              </div>
            </div>
          ) : null}
        </div>
        {!group ? (
          <p className="mt-2 text-xs text-slate-500">Choose the group before starting.</p>
        ) : null}
      </div>

      <div>
        <label className="mb-2 block text-sm font-medium" htmlFor="blueShieldCredentialExcel">
          2. Provide Blue Shield login Excel
        </label>
        <input
          id="blueShieldCredentialExcel"
          type="file"
          accept=".xlsx,.xls,.csv"
          onChange={(event) => onCredentialFileChange(event.target.files?.[0] ?? null)}
          className="block w-full rounded-md border border-slate-300 p-2 text-sm"
        />
      </div>

      <div>
        <label className="mb-2 block text-sm font-medium" htmlFor="blueShieldInputExcel">
          3. Provide Blue Shield input Excel
        </label>
        <input
          id="blueShieldInputExcel"
          type="file"
          accept=".xlsx,.xls,.csv"
          onChange={(event) => onInputFileChange(event.target.files?.[0] ?? null)}
          className="block w-full rounded-md border border-slate-300 p-2 text-sm"
        />
      </div>

      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={resetCheckpoint}
          onChange={(event) => onResetCheckpointChange(event.target.checked)}
          className="h-4 w-4 rounded border-slate-300"
        />
        Reset saved checkpoint for this workbook
      </label>

      <button
        type="submit"
        disabled={!canSubmit}
        className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-400"
      >
        {isProcessing ? "Processing..." : "Start processing"}
      </button>
    </form>
  );
}
