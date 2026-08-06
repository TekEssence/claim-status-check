import type { FormEvent } from "react";
import { FileSpreadsheet, KeyRound, Play } from "lucide-react";
import { PortalUploadCard } from "../../../../components/portal-workflow/PortalUploadCard";

export function AvailityInputForm({
  canSubmit,
  credentialFileName,
  inputFileName,
  isProcessing,
  selectedProjectId,
  onCredentialFileChange,
  onInputFileChange,
  onProjectChange,
  onSubmit,
}: {
  canSubmit: boolean;
  credentialFileName?: string;
  inputFileName?: string;
  isProcessing: boolean;
  selectedProjectId: string;
  onCredentialFileChange: (file: File | null) => void;
  onInputFileChange: (file: File | null) => void;
  onProjectChange: (projectId: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const projects = [
    {
      id: "minimax",
      name: "Minimax",
      description: "Uses the existing TPM/DAO provider fallback flow.",
    },
    {
      id: "medrevenu",
      name: "Medrevenu",
      description: "Uses Group from the claim file to select one mapped provider.",
    },
  ];

  return (
    <form className="space-y-5" onSubmit={onSubmit}>
      <div className="rounded-[1.2rem] border border-blue-100 bg-blue-50/70 px-4 py-3 text-sm text-blue-900">
        <span className="font-semibold">Available Payers:</span> Aetna, Anthem-CA, Blue Cross Blue Shield, Wellpoint, Wellcare, Humana, Central Health Medicare Plan, Health Net, Molina, Providence Health Plan, Scan Health, TRIWEST-TRICARE, TRIWEST-VA CCN
      </div>

      <div className="rounded-[1.2rem] border border-sky-100 bg-white/90 p-4">
        <p className="text-sm font-semibold text-slate-900">Select Project</p>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {projects.map((project) => {
            const isSelected = selectedProjectId === project.id;
            return (
              <button
                key={project.id}
                type="button"
                onClick={() => onProjectChange(project.id)}
                disabled={isProcessing}
                className={`rounded-[1rem] border px-4 py-3 text-left transition ${
                  isSelected
                    ? "border-blue-400 bg-blue-50 text-blue-950 shadow-[0_12px_24px_rgba(37,99,235,0.12)]"
                    : "border-sky-100 bg-slate-50/70 text-slate-700 hover:border-blue-200 hover:bg-blue-50/60"
                } disabled:cursor-not-allowed disabled:opacity-70`}
              >
                <span className="block text-sm font-semibold">{project.name}</span>
                <span className="mt-1 block text-xs leading-5 text-slate-500">{project.description}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <PortalUploadCard
          mode="file"
          accept=".xlsx,.xls,.csv"
          acceptedFormats=".xlsx, .xls, .csv"
          description="Upload the workbook containing Project, Link, Username, Password, and Secret Key."
          fileName={credentialFileName}
          icon={KeyRound}
          inputId="availityCredentialExcel"
          onFileSelect={onCredentialFileChange}
          sizeHint="10 MB"
          title="Upload Login File"
        />
        <PortalUploadCard
          mode="file"
          accept=".xlsx,.xls,.csv"
          acceptedFormats=".xlsx, .xls, .csv"
          description="Upload the claim details workbook for Availity claim status automation."
          fileName={inputFileName}
          icon={FileSpreadsheet}
          inputId="availityInputExcel"
          onFileSelect={onInputFileChange}
          sizeHint="25 MB"
          title="Upload Claim File"
        />
      </div>

      <button
        type="submit"
        disabled={!canSubmit}
        className="inline-flex w-full items-center justify-center gap-2 rounded-[1.2rem] bg-[linear-gradient(90deg,#1f8bff_0%,#2563eb_44%,#2347ef_100%)] px-5 py-3.5 text-sm font-semibold text-white shadow-[0_18px_34px_rgba(37,99,235,0.24)] transition hover:shadow-[0_22px_40px_rgba(37,99,235,0.32)] disabled:cursor-not-allowed disabled:bg-slate-400 disabled:shadow-none"
      >
        <Play className="h-4 w-4" strokeWidth={2.2} />
        {isProcessing ? "Processing..." : "Start processing"}
      </button>
      <p className="text-center text-sm text-slate-500">Output Excel downloads automatically after completion.</p>
    </form>
  );
}
