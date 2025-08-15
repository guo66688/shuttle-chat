// src/sseClient.js
// src/sseClient.js
const BASE = 'http://192.168.18.13:5005';     // ← Rasa 服务地址
const SSE_PATH = '/webhooks/sse/stream';      // ← A2 订阅端点（GET）

function makeCid() {
  try { return crypto?.randomUUID?.() } catch (e) {
    console.error('crypto.randomUUID failed, falling back to custom CID generation', e);
  }
  return Math.random().toString(36).slice(2);
}

export class RasaSSEClient {
  constructor({
    senderId,
    onUserEcho,
    onBotMessage,
    onTrace,
    onToken,      // ← 新增：逐 token 回调
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
    this.timer = null;
  }

  /**
   * 建立 SSE 连接，返回 Promise，在 EventSource onopen 后 resolve。
   */
   // 增加 reconnectMs 参数，默认 1000；带上 cid
  open({ reconnectMs = 1000, fallbackAfterMs = 8000 } = {}) {
    return new Promise((resolve, reject) => {
      this.cid = makeCid();

      // 组装 URL：/webhooks/sse/stream?sender_id=...&cid=...&reconnect_ms=...
      const url = new URL(`${BASE}${SSE_PATH}`);
      url.searchParams.set('sender_id', this.senderId);
      url.searchParams.set('cid', this.cid);
      url.searchParams.set('reconnect_ms', String(reconnectMs));

      this.es = new EventSource(url.toString());

      const openTimer = setTimeout(() => {
        this.close();
        reject(new Error('SSE open timeout'));
      }, fallbackAfterMs);

      this.es.onopen = () => {
        clearTimeout(openTimer);
        resolve();
      };

      this.es.onerror = (err) => {
        clearTimeout(openTimer);
        this.onError?.(err);
        reject(err);
      };

      this.es.onmessage = (e) => {
        this.onUserEcho?.(e.data);
        this._bumpTimer(fallbackAfterMs);
      };

      this.es.addEventListener('bot_message', (e) => {
        this._bumpTimer(fallbackAfterMs);
        try {
          const payload = JSON.parse(e.data);
          if (payload?.trace) this.onTrace?.(payload.trace);
          this.onBotMessage?.(payload);
        } catch {
          this.onBotMessage?.({ type: 'text', text: e.data });
        }
      });

      this.es.addEventListener('token', (e) => {
        this._bumpTimer(fallbackAfterMs);
        try {
          const payload = JSON.parse(e.data);
          this.onToken?.(payload.text ?? '', payload);
        } catch {
          this.onToken?.(e.data ?? '', {});
        }
      });

      this.es.addEventListener('trace', (e) => {
        this._bumpTimer(fallbackAfterMs);
        try {
          const info = JSON.parse(e.data || '{}');
          this.onTrace?.(info);
        } catch (e) {
          console.error('SSE trace 解析失败', e);
        }
      });

      this.es.addEventListener('done', () => {
        this.onDone?.();
        this._clearTimer();
      });

      this._bumpTimer(fallbackAfterMs);
    });
  }

  close() {
    this._clearTimer();
    if (this.es) {
      this.es.close();
      this.es = null;
    }
  }

  _bumpTimer(ms) {
    this._clearTimer();
    if (ms > 0) {
      this.timer = setTimeout(() => {
        this.onError?.(new Error('SSE timeout; fallback to webhook'));
        this.onDone?.({ timeout: true });
      }, ms);
    }
  }

  _clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
