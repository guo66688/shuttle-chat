// src/api.js
// 与 Rasa 的 HTTP 接口交互：REST webhook（非流式） & 自定义 SSE webhook（触发上游流式）
// 说明：事件名不匹配问题主要出在 SSE 客户端，这里仅保持参数与服务端一致。

import axios from 'axios';
const ORIGIN = (typeof window !== 'undefined' && window.location && window.location.origin) ? window.location.origin : '';
const ENV_BASE = (typeof window !== 'undefined' && import.meta.env && (import.meta.env.VITE_RASA_BASE || import.meta.env.REACT_APP_RASA_BASE)) || '';
const BASE = (ENV_BASE || ORIGIN || 'http://192.168.18.13:5005');

// Rasa RESTInput（默认通道）：非流式
export function sendToRasa(msg, sender = 'demo_user', genId, extraMeta = {}) {
  return axios.post(`${BASE}/webhooks/rest/webhook`, {
    sender,
    message: msg,
    metadata: { gen_id: genId, ...extraMeta },
  });
}

// 自定义 SSEInputChannel（已在 credentials.yml 启用 custom_channels.sse）
// 注意：这里是“触发后端拉取上游并扇出到 /stream”，前端需要用 EventSource 订阅 /stream
export function sendToSSEWebhook(msg, sender = 'demo_user', genId, extraMeta = {}) {
  return axios.post(
    `${BASE}/webhooks/sse/webhook`,
    {
      sender,
      gen_id: genId,
      text: msg, // 自定义通道是 text 字段
      metadata: { gen_id: genId, ...extraMeta }, // 服务端会透传 gen_id/generation_id
    },
    { timeout: 30000 }
  );
}
