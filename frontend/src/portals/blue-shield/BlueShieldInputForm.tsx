import { useEffect, useRef, useState, type FormEvent } from "react";
import { FileSpreadsheet, KeyRound, Play } from "lucide-react";
import { PortalUploadCard } from "../../components/portal-workflow/PortalUploadCard";

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
  credentialFileName,
  group,
  inputFileName,
  isProcessing,
  resetCheckpoint,
  onCredentialFileChange,
  onGroupChange,
  onInputFileChange,
  onResetCheckpointChange,
  onSubmit,
}: {
  canSubmit: boolean;
  credentialFileName?: string;
  group: string;
  inputFileName?: string;
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
    <form className="space-y-5" onSubmit={onSubmit}>
      <div className="rounded-[1.5rem] border border-sky-100 bg-[linear-gradient(180deg,rgba(255,255,255,0.98)_0%,rgba(244,249,255,0.96)_100%)] p-5 shadow-[0_16px_34px_rgba(148,163,184,0.12)]">
        <label className="text-base font-semibold tracking-[-0.03em] text-slate-950" htmlFor="blueShieldGroup">
          Select Processing Group
        </label>
        <p className="mt-2 text-sm text-slate-600">Choose the Blue Shield payer group before uploading the workbook package.</p>
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

      <div className="grid gap-5 xl:grid-cols-2">
        <PortalUploadCard
          mode="file"
          accept=".xlsx,.xls,.csv"
          acceptedFormats=".xlsx, .xls, .csv"
          description="Upload the Blue Shield credential workbook used for secure portal sign-in."
          fileName={credentialFileName}
          icon={KeyRound}
          inputId="blueShieldCredentialExcel"
          onFileSelect={onCredentialFileChange}
          sizeHint="10 MB"
          title="Upload Login File"
        />
        <PortalUploadCard
          mode="file"
          accept=".xlsx,.xls,.csv"
          acceptedFormats=".xlsx, .xls, .csv"
          description="Upload the input workbook grouped by Member ID for automated Blue Shield validation."
          fileName={inputFileName}
          icon={FileSpreadsheet}
          inputId="blueShieldInputExcel"
          onFileSelect={onInputFileChange}
          sizeHint="25 MB"
          title="Upload Claim File"
        />
      </div>

      <label className="flex items-center gap-3 rounded-[1.2rem] border border-sky-100 bg-white/80 px-4 py-3 text-sm text-slate-700 shadow-sm">
        <input
          type="checkbox"
          checked={resetCheckpoint}
          onChange={(event) => onResetCheckpointChange(event.target.checked)}
          className="h-4 w-4 rounded border-slate-300 text-blue-600"
        />
        Reset saved checkpoint for this workbook
      </label>

      <button
        type="submit"
        disabled={!canSubmit}
        className="inline-flex w-full items-center justify-center gap-2 rounded-[1.2rem] bg-[linear-gradient(90deg,#1f8bff_0%,#2563eb_44%,#2347ef_100%)] px-5 py-3.5 text-sm font-semibold text-white shadow-[0_18px_34px_rgba(37,99,235,0.24)] transition hover:shadow-[0_22px_40px_rgba(37,99,235,0.32)] disabled:cursor-not-allowed disabled:bg-slate-400 disabled:shadow-none"
      >
        <Play className="h-4 w-4" strokeWidth={2.2} />
        {isProcessing ? "Processing..." : "Start processing"}
      </button>
      <p className="text-center text-sm text-slate-500">Estimated processing time: 2-5 minutes</p>
    </form>
  );
}
