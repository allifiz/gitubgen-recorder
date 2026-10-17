import { utc } from "./database";
export function parseHistoryRequest(body: any) {
  if (!body || !Array.isArray(body.issueUrls) || !body.issueUrls.length)
    throw new Error("issueUrls wajib array URL.");
  if (body.issueUrls.length > 250)
    throw new Error("Maksimal 250 URL per request; pecah menjadi batch.");
  if (
    body.issueUrls.some(
      (v: unknown) =>
        typeof v !== "string" ||
        !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/[1-9]\d*\/?$/.test(
          v,
        ),
    )
  )
    throw new Error("issueUrls mengandung URL tidak valid.");
  const from = body.from == null ? undefined : utc(body.from),
    to = body.to == null ? undefined : utc(body.to);
  if (from && to && from >= to)
    throw new Error("from harus lebih kecil dari to (batas akhir eksklusif).");
  if (body.includeContext != null && typeof body.includeContext !== "boolean")
    throw new Error("includeContext wajib boolean.");
  return {
    issueUrls: [
      ...new Set<string>(
        body.issueUrls.map((s: string) => s.replace(/\/$/, "")),
      ),
    ],
    from,
    to,
    includeContext: !!body.includeContext,
  };
}
