// src/sseClient.js
// Rasa SSE 前端客户端（方案A：依赖 EventSource 自动重连 & 修正事件名）
// - 移除“静默期超时计时器”策略，避免把正常的无消息时段误判为超时
// - 统一监听服务端实际会发的事件名：token / trace / done / text / image / attachment / custom
// - 支持通过 URL 参数传递 reconnect_ms（即使后端未读取，也不影响功能）

const BASE = 'http://192.168.18.13:5005';     // Rasa 服务地址
const SSE_PATH = '/webhooks/sse/stream';      // SSE 订阅端点（GET）

function makeCid() {
  try { return crypto?.randomUUID?.() } catch (e) { console.error('Failed to generate CID:', e); }  
  return Math.random().toString(36).slice(2);
}

export class RasaSSEClient {
  constructor({
    senderId,
    onUserEcho,   // （可选）处理默认 event 的兜底（多数情况下不会用到）
    onBotMessage, // 接收 text/image/attachment/custom 等聚合回调
    onTrace,      // 接收 trace 事件
    onToken,      // 逐 token 回调
    onDone,       // 流结束
    onError,      // 网络/连接错误
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
    this._opened = false; // 标记是否已成功 onopen
  }

  /**
   * 建立 SSE 连接。
   * - 依赖 EventSource 自带自动重连（服务端会下发 retry 指令；即便没有，也会退回到默认策略）
   * - 不再使用“静默期超时计时器”，避免误判
   * @param {{ reconnectMs?: number }} opts
   * @returns {Promise<void>} onopen 后 resolve；若首连失败则 reject
   */
  open({ reconnectMs = 1000 } = {}) {
    return new Promise((resolve, reject) => {
      this.cid = makeCid();

      // 组装 URL：/webhooks/sse/stream?sender_id=...&cid=...&reconnect_ms=...
      const url = new URL(`${BASE}${SSE_PATH}`);
      url.searchParams.set('sender_id', this.senderId);
      url.searchParams.set('cid', this.cid);
      url.searchParams.set('reconnect_ms', String(reconnectMs));

      // 创建 EventSource
      this.es = new EventSource(url.toString());

      // --- 连接生命周期 ---
      this.es.onopen = () => {
        this._opened = true;
        resolve(); // 首次打开成功
      };

      // 注意：onerror 在网络抖动和自动重连过程中会被频繁触发
      // 我们：首连失败 => reject；已连通过后 => 仅通知 onError，不主动关闭，让 EventSource 自己重连
      this.es.onerror = (err) => {
        if (!this._opened) {
          reject(err instanceof Error ? err : new Error('SSE failed to open'));
        }
        this.onError?.(err);
        // 不 close；交给 EventSource 自动重连
      };

      // --- 默认消息 onmessage（一般不会用到） ---
      this.es.onmessage = (e) => {
        // 服务端大多不会用默认 event，但保留兜底
        this.onUserEcho?.(e.data);
      };

      // --- 逐 token ---
      this.es.addEventListener('token', (e) => {
        try {
          const payload = JSON.parse(e.data || '{}');
          this.onToken?.(payload.text ?? payload.token ?? '', payload);
        } catch {
          this.onToken?.(e.data ?? '', {});
        }
      });

      // --- 诊断/阶段信息 ---
      this.es.addEventListener('trace', (e) => {
        try {
          const info = JSON.parse(e.data || '{}');
          this.onTrace?.(info);
        } catch (err) {
          console.error('SSE trace 解析失败', err);
        }
      });

      // --- 结束 ---
      this.es.addEventListener('done', () => {
        this.onDone?.();
        // 不关闭，由上层决定是否复用连接（通常一次对话一次 done 即可关闭）
      });

      // --- 文本与其他消息：与服务端对齐的事件名 ---
      for (const ev of ['text', 'image', 'attachment', 'custom']) {
        this.es.addEventListener(ev, (e) => {
          try {
            const payload = JSON.parse(e.data || '{}');
            this.onBotMessage?.(payload);
          } catch {
            // 文本兜底
            this.onBotMessage?.({ type: ev, text: e.data });
          }
        });
      }
    });
  }

  /**
   * 关闭连接（由上层在合适时机调用）
   */
  close() {
    if (this.es) {
      try { this.es.close(); } catch (e) { console.error('Failed to close SSE:', e); }
      this.es = null;
    }
    this._opened = false;
  }

  /**
   * 当前是否处于已打开（曾 onopen 成功）状态
   */
  isOpen() {
    return !!this.es && this._opened;
  }
}
