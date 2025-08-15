// src/api.js
import axios from 'axios';

const BASE = 'http://192.168.18.13:5005';

export function sendToRasa(msg, sender = 'demo_user', genId, extraMeta = {}) {
  return axios.post(`${BASE}/webhooks/rest/webhook`, {
    sender, message: msg, metadata: { gen_id: genId, ...extraMeta }
  });
}

// 兼容自定义通道（若已启用 credentials.yml 的 custom_channels.sse）：
export function sendToSSEWebhook(msg, sender = 'demo_user', genId, extraMeta = {}) {
  return axios.post(`${BASE}/webhooks/sse/webhook`, {
    sender,
    text: msg,                                               // text 字段
    metadata: { gen_id: genId, ...extraMeta }                // 服务端会用 gen_id/generation_id 透传
  }, { timeout: 30000 });
}