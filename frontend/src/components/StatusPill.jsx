import React from 'react';

const STATUS_LABELS = {
  emergency_pending: 'Emergency — Pending FIR',
  verified: 'Verified',
  under_search: 'Under Search',
  found: 'Found',
  closed: 'Closed',
};

export default function StatusPill({ status }) {
  return <span className={`status-pill status-${status}`}>{STATUS_LABELS[status] || status}</span>;
}
