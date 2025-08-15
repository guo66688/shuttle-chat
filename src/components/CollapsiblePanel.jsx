// src/components/CollapsiblePanel.jsx
import React, { useState } from 'react';

export default function CollapsiblePanel({ title = '过程', lines = [] }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ background: '#FAFAFA', border: '1px solid #EEE', borderRadius: 8, marginBottom: 8 }}>
      <div style={{ padding: '8px 12px', cursor: 'pointer', userSelect: 'none' }} onClick={() => setOpen(v => !v)}>
        <span style={{ fontWeight: 600 }}>{title}</span>
        <span style={{ float: 'right', opacity: 0.7 }}>{open ? '收起' : '展开'}</span>
      </div>
      {open && (
        <div style={{ padding: '8px 12px', maxHeight: 160, overflow: 'auto', fontSize: 12, color: '#666' }}>
          {lines.map((l, i) => <div key={i} style={{ whiteSpace: 'pre-wrap' }}>{l}</div>)}
        </div>
      )}
    </div>
  );
}
