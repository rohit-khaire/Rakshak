import React, { useEffect, useState, useRef } from 'react';
import api from '../api/client';
import { useAuth } from '../context/AuthContext.jsx';

// A real conversation view — chat bubbles, auto-scroll, one shared
// component used from both sides: District Control opens this per
// officer from Officer Activity, a Police Admin sees their own copy
// of it (with their DySP as the other party) on the Messages page.
// type: 'call_logged' entries render as a centered system line rather
// than a bubble, so a logged call reads like "a call happened here"
// in the timeline, not like a message either side actually typed.
export default function MessageThread({ otherUserId, otherUserName, onClose }) {
  const { user } = useAuth();
  const [messages, setMessages] = useState([]);
  const [canReply, setCanReply] = useState(user.role === 'district_control');
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const bottomRef = useRef(null);

  const load = async () => {
    const { data } = await api.get(`/messages/thread/${otherUserId}`);
    setMessages(data.messages);
    setCanReply(data.canReply);
    setLoading(false);
  };

  useEffect(() => { load(); }, [otherUserId]); // eslint-disable-line
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  const send = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    setSending(true);
    try {
      await api.post('/messages', { to: otherUserId, message: text.trim() });
      setText('');
      await load();
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="card" style={{ maxWidth: 480 }}>
      <div className="topbar" style={{ marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>Conversation with {otherUserName}</h3>
        {onClose && <button className="btn btn-outline" style={{ padding: '4px 10px', fontSize: 12 }} onClick={onClose}>Close</button>}
      </div>

      <div style={{ maxHeight: 320, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12, padding: '4px 2px' }}>
        {loading ? (
          <p className="muted">Loading…</p>
        ) : messages.length === 0 ? (
          <p className="muted" style={{ fontSize: 13 }}>
            No messages yet. {user.role === 'police_admin' && 'Your District Control needs to message or call you first before you can reply.'}
          </p>
        ) : (
          messages.map((m) => {
            if (m.type === 'call_logged') {
              return (
                <p key={m._id} className="muted" style={{ textAlign: 'center', fontSize: 11.5, margin: '4px 0' }}>
                  📞 {m.message} · {new Date(m.createdAt).toLocaleString()}
                </p>
              );
            }
            const isMine = String(m.from) === String(user._id);
            return (
              <div key={m._id} style={{ alignSelf: isMine ? 'flex-end' : 'flex-start', maxWidth: '80%' }}>
                <div style={{
                  background: isMine ? 'var(--accent)' : 'var(--surface-raised)',
                  color: isMine ? '#1a1200' : 'var(--text)',
                  padding: '7px 11px', borderRadius: 10, fontSize: 13.5,
                }}>
                  {m.message}
                </div>
                <p className="muted" style={{ fontSize: 10.5, margin: '2px 4px 0', textAlign: isMine ? 'right' : 'left' }}>
                  {new Date(m.createdAt).toLocaleString()}
                </p>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>

      {canReply ? (
        <form onSubmit={send} style={{ display: 'flex', gap: 6 }}>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type a message…" style={{ flex: 1 }} disabled={sending} />
          <button className="btn btn-primary" disabled={sending} style={{ padding: '8px 14px' }}>{sending ? '…' : 'Send'}</button>
        </form>
      ) : (
        <p className="muted" style={{ fontSize: 12.5, textAlign: 'center' }}>
          You can reply once {otherUserName} messages or calls you first.
        </p>
      )}
    </div>
  );
}
