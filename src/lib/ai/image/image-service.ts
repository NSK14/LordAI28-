// Server-side image service: the thin orchestration layer the API routes call.
//
// It ties the provider-agnostic router to gallery persistence (Supabase). The
// route is responsible only for auth, parsing, and serializing the wire body —
// all image logic lives here or below it. Generation and persistence are kept
// independent: if the database write fails we still return the image to the user.

import { routeImageRequest } from "./image-router";
import type { ImageGenerationRequest, ImageGenerationResult } from "./image-types";
import { createStructuredLogger } from "../shared/structured-logger";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

const log = createStructuredLogger("image:service");

/** Run the router and return the normalized result (falls back within Cloudflare). */
export async function generateImage(
  request: ImageGenerationRequest,
): Promise<ImageGenerationResult> {
  return routeImageRequest(request);
}

export type ImageDbClient = SupabaseClient<Database>;

export interface PersistImageOptions {
  supabase: ImageDbClient;
  userId: string;
  conversationId?: string | null;
  projectId?: string | null;
}

export interface PersistResult {
  persisted: boolean;
  savedIds: string[];
  error?: string;
}

const IMAGE_BUCKET = "images";

function dataUrlToUpload(url: string): { bytes: Uint8Array; contentType: string } {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(url);
  if (!match) throw new Error("Generated image is not a base64 data URL.");
  return { bytes: Buffer.from(match[2], "base64"), contentType: match[1] };
}

function extensionFor(contentType: string): string {
  const extension = contentType.split("/")[1]?.toLowerCase();
  return extension === "jpeg" ? "jpg" : extension && /^[a-z0-9]+$/.test(extension) ? extension : "png";
}

async function uploadGeneratedImage(
  supabase: ImageDbClient,
  userId: string,
  requestId: string,
  index: number,
  dataUrl: string,
): Promise<{ path: string; publicUrl: string }> {
  const { bytes, contentType } = dataUrlToUpload(dataUrl);
  const path = `generated/${userId}/${requestId}-${index}.${extensionFor(contentType)}`;
  const { error: uploadError } = await supabase.storage.from(IMAGE_BUCKET).upload(path, bytes, {
    contentType,
    upsert: false,
  });
  if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`);
  const { data } = supabase.storage.from(IMAGE_BUCKET).getPublicUrl(path);
  if (!data.publicUrl) {
    await supabase.storage.from(IMAGE_BUCKET).remove([path]);
    throw new Error("Storage did not return a public image URL.");
  }
  return { path, publicUrl: data.publicUrl };
}

/**
 * Record a generation in the gallery. Failure here never loses the image: the
 * route still returns `persisted: false` with the data URLs attached.
 */
export async function persistImages(
  result: ImageGenerationResult,
  options: PersistImageOptions,
): Promise<PersistResult> {
  const { supabase, userId, conversationId, projectId } = options;
  const savedIds: string[] = [];

  try {
    if (projectId) {
      const { data: project } = await supabase
        .from("projects")
        .select("id")
        .eq("id", projectId)
        .eq("user_id", userId)
        .maybeSingle();
      if (!project) return { persisted: false, savedIds, error: "Project unavailable." };
    }
    if (conversationId) {
      const { data: conversation } = await supabase
        .from("conversations")
        .select("id")
        .eq("id", conversationId)
        .eq("user_id", userId)
        .maybeSingle();
      if (!conversation) return { persisted: false, savedIds, error: "Conversation unavailable." };
    }

    for (let i = 0; i < result.images.length; i += 1) {
      const uploaded = await uploadGeneratedImage(supabase, userId, result.requestId, i, result.images[i]);
      let messageId: string | null = null;
      if (conversationId) {
        const { data: message, error: messageError } = await supabase
          .from("messages")
          .insert({
            conversation_id: conversationId,
            user_id: userId,
            role: "assistant",
            message_type: "image",
            content: uploaded.publicUrl,
            model: result.model,
            project_id: projectId ?? null,
          })
          .select("id")
          .single();
        if (messageError) {
          await supabase.storage.from(IMAGE_BUCKET).remove([uploaded.path]);
          return { persisted: false, savedIds, error: "Could not attach image." };
        }
        messageId = message.id;
      }
      const { data: row, error: recordError } = await supabase
        .from("generated_images")
        .insert({
          user_id: userId,
          project_id: projectId ?? null,
          conversation_id: conversationId ?? null,
          message_id: messageId,
          prompt: result.prompt,
          revised_prompt: result.enhancedPrompt,
          negative_prompt: result.negativePrompt ?? null,
          model: result.model,
          provider: result.provider,
          width: result.width,
          height: result.height,
          seed: result.seed != null ? result.seed + i : null,
          image_url: uploaded.publicUrl,
          aspect_ratio: result.aspectRatio,
          queue_time_ms: result.queueTimeMs,
          generation_time_ms: result.generationTimeMs,
          retry_count: result.retryCount,
          fallback_count: result.fallbackCount,
          estimated_cost: result.estimatedCost,
          success: true,
        })
        .select("id")
        .single();
      if (recordError) {
        await supabase.storage.from(IMAGE_BUCKET).remove([uploaded.path]);
        if (messageId) await supabase.from("messages").delete().eq("id", messageId);
        return { persisted: false, savedIds, error: "Could not save image." };
      }
      savedIds.push(row.id);
    }

    return { persisted: true, savedIds };
  } catch (error) {
    log.error("persist_failed", { requestId: result.requestId, error: (error as Error)?.message });
    return { persisted: false, savedIds, error: "Could not save image." };
  }
}
