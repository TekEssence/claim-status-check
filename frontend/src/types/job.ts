export type ClaimRow = Record<string, unknown> & {
  __original_index: number;
};

export type JobProgressValue = {
  completed: number;
  total: number;
};

export type ErrorScreenshot = {
  index: number;
  image: string;
};

export type ScrapeJobEvent = {
  type?: string;
  message?: string;
  completed?: number;
  total?: number;
  index?: number;
  image?: string;
  html?: string;
  base64?: string;
  filename?: string;
  mimeType?: string;
  path?: string;
  update?: Record<string, unknown>;
};
