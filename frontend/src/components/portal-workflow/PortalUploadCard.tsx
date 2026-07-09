"use client";

import { useState, type DragEvent } from "react";
import { CheckCircle2, CloudUpload, FolderOpen, type LucideIcon } from "lucide-react";

type SharedProps = {
  acceptedFormats: string;
  description: string;
  fileName?: string;
  icon?: LucideIcon;
  sizeHint: string;
  title: string;
  helperText?: string;
  optional?: boolean;
};

type FileModeProps = SharedProps & {
  mode: "file";
  accept: string;
  inputId: string;
  onFileSelect: (file: File | null) => void;
};

type ActionModeProps = SharedProps & {
  mode: "action";
  actionLabel?: string;
  onAction: () => void;
};

type PortalUploadCardProps = FileModeProps | ActionModeProps;

export function PortalUploadCard(props: PortalUploadCardProps) {
  const [isDragging, setIsDragging] = useState(false);
  const Icon = props.icon ?? CloudUpload;
  const hasFile = Boolean(props.fileName);

  function onDragOver(event: DragEvent<HTMLLabelElement>) {
    if (props.mode !== "file") return;
    event.preventDefault();
    setIsDragging(true);
  }

  function onDragLeave(event: DragEvent<HTMLLabelElement>) {
    if (props.mode !== "file") return;
    event.preventDefault();
    setIsDragging(false);
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    if (props.mode !== "file") return;
    event.preventDefault();
    setIsDragging(false);
    props.onFileSelect(event.dataTransfer.files?.[0] ?? null);
  }

  return (
    <div className="rounded-[1.2rem] border border-sky-100 bg-[linear-gradient(180deg,rgba(255,255,255,0.98)_0%,rgba(244,249,255,0.96)_100%)] p-3.5 shadow-[0_12px_26px_rgba(148,163,184,0.1)] transition duration-200 hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-[0_16px_32px_rgba(59,130,246,0.1)]">
      <div className="flex items-start justify-between gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-[0.9rem] bg-[linear-gradient(180deg,#dbeafe_0%,#bfdbfe_100%)] text-blue-700 shadow-inner">
          <Icon className="h-4 w-4" strokeWidth={2.1} />
        </div>
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[0.68rem] font-semibold ${
            hasFile ? "bg-emerald-50 text-emerald-600" : "bg-sky-50 text-sky-700"
          }`}
        >
          {hasFile ? <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2.4} /> : null}
          {hasFile ? "Uploaded" : props.optional ? "Optional" : "Pending"}
        </span>
      </div>

      <h3 className="mt-2.5 text-[0.98rem] font-semibold tracking-[-0.03em] text-slate-950">{props.title}</h3>
      <p className="mt-1 text-[0.92rem] leading-5 text-slate-600">{props.description}</p>

      {props.mode === "file" ? (
        <>
          <input
            id={props.inputId}
            type="file"
            accept={props.accept}
            onChange={(event) => props.onFileSelect(event.target.files?.[0] ?? null)}
            className="hidden"
          />
          <label
            htmlFor={props.inputId}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            className={`mt-2.5 block cursor-pointer rounded-[0.95rem] border border-dashed px-3.5 py-2.5 text-center transition ${
              isDragging
                ? "border-blue-500 bg-blue-50/80 shadow-[0_0_0_6px_rgba(59,130,246,0.08)]"
                : hasFile
                  ? "border-emerald-200 bg-emerald-50/55"
                  : "border-sky-200 bg-white/80 hover:border-blue-400 hover:bg-blue-50/45"
            }`}
          >
            <CloudUpload className="mx-auto h-5 w-5 text-blue-600" strokeWidth={2.1} />
            <p className="mt-2 text-sm font-medium text-slate-800">
              Drag and drop your file here
            </p>
            <p className="mt-0.5 text-[0.7rem] text-slate-500">or use the button below to browse</p>
            <span className="mt-2.5 inline-flex items-center rounded-full bg-[linear-gradient(90deg,#eff6ff_0%,#dbeafe_100%)] px-3 py-1.5 text-[0.92rem] font-semibold text-blue-700 shadow-sm">
              Browse File
            </span>
          </label>
        </>
      ) : (
        <button
          type="button"
          onClick={props.onAction}
          className="mt-2.5 flex w-full items-center justify-center rounded-[0.95rem] border border-dashed border-sky-200 bg-white/80 px-3.5 py-2.5 text-center transition hover:border-blue-400 hover:bg-blue-50/45"
        >
          <span>
            <FolderOpen className="mx-auto h-5 w-5 text-blue-600" strokeWidth={2.1} />
            <span className="mt-2 block text-sm font-medium text-slate-800">
              Select the workbook to update in place
            </span>
            <span className="mt-0.5 block text-[0.7rem] text-slate-500">Chrome or Edge required for secure file access</span>
            <span className="mt-2.5 inline-flex items-center rounded-full bg-[linear-gradient(90deg,#eff6ff_0%,#dbeafe_100%)] px-3 py-1.5 text-[0.92rem] font-semibold text-blue-700 shadow-sm">
              {props.actionLabel ?? "Browse File"}
            </span>
          </span>
        </button>
      )}

      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-[0.7rem] text-slate-500">
        <span>Accepted: {props.acceptedFormats}</span>
        <span>Max size: {props.sizeHint}</span>
      </div>

      {props.fileName ? (
        <div className="mt-2.5 rounded-[0.9rem] border border-emerald-100 bg-emerald-50/70 px-3 py-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">Ready</p>
              <p className="mt-1 truncate text-sm font-medium text-slate-800">{props.fileName}</p>
            </div>
            <span className="rounded-full bg-white/80 px-2 py-1 text-[0.7rem] font-semibold text-emerald-700">100%</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/80">
            <div className="h-full w-full rounded-full bg-[linear-gradient(90deg,#10b981_0%,#34d399_100%)]" />
          </div>
        </div>
      ) : null}

      {props.helperText ? <p className="mt-2 text-[0.7rem] leading-4 text-slate-500">{props.helperText}</p> : null}
    </div>
  );
}
