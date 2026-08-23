ALTER TABLE public.generated_images
  ADD COLUMN IF NOT EXISTS aspect_ratio text,
  ADD COLUMN IF NOT EXISTS queue_time_ms integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS generation_time_ms integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fallback_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS estimated_cost numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS success boolean NOT NULL DEFAULT true;

INSERT INTO storage.buckets (id, name, public)
VALUES ('images', 'images', true)
ON CONFLICT (id) DO UPDATE SET public = true;

CREATE POLICY "Users can upload generated images"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'images' AND (storage.foldername(name))[1] = 'generated' AND (storage.foldername(name))[2] = auth.uid()::text);

CREATE POLICY "Users can manage generated images"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'images' AND (storage.foldername(name))[1] = 'generated' AND (storage.foldername(name))[2] = auth.uid()::text);

CREATE POLICY "Generated images are publicly readable"
  ON storage.objects FOR SELECT TO public
  USING (bucket_id = 'images');