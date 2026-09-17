ALTER TABLE public.secret_messages
  ADD COLUMN IF NOT EXISTS seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS edited_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS secret_messages_created_at_idx
  ON public.secret_messages (created_at);

CREATE INDEX IF NOT EXISTS secret_messages_sender_receiver_idx
  ON public.secret_messages (sender_id, receiver_id);