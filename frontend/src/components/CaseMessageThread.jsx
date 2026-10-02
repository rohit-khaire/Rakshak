import React, { useEffect, useRef, useState } from 'react';
import api from '../api/client';
import { useAuth } from '../context/AuthContext.jsx';

// Family <-> assigned officer, scoped to one case. Unlike the internal
// DySP<->PSI thread, there's no reply-gating here — a family member
// reaching out about their own case, or an officer with an update,
// are both normal and expected at any time.
export default function CaseMessageThread({ caseId }) {
  const { user } = useAuth();
  const [messages, setMessages] = useState([]);
  const [officer, setOfficer] = useState(null);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const bottomRef = useRef(null);

  const load = async () => {
    try {
      const { data } = await api.get(`/messages/case/${caseId}/thread`);
      setMessages(data.messages);
      setOfficer(data.officer);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load messages.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [caseId]); // eslint-disable-line
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  const send = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    setSending(true);
    setError('');
    try {
      await api.post(`/messages/case/${caseId}`, { message: text.trim() });
      setText('');
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not send that — try again.');
    } finally {
      setSending(false);
    }
  };

  if (loading) return <p className="muted">Loading…</p>;

  return (
    <div>
      {officer && (
        <p className="muted" style={{ fontSize: 13 }}>
          Handling officer: <strong>{officer.name}</strong>{officer.phone && <> · <a href={`tel:${officer.phone}`}>{officer.phone}</a></>}
        </p>
      )}
      {error && <p className="error-text" style={{ fontSize: 13 }}>{error}</p>}

      <div style={{ maxHeight: 360, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, margin: '10px 0', padding: '4px 2px' }}>
        {messages.length === 0 ? (
          <p className="muted" style={{ fontSize: 13 }}>No messages yet — you can reach out any time.</p>
        ) : (
          messages.map((m) => {
            const isMine = String(m.from?._id || m.from) === String(user._id);
            return (
              <div key={m._id} style={{ alignSelf: isMine ? 'flex-end' : 'flex-start', maxWidth: '80%' }}>
                {!isMine && m.from?.name && <p className="muted" style={{ fontSize: 10.5, margin: '0 4px 2px' }}>{m.from.name}</p>}
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

      <form onSubmit={send} style={{ display: 'flex', gap: 6 }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Message the handling officer…" style={{ flex: 1 }} disabled={sending} />
        <button className="btn btn-primary" disabled={sending} style={{ padding: '8px 14px' }}>{sending ? '…' : 'Send'}</button>
      </form>
    </div>
  );
}
