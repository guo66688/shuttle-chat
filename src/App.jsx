// path: src/App.jsx
import React, { useState, useRef, useEffect } from 'react';
import Chat, { Bubble, Avatar, useMessages } from '@chatui/core';
import '@chatui/core/dist/index.css';
import { LeftOutlined, ReloadOutlined, AudioOutlined, SendOutlined } from '@ant-design/icons';

import CollapsiblePanel from './components/CollapsiblePanel';
import { RasaSSEClient } from './sseClient';
import { sendToSSEWebhook } from './api';

// ========== 调试模式（嵌入 devtools: eruda） ==========
const DEBUG_MODE = /(?:\?|&)debug=1\b/.test(window.location.search) ||
  localStorage.getItem('debug_mode') === '1';

function setDebugMode(on) {
  if (on) localStorage.setItem('debug_mode', '1');
  else localStorage.removeItem('debug_mode');
  window.location.reload();
}

async function initEruda() {
  try {
    const mod = await import(/* webpackChunkName: "eruda" */ 'eruda');
    const eruda = mod?.default || mod;
    if (!eruda._isInit) {
      eruda.init({ tool: ['console','elements','resources','network','info'], defaults: { displaySize: 50, transparency: 0.95 } });
      // try {
      //   const n = await import('eruda-network');
      //   eruda.add(n.default || n);
      // } catch(e) {console.warn('Failed to load eruda-network:', e);}
    }
    console.log('%c[DEBUG] eruda inited', 'color:#0a0');
  } catch (e) {
    console.warn('[DEBUG] 加载 eruda 失败：', e);
  }
}

// ---------- 工具：安全 UUID ----------
function safeUUID() {
  try {
    if (window?.crypto?.randomUUID) return window.crypto.randomUUID();
  } catch {
    console.error('crypto.randomUUID failed, falling back to custom UUID generation');
  }
  return 'u_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

// 头像和 Logo
const botAvatar = '/images/bot-avatar.png';
const userAvatar = '/images/user-avatar.png';

// 快捷提问
const QUICK_QUESTIONS = ['如何查看班车时刻表', '如何预约座位', '班车路线'];

// sender_id
const SESSION_SENDER =
  sessionStorage.getItem('sender_id') ||
  (() => {
    const id = `user_${safeUUID()}`;
    sessionStorage.setItem('sender_id', id);
    return id;
  })();

// ========== 看门狗（流式兜底，防止 done 丢失导致 sending 不复位） ==========
const STREAM_GUARD_MS = 12000; // 手机端建议 12~20s，可按需调整

function makeGuard() {
  let timer = null;
  return {
    kick(ms = STREAM_GUARD_MS, onTimeout) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(onTimeout, ms);
    },
    clear() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

export default function App() {
  const { messages, appendMsg } = useMessages([]);
  const [inputVal, setInputVal] = useState('');
  const [thinking, setThinking] = useState([]);
  const [sending, setSending] = useState(false);

  const sseRef = useRef(null);
  const lastUserTextRef = useRef('');
  const activeStreamKeyRef = useRef(null);
  const hasStreamBubbleRef = useRef(false);
  const [streamTextMap, setStreamTextMap] = useState({});
  const guardRef = useRef(makeGuard());
  
  function createSSEClient(genId) {
    const client = new RasaSSEClient({
      senderId: SESSION_SENDER,

      onUserEcho: (line) => {
        DEBUG_MODE && console.log('[SSE][message]', line);
        setThinking((prev) => [...prev, `> ${line}`]);
        guardRef.current.kick(STREAM_GUARD_MS, handleStreamTimeout);
      },

      onToken: (piece) => {
        DEBUG_MODE && console.log('[SSE][token]', piece);
        guardRef.current.kick(STREAM_GUARD_MS, handleStreamTimeout);

        const key = activeStreamKeyRef.current;
        if (!key || key !== genId) return;

        if (!hasStreamBubbleRef.current) {
          appendMsg({
            type: 'text',
            content: { text: '' },
            position: 'left',
            avatar: botAvatar,
            meta: { streaming: true, streamKey: key },
          });
          hasStreamBubbleRef.current = true;
        }
        setStreamTextMap((prev) => ({ ...prev, [key]: (prev[key] || '') + piece }));
      },

      onBotMessage: (payload) => {
        DEBUG_MODE && console.log('[SSE][bot]', payload);
        guardRef.current.kick(STREAM_GUARD_MS, handleStreamTimeout);

        if (payload?.text) {
          const t = String(payload.text || '').trim();
          const u = String(lastUserTextRef.current || '').trim();
          if (!payload.assistant_id && t === u) {
            setThinking((prev) => [...prev, '[skip] 用户原话回显']);
            return;
          }
        }
        if (hasStreamBubbleRef.current && activeStreamKeyRef.current === genId && payload?.text) {
          setStreamTextMap((prev) => ({ ...prev, [genId]: payload.text }));
          hasStreamBubbleRef.current = false;
          return;
        }
        if (payload?.text) {
          appendMsg({ type: 'text', content: { text: payload.text }, position: 'left', avatar: botAvatar });
        } else if (payload?.image) {
          appendMsg({ type: 'image', content: { picUrl: payload.image }, position: 'left', avatar: botAvatar });
        } else if (payload?.attachment || payload?.custom) {
          setThinking((prev) => [...prev, JSON.stringify(payload.attachment || payload.custom)]);
        }
      },

      onTrace: (info) => {
        DEBUG_MODE && console.log('[SSE][trace]', info);
        guardRef.current.kick(STREAM_GUARD_MS, handleStreamTimeout);
        setThinking((prev) => [...prev, `[trace] ${JSON.stringify(info)}`]);
      },

      onDone: () => {
        DEBUG_MODE && console.log('[SSE][done]');
        guardRef.current.clear();
        finalizeStreamDueTo('done event');
      },

      onError: (err) => {
        DEBUG_MODE && console.log('[SSE][error]', err);
        // 错误后短暂等待是否还有事件；若没有会触发看门狗兜底
        guardRef.current.kick(STREAM_GUARD_MS, handleStreamTimeout);
        setThinking((prev) => [...prev, `[sse-error] ${err?.message || err}`]);
      },
    });

    return client;
  }


  // ======== 统一收尾：看门狗触发或确实 done 时都会走这里 ========
  function finalizeStreamDueTo(reason) {
    DEBUG_MODE && console.log('[FINALIZE]', reason);
    try { sseRef.current?.close?.(); } catch(e) {console.error('Failed to close SSE:', e);}
    sseRef.current = null;           // 关键：本轮结束后置空，下一轮会重新 create + open
    hasStreamBubbleRef.current = false;
    setSending(false);
    setThinking((prev) => [...prev, `[finalize] ${reason}`]);
  }
  function handleStreamTimeout() {
    finalizeStreamDueTo('no events within guard window');
    guardRef.current.clear();
  }
  useEffect(() => {
    return () => {
      try { sseRef.current?.close?.(); } catch(e) { console.error('Failed to close SSE on unmount:', e); }
      guardRef.current.clear();
    };
  }, []);
  // ----------- 渲染消息 -----------
  const renderMessageContent = (msg) => {
    const isUser = msg.position === 'right';

    if (msg.type === 'image' && msg.content?.picUrl) {
      return (
        <div style={{ maxWidth: 280 }}>
          <img src={msg.content.picUrl} alt="image" style={{ width: '100%', borderRadius: 8 }} />
        </div>
      );
    }

    let text = msg.content?.text ?? '';
    if (msg?.meta?.streaming && msg?.meta?.streamKey) {
      const t = streamTextMap[msg.meta.streamKey];
      if (typeof t === 'string') text = t;
    }

    return (
      <Bubble
        content={text}
        style={{
          backgroundColor: isUser ? '#6C1FBF' : '#F0F0F0',
          color: isUser ? '#FFF' : '#000',
          borderRadius: '12px',
          padding: '8px 12px',
          maxWidth: '70%',
        }}
      />
    );
  };

  const renderAvatar = (msg) => (
    <Avatar size="small" src={msg.position === 'left' ? botAvatar : userAvatar} style={{ margin: '0 8px' }} />
  );

  // ----------- 发送消息 -----------
  // 4) handleSendMsg：在这里“每轮打开 SSE → 成功后再 POST /webhook”
  async function handleSendMsg(text) {
    const content = text?.trim();
    if (!content || sending) return;
    setSending(true);
    lastUserTextRef.current = content;

    appendMsg({ type: 'text', content: { text: content }, position: 'right', avatar: userAvatar });
    setInputVal('');

    const genId = safeUUID();
    setThinking([]);
    activeStreamKeyRef.current = genId;
    hasStreamBubbleRef.current = false;
    setStreamTextMap((prev) => {
      const n = { ...prev };
      delete n[genId];
      return n;
    });

    // —— 每轮新建 SSE —— //
    sseRef.current = createSSEClient(genId);

    try {
      DEBUG_MODE && console.log('[SSE] open per-turn /stream');
      await sseRef.current.open({ reconnectMs: 0 });   // 每轮不自动重连，失败就走降级
      // open 成功：踢狗等待首事件
      guardRef.current.kick(STREAM_GUARD_MS, handleStreamTimeout);

      DEBUG_MODE && console.log('[HTTP] POST /webhooks/sse/webhook', { content, sender: SESSION_SENDER, genId });
      await sendToSSEWebhook(content, SESSION_SENDER, genId);

      // 解锁交由 onDone 或看门狗
    } catch (e) {
      // 订阅失败 → 尝试降级：发非流式接口（如果你有）
      try { sseRef.current?.close?.(); } catch {}
      sseRef.current = null;
      guardRef.current.clear();

      setThinking((prev) => [...prev, `[http-error] ${e?.message || e}`]);

      // 可选：如果后端支持非流式（例如 /webhook?stream=0 或 /webhook_sync）
      // 你可以在这里做一次同步降级请求，然后把完整文本 append 出去：
      // try {
      //   const full = await sendToSSEWebhook(content, SESSION_SENDER, genId, { stream: false });
      //   appendMsg({ type: 'text', content: { text: full?.text || '（非流式回复）' }, position: 'left', avatar: botAvatar });
      // } catch (e2) {
      //   appendMsg({ type: 'text', content: { text: '发送失败：无法连接后端 /webhook' }, position: 'left', avatar: botAvatar });
      // }

      // 目前保持原行为：
      appendMsg({ type: 'text', content: { text: '发送失败：无法连接后端 /webhook' }, position: 'left', avatar: botAvatar });
      setSending(false);
    }
  }


  const onSendClick = () => handleSendMsg(inputVal);
  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMsg(inputVal);
    }
  };
  const handleQuickReply = (q) => handleSendMsg(q);

  // ---------------- UI（已移除左侧侧边栏，聊天区域全宽） ----------------
  return (
    <div style={{ display: 'flex', height: '100vh', background: '#E5E5E5' }}>
      <div style={{ flex: 1, display: 'flex', padding: 16 }}>
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            background: '#FFF',
            borderRadius: 8,
            overflow: 'hidden',
            boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
          }}
        >
          {/* 顶部 */}
          <div
            style={{
              height: 48,
              display: 'flex',
              alignItems: 'center',
              padding: '0 16px',
              background: '#6C1FBF',
              color: '#FFF',
              fontSize: 16,
              fontWeight: 500,
              position: 'relative',
            }}
          >
            <LeftOutlined style={{ fontSize: 18, marginRight: 16 }} />
            <div style={{ flex: 1, textAlign: 'center' }}>智能客服小助手</div>
            <ReloadOutlined style={{ fontSize: 18, marginLeft: 16 }} />

            {/* 调试开关按钮 */}
            <button
              type="button"
              onClick={() => setDebugMode(!DEBUG_MODE)}
              style={{
                position: 'absolute',
                right: 48,
                top: 8,
                height: 32,
                padding: '0 10px',
                borderRadius: 16,
                fontSize: 12,
                border: '1px solid rgba(255,255,255,0.6)',
                background: DEBUG_MODE ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)',
                color: '#fff',
                cursor: 'pointer',
              }}
              title={DEBUG_MODE ? '关闭调试（将移除localStorage并刷新）' : '打开调试（会写入localStorage并刷新）'}
            >
              {DEBUG_MODE ? '调试已开' : '打开调试'}
            </button>
          </div>

          {/* 聊天主体 */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '16px 0' }}>
            <Chat
              messages={messages}
              renderMessageContent={renderMessageContent}
              renderAvatar={renderAvatar}
              navbar={null}
              inputable={false}
              style={{ minHeight: '100%' }}
            />
          </div>

          {/* 底部 */}
          <div style={{ padding: '8px 16px' }}>
            <CollapsiblePanel title="过程" lines={thinking} />

            <div style={{ display: 'flex', marginBottom: 8, overflowX: 'auto' }}>
              {QUICK_QUESTIONS.map((q) => (
                <div
                  key={q}
                  onClick={() => handleQuickReply(q)}
                  style={{
                    whiteSpace: 'nowrap',
                    padding: '6px 12px',
                    border: '1px solid #DDD',
                    borderRadius: 20,
                    fontSize: 12,
                    color: '#333',
                    marginRight: 8,
                    cursor: 'pointer',
                    userSelect: 'none',
                  }}
                >
                  {q}
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', alignItems: 'center' }}>
              <AudioOutlined style={{ fontSize: 24, color: '#666', marginRight: 12 }} />
              <input
                type="text"
                value={inputVal}
                onChange={(e) => setInputVal(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="输入问题..."
                style={{
                  flex: 1,
                  border: '1px solid #DDD',
                  borderRadius: 20,
                  padding: '8px 12px',
                  outline: 'none',
                  fontSize: 14,
                  marginRight: 12,
                }}
              />
              <button
                type="button"
                onClick={onSendClick}
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: '50%',
                  background: '#6C1FBF',
                  border: 'none',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                }}
              >
                <SendOutlined style={{ color: '#FFF', fontSize: 18 }} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
