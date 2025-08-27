// src/sseClient.js
// Rasa SSE 前端客户端（方案A：依赖 EventSource 自动重连 & 修正事件名）
// - 移除“静默期超时计时器”策略，避免把正常的无消息时段误判为超时
// - 统一监听服务端实际会发的事件名：token / trace / done / text / image / attachment / custom
// - 支持通过 URL 参数传递 reconnect_ms（即使后端未读取，也不影响功能）

// dev 模式下走固定地址，否则走同源 /api
const DEV = import.meta.env?.DEV;   // Vite 下有这个变量
const ORIGIN = (typeof window !== 'undefined' && window.location && window.location.origin) ? window.location.origin : '';

const BASE = DEV
  ? "http://127.0.0.1:5005"   // ← 本地 Rasa SSE 服务地址
  : ORIGIN + "/api";

const SSE_PATH = "/webhooks/sse/stream";   // SSE 订阅端点（GET）

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
    onPing,
  }) {
    this.senderId = senderId;
    this.onUserEcho = onUserEcho;
    this.onBotMessage = onBotMessage;
    this.onTrace = onTrace;
    this.onToken = onToken;
    this.onDone = onDone;
    this.onError = onError;
    this.onPing = onPing;
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
      console.log('[SSE] connecting to', url.toString());

      this.es.onopen = () => {
        this._opened = true;
        // 0: CONNECTING, 1: OPEN, 2: CLOSED
        console.log('[SSE] onopen readyState=', this.es?.readyState);
        resolve();
      };

      this.es.onerror = (err) => {
        // 某些代理中断也会触发这里
        console.warn('[SSE] onerror readyState=', this.es?.readyState, err);
        if (!this._opened) reject(err instanceof Error ? err : new Error('SSE failed to open'));
        this.onError?.(err);
      };

      this.es.onmessage = (e) => {
        // 默认事件（无 event:），一般不用，但打印以便排查
        console.log('[SSE] (message)', e?.data?.slice?.(0, 120));
        this.onUserEcho?.(e.data);
      };

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

      // 忽略重复 done，避免 UI 二次收尾
      let _doneFired = false;
      this.es.addEventListener('done', (e) => {
        if (_doneFired) {
          console.log('[SSE] duplicate done ignored');
          return;
        }
        _doneFired = true;
        console.log('[SSE] done', e?.data);
        this.onDone?.();
      });

      // 可视化心跳，确认前端确实能收到首帧后的 keep-alive
      this.es.addEventListener('ping', (e) => {
        console.log('[SSE] ping', e?.data);
        try {
          const payload = e?.data ? JSON.parse(e.data) : {};
          this.onPing?.(payload);
        } catch {
          this.onPing?.({});
        }
      });

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
