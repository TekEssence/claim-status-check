import type { FormEvent } from "react";
import { Play } from "lucide-react";
import { AerialSharedInputFields } from "./common/AerialSharedInputFields";
import type { AerialSubportal } from "./common/types";
import { aerialSubportals, getAerialSubportal } from "./subportals/registry";

export type { AerialSubportal } from "./common/types";

export function AerialInputForm({
  canSubmit,
  credentialFileName,
  inputFileName,
  isProcessing,
  selectedSubportal,
  onCredentialFileChange,
  onInputFileChange,
  onSubportalChange,
  onSubmit,
}: {
  canSubmit: boolean;
  credentialFileName?: string;
  inputFileName?: string;
  isProcessing: boolean;
  selectedSubportal: AerialSubportal | null;
  onCredentialFileChange: (file: File | null) => void;
  onInputFileChange: (file: File | null) => void;
  onSubportalChange: (subportal: AerialSubportal) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const selectedSubportalDefinition = getAerialSubportal(selectedSubportal);

  return (
    <form className="space-y-5" onSubmit={onSubmit}>
      <fieldset disabled={isProcessing}>
        <legend className="text-sm font-semibold text-slate-800">Select Aerial subportal</legend>
        <p className="mt-1 text-sm text-slate-500">The selected row in the login workbook will be used only for this run.</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {aerialSubportals.map((subportal) => {
            const selected = selectedSubportal === subportal.id;
            return (
              <button
                key={subportal.id}
                type="button"
                aria-pressed={selected}
                onClick={() => onSubportalChange(subportal.id)}
                className={`rounded-[1.1rem] border px-4 py-3 text-left transition ${
                  selected
                    ? "border-blue-500 bg-blue-50 text-blue-800 shadow-sm"
                    : "border-slate-200 bg-white text-slate-700 hover:border-blue-300 hover:bg-blue-50/40"
                }`}
              >
                <span className="block text-sm font-semibold">{subportal.label}</span>
                <span className="mt-1 block text-xs text-slate-500">{subportal.description}</span>
              </button>
            );
          })}
        </div>
      </fieldset>
      {selectedSubportalDefinition ? (
        <AerialSharedInputFields
          credentialFileName={credentialFileName}
          inputFileName={inputFileName}
          onCredentialFileChange={onCredentialFileChange}
          onInputFileChange={onInputFileChange}
          subportal={selectedSubportalDefinition}
        />
      ) : (
        <div className="rounded-[1.1rem] border border-dashed border-slate-300 bg-slate-50 px-5 py-6 text-center text-sm text-slate-600">
          Choose PMG or Citrus Valley to continue with the file uploads.
        </div>
      )}
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
