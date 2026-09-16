import { authenticatedFetch } from "@/lib/authenticated-fetch";
import { getApiBaseUrl } from "@/lib/api-config";
import { streamTextLines } from "@/lib/stream-text-lines";

export async function streamChat(body: unknown, onDelta: (acc: string) => void): Promise<string> {
  const res = await authenticatedFetch(`${getApiBaseUrl()}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return streamTextLines(res, onDelta);
}
