# Rasa SSE 前端

> 目标：用最少的改动把前端与 Rasa 的自定义 SSE 通道打通，统一事件名、稳定自动重连；并提供 REST（非流式）兜底。

---

## 一句话核心

前端通过 `EventSource` 订阅 `GET /webhooks/sse/stream`，并用 `POST /webhooks/sse/webhook` 触发上游处理；统一监听 `token/trace/done/text/image/attachment/custom` 事件名，去掉“静默期超时”的误判。

---

## 目录与文件

```
src/
  sseClient.js            # EventSource 客户端（自动重连、事件名统一）
  api.js                  # 发送消息到 Rasa（REST & 自定义 SSE webhook）
  utils/safeUUID.js       # 安全 UUID（带降级）
  markdown/
    remark-plan-heading.js        # 正则把“方案X（…）”提升为 ### 标题
    remark-remove-system-lines.js # 移除调试/系统噪声行（Observation/Thought/Action/AI:）
    remark-typography.js          # 微排版（如 → 两侧空格），自动跳过 code
  components/CollapsiblePanel.jsx # 折叠面板控件（用于回显 trace/过程）
```

---

## 快速开始

1）安装依赖并启动前端（Vite 为例）：

```bash
npm install
npm run dev
```

2）后端地址

* 开发环境：`http://127.0.0.1:5005`（`sseClient.js` 内置）
* 生产环境：同源 `/api`（可由网关反代到 Rasa）

3）启用自定义通道（后端 `credentials.yml` 示例）

```yaml
rest:

custom_channels.sse:
  # 若需要跨域或鉴权，自行在通道实现里处理
```

---

## 使用方式

### 1. 订阅 SSE

```js
import { RasaSSEClient } from './sseClient';

const sse = new RasaSSEClient({
  senderId: 'demo_user',
  onToken: (text, raw) => console.log('token:', text, raw),
  onTrace: (evt) => console.debug('trace:', evt),
  onBotMessage: (msg) => console.log('message:', msg),
  onDone: () => console.log('done'),
  onError: (err) => console.warn('sse error', err),
  onPing: (hb) => console.debug('ping', hb),
});

await sse.open({ reconnectMs: 2000 }); // 支持通过 URL 传递给后端，但即使未读取也不影响重连
```

**事件名**（统一监听）：

* `token`：模型增量 token（文本流）
* `trace`：流水线阶段/诊断信息
* `done`：一次会话流结束（去重处理避免重复收尾）
* `text` / `image` / `attachment` / `custom`：Rasa Message 事件
* `ping`：心跳（可视化 keep-alive）

> 设计要点：删除“静默期超时计时器”，避免正常无消息时段被误判；连接中断交由 `EventSource` 自带策略重连。

### 2. 触发处理（REST 与自定义 SSE webhook）

```js
import { sendToRasa, sendToSSEWebhook } from './api';

// A. 传统 REST（非流式）
await sendToRasa('你好', 'demo_user', 'gen-1', { ui: 'web' });

// B. 自定义 SSE webhook：触发上游处理，真正的流在 /stream
await sendToSSEWebhook('从图书馆到东门怎么走', 'demo_user', 'gen-2', { ui: 'web' });
```

### 3. 关闭连接

```js
sse.close();
```

---

## 关键实现点（前端）

### a) BASE 与路由

```js
const DEV = import.meta.env?.DEV;
const ORIGIN = typeof window !== 'undefined' ? window.location.origin : '';
const BASE = DEV ? 'http://127.0.0.1:5005' : ORIGIN + '/api';
const SSE_PATH = '/webhooks/sse/stream';
```

### b) 事件处理与去重

```js
let _doneFired = false;
this.es.addEventListener('done', (e) => {
  if (_doneFired) return; // 避免二次收尾
  _doneFired = true;
  this.onDone?.();
});
```

### c) 容错解析

```js
this.es.addEventListener('token', (e) => {
  try { const p = JSON.parse(e.data || '{}'); this.onToken?.(p.text ?? p.token ?? '', p); }
  catch { this.onToken?.(e.data ?? '', {}); }
});
```

---

## Markdown 渲染增强（可选）

在你的 Markdown 渲染链中添加三个 remark 插件：

```js
import remarkPlanHeading from './markdown/remark-plan-heading';
import remarkRemoveSystemLines from './markdown/remark-remove-system-lines';
import remarkTypography from './markdown/remark-typography';

const md = new MarkdownIt(/* ... */);
md.use(remarkPlanHeading);
md.use(remarkRemoveSystemLines);
md.use(remarkTypography);
```

* **plan-heading**：把 `方案1（描述）：` 或 `方案1：` 提升为 `###` 标题。
* **remove-system-lines**：丢弃仅包含 `Observation/Thought/Action/AI:` 的系统噪声段。
* **typography**：微排版（如 `→` 两侧自动加空格），自动跳过 `code/inlineCode`。

---

## UI 组件：CollapsiblePanel（可视化过程/trace）

```jsx
import CollapsiblePanel from './components/CollapsiblePanel';

<CollapsiblePanel title="过程" lines={["on_graph_start", "on_chain_end", "..."]} />
```

---

## 验证方式

### 本地联调步骤

1. 启动 Rasa（已启用 `custom_channels.sse`）。
2. 前端 `npm run dev` 后，在页面控制台观察：

   * 首帧 `onopen`，随后定期 `ping`。
   * 发送一条消息（SSE webhook），应收到 `trace` ➜ `token` 流，并以 `done` 结束。

### 最小用例（伪代码）

```js
const genId = safeUUID();
await sse.open();
await sendToSSEWebhook('从图书馆到东门怎么走', 'demo_user', genId);
// onToken 连续触发；最后 onDone 触发。
```

---

## 常见问题（FAQ）

* **CORS**：生产建议同源 `/api` 反代 Rasa；开发阶段可在 Rasa 端或网关放开 `Access-Control-Allow-Origin`。
* **Nginx 缓冲**：代理层需关闭 SSE 缓冲（如 `X-Accel-Buffering: no`）。
* **自动重连**：`EventSource` 自带；我们额外通过查询参传递 `reconnect_ms`，即使后端不读取也不影响前端行为。
* **重复 done**：已在前端去重，避免 UI 二次收尾。
* **静默期**：无消息≠错误，不再用前端计时器判定超时。

---

## 与后端配合要点（参考）

* 后端 SSE 建议统一发出 `event: token/trace/done`，并在 `trace` 中附带 `phase` 与 `node` 细节，利于调试与回放。
* 可在响应首帧发送 `retry: <ms>` 指示重连时间；主循环超时则发送注释心跳 `: ping`。
* 若网关可能断流，建议将 `done` 放入 `finally` 确保收尾。

---

## 提交信息建议（Conventional Commits）

* `feat(sse): add RasaSSEClient with unified event listeners`
* `fix(sse): ignore duplicated done event`
* `chore(markdown): add plan-heading/remove-system-lines/typography`
* `docs(readme): add SSE usage and faq`

---

## 变更影响与取舍

* **去掉静默计时器**：减少误判；代价是异常更依赖后端 `trace/error` 的明确信号。
* **固定事件名集合**：前端逻辑更简洁；代价是后端需遵循约定或在网关做映射。
* **BASE 策略**：开发直连、生产同源，避免跨域复杂度。

---

## 版本与兼容性

* 运行环境：现代浏览器（支持 `EventSource`）。
* 打包工具：Vite（`import.meta.env` 可替换为你项目的环境变量方案）。
