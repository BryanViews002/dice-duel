'use client';

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { createClient } from '@/lib/supabase/client';
import type { ChatMessage } from '@/lib/types';

const EMOTES = ['🔥', '😂', '😭', '🎲', '👏', '🧊', '🤝', '💀'] as const;

export function Chat({
  matchId,
  meId,
  meName,
  themName,
}: {
  matchId: string;
  meId: string;
  meName: string;
  themName: string;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const supabase = createClient();
    let alive = true;

    supabase
      .from('chat_messages')
      .select('*')
      .eq('match_id', matchId)
      .order('created_at')
      .then(({ data }) => {
        if (alive && data) setMessages(data as ChatMessage[]);
      });

    const channel = supabase
      .channel(`chat:${matchId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: `match_id=eq.${matchId}` },
        (payload) => setMessages((prev) => [...prev, payload.new as ChatMessage]),
      )
      .subscribe();

    return () => {
      alive = false;
      supabase.removeChannel(channel);
    };
  }, [matchId]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  async function send(body: string | null, emote: string | null) {
    setError(null);
    const { error } = await createClient().rpc('send_chat', {
      p_match_id: matchId,
      p_body: body,
      p_emote: emote,
    });
    if (error) setError(error.message);
  }

  return (
    <div className="surface flex h-full flex-col overflow-hidden">
      <div className="border-b border-felt-800 px-5 py-3">
        <span className="eyebrow">Table talk</span>
      </div>

      <div ref={scroller} className="flex-1 space-y-2.5 overflow-y-auto px-5 py-4">
        {messages.length === 0 && (
          <p className="py-8 text-center text-[13px] text-ivory-dim/35">
            Say something to {themName}.
          </p>
        )}
        <AnimatePresence initial={false}>
          {messages.map((m) => {
            const mine = m.player_id === meId;
            return (
              <motion.div
                key={m.id}
                initial={{ opacity: 0, y: 8, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                className={`flex ${mine ? 'justify-end' : 'justify-start'}`}
              >
                {m.emote ? (
                  <span className="text-3xl leading-none" title={mine ? meName : themName}>
                    {m.emote}
                  </span>
                ) : (
                  <span
                    className={`max-w-[85%] break-words rounded-2xl px-3.5 py-2 text-[13.5px] leading-relaxed ${
                      mine
                        ? 'rounded-br-sm bg-brass-500/16 text-ivory'
                        : 'rounded-bl-sm bg-felt-800 text-ivory-dim'
                    }`}
                  >
                    {m.body}
                  </span>
                )}
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

      <div className="flex gap-0.5 border-t border-felt-800 px-3.5 py-2.5">
        {EMOTES.map((e) => (
          <button
            key={e}
            onClick={() => send(null, e)}
            className="rounded-md px-1.5 py-1 text-[17px] transition-transform hover:scale-[1.35]"
            aria-label={`send ${e}`}
          >
            {e}
          </button>
        ))}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const text = draft.trim();
          if (!text) return;
          setDraft('');
          void send(text, null);
        }}
        className="flex gap-2 border-t border-felt-800 p-3.5"
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={300}
          placeholder="Message…"
          className="min-w-0 flex-1 rounded-lg border border-felt-700 bg-felt-950/60 px-3.5 py-2 text-[13.5px] outline-none transition-colors placeholder:text-ivory-dim/25 focus:border-brass-500/70"
        />
        <button
          type="submit"
          className="btn-ghost px-3.5 text-[13px] hover:border-brass-500/60 hover:text-ivory"
        >
          Send
        </button>
      </form>

      {error && <p className="px-4 pb-2.5 text-[12px] text-oxblood">{error}</p>}
    </div>
  );
}
