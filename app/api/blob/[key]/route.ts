import { getBlob } from "@/lib/blob-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  const { key } = await params;

  if (!key) {
    return new Response("Missing blob key", { status: 400 });
  }

  const blob = getBlob(key);
  if (!blob) {
    return new Response("Blob not found or expired", { status: 404 });
  }

  const body = typeof blob.data === "string"
    ? blob.data
    : new Uint8Array(blob.data);
  return new Response(body, {
    headers: {
      "Content-Type": blob.contentType,
      "Cache-Control": "no-store",
    },
  });
}
