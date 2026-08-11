import { FileSpreadsheet, KeyRound } from "lucide-react";
import { PortalUploadCard } from "../../../../../components/portal-workflow/PortalUploadCard";
import type { AerialSubportalDefinition } from "./types";

export function AerialSharedInputFields({
  credentialFileName,
  inputFileName,
  onCredentialFileChange,
  onInputFileChange,
  subportal,
}: {
  credentialFileName?: string;
  inputFileName?: string;
  onCredentialFileChange: (file: File | null) => void;
  onInputFileChange: (file: File | null) => void;
  subportal: AerialSubportalDefinition;
}) {
  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <PortalUploadCard
        mode="file"
        accept=".xlsx,.xls,.csv"
        acceptedFormats=".xlsx, .xls, .csv"
        description={`Upload the credential workbook used for ${subportal.label}.`}
        fileName={credentialFileName}
        helperText={subportal.credentialHelperText}
        icon={KeyRound}
        inputId="aerialCredentialExcel"
        onFileSelect={onCredentialFileChange}
        sizeHint="10 MB"
        title="Upload Login File"
      />
      <PortalUploadCard
        mode="file"
        accept=".xlsx,.xls,.csv"
        acceptedFormats=".xlsx, .xls, .csv"
        description="Upload the claim details workbook that will be validated and processed automatically."
        fileName={inputFileName}
        icon={FileSpreadsheet}
        inputId="aerialInputExcel"
        onFileSelect={onInputFileChange}
        sizeHint="25 MB"
        title="Upload Claim File"
      />
    </div>
  );
}
