import { z } from "zod";
import { LORD_MODES, type LordMode } from "@/lib/ai/models";

export const MODE_ENUM = LORD_MODES as [LordMode, ...LordMode[]];

export const ChatRequestSchema = z.object({
  messages: z
    .array(
      z
        .object({
          role: z.enum(["user", "assistant", "system"]),
          parts: z.array(z.unknown()).max(100),
        })
        .passthrough(),
    )
    .min(1)
    .max(100),
  mode: z.enum(MODE_ENUM).optional(),
  modelId: z.string().min(1).optional(),
  context: z
    .object({
      page: z.string().max(200).optional(),
      workflow: z.string().max(200).nullable().optional(),
      projectId: z.string().uuid().optional().nullable(),
    })
    .passthrough()
    .optional(),
});

// Trim overly long provider error messages so we never echo raw secrets or
// giant payloads back to the client or into structured logs.
export function sanitizeProviderMessage(message?: string): string | undefined {
  if (!message) return undefined;
  const trimmed = message.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return "Provider returned an error. Reference ID: " + crypto.randomUUID().slice(0, 8);
  }
  if (trimmed.length > 200) {
    return trimmed.slice(0, 200) + "...";
  }
  return trimmed;
}
