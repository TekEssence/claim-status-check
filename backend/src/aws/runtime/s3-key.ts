export function buildWorkflowKey(params: {
  workflowId: string;
  jobId: string;
  area: "input" | "output";
  filename: string;
}) {
  const safeName = params.filename.replace(/\\/g, "/").split("/").filter(Boolean).pop() || "file";
  const date = new Date().toISOString().slice(0, 10);
  return `${params.workflowId}/${date}/${params.jobId}/${params.area}/${safeName.replace(/[^a-zA-Z0-9._=-]+/g, "_")}`;
}
