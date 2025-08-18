// src/sseClient.js
// Rasa SSE 前端客户端（方案A：依赖 EventSource 自动重连 & 修正事件名）
// - 移除“静默期超时计时器”策略，避免把正常的无消息时段误判为超时
// - 统一监听服务端实际会发的事件名：token / trace / done / text / image / attachment / custom
// - 支持通过 URL 参数传递 reconnect_ms（即使后端未读取，也不影响功能）

const BASE = 'http://192.168.18.13:5005';     // Rasa 服务地址
const SSE_PATH = '/webhooks/sse/stream';      // SSE 订阅端点（GET）

// function makeCid() {
//   try { return crypto?.randomUUID?.() } catch (e) { console.error('Failed to generate CID:', e); }  
//   return Math.random().toString(36).slice(2);
// }

export class RasaSSEClient {
  constructor({
    senderId,
    onUserEcho,
    onBotMessage,
    onTrace,
    onToken,
    onDone,
    onError,
  }) {
    this.senderId = senderId;
    this.onUserEcho = onUserEcho;
    this.onBotMessage = onBotMessage;
    this.onTrace = onTrace;
    this.onToken = onToken;
    this.onDone = onDone;
    this.onError = onError;

    this.es = null;
    this.cid = null;
    this._opened = false;
  }

  // 仅此处的默认值从 1000 → 2000
  open({ reconnectMs = 2000 } = {}) {
    return new Promise((resolve, reject) => {
      this.cid = (crypto?.randomUUID?.() || Math.random().toString(36).slice(2));

      const url = new URL(`${BASE}${SSE_PATH}`);
      url.searchParams.set('sender_id', this.senderId);
      url.searchParams.set('cid', this.cid);
      url.searchParams.set('reconnect_ms', String(reconnectMs));

      this.es = new EventSource(url.toString());

      this.es.onopen = () => {
        this._opened = true;
        resolve();
      };

      this.es.onerror = (err) => {
        if (!this._opened) reject(err instanceof Error ? err : new Error('SSE failed to open'));
        this.onError?.(err);
      };

      this.es.onmessage = (e) => this.onUserEcho?.(e.data);

      this.es.addEventListener('token', (e) => {
        try {
          const payload = JSON.parse(e.data || '{}');
          this.onToken?.(payload.text ?? payload.token ?? '', payload);
        } catch {
          this.onToken?.(e.data ?? '', {});
        }
      });

      this.es.addEventListener('trace', (e) => {
        try { this.onTrace?.(JSON.parse(e.data || '{}')); }
        catch (err) { console.error('SSE trace 解析失败', err); }
      });

      this.es.addEventListener('done', () => this.onDone?.());

      for (const ev of ['text', 'image', 'attachment', 'custom']) {
        this.es.addEventListener(ev, (e) => {
          try { this.onBotMessage?.(JSON.parse(e.data || '{}')); }
          catch { this.onBotMessage?.({ type: ev, text: e.data }); }
        });
      }
    });
  }

  close() { try { this.es?.close(); } catch (e) { console.error('Failed to close SSE:', e); } this.es = null; this._opened = false; }
  isOpen() { return !!this.es && this._opened; }
}
