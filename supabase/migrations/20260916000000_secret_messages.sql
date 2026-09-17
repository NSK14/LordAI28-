CREATE TABLE public.secret_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  receiver_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  message text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);

CREATE INDEX secret_messages_conversation_idx
  ON public.secret_messages (sender_id, receiver_id, created_at);

ALTER TABLE public.secret_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Secret participants can read messages"
  ON public.secret_messages FOR SELECT TO authenticated
  USING (auth.uid() = sender_id OR auth.uid() = receiver_id);

ALTER PUBLICATION supabase_realtime ADD TABLE public.secret_messages;