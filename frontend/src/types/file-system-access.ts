export type FilePickerAcceptType = {
  description?: string;
  accept: Record<string, string[]>;
};

export type FileSystemPermissionMode = "read" | "readwrite";
export type FileSystemPermissionState = "granted" | "denied" | "prompt";

export type FileSystemFileHandle = {
  getFile(): Promise<File>;
  queryPermission(options?: { mode?: FileSystemPermissionMode }): Promise<FileSystemPermissionState>;
  requestPermission(options?: { mode?: FileSystemPermissionMode }): Promise<FileSystemPermissionState>;
  createWritable(): Promise<FileSystemWritableFileStream>;
};

export type WindowWithFilePicker = Window & {
  showOpenFilePicker?: (options?: {
    types?: FilePickerAcceptType[];
    excludeAcceptAllOption?: boolean;
    multiple?: boolean;
  }) => Promise<FileSystemFileHandle[]>;
};
