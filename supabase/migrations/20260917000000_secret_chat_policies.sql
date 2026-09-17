CREATE POLICY "Secret participants can insert messages"
  ON public.secret_messages FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = sender_id
    AND receiver_id IN (
      SELECT auth.users.id
      FROM auth.users
      WHERE auth.users.email = ANY (
        ARRAY[
          current_setting('app.secret_chat_email_1', true),
          current_setting('app.secret_chat_email_2', true)
        ]
      )
    )
  );

CREATE POLICY "Secret participants can update read receipts"
  ON public.secret_messages FOR UPDATE TO authenticated
  USING (auth.uid() = sender_id OR auth.uid() = receiver_id)
  WITH CHECK (
    auth.uid() = sender_id OR auth.uid() = receiver_id
  );

CREATE POLICY "Secret participants can delete their own messages"
  ON public.secret_messages FOR DELETE TO authenticated
  USING (auth.uid() = sender_id);
