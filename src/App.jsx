// path: src/App.jsx
import React, { useState, useRef, useEffect } from 'react';
import Chat, { Bubble, Avatar, useMessages } from '@chatui/core';
import '@chatui/core/dist/index.css';
import { LeftOutlined, ReloadOutlined, AudioOutlined, SendOutlined } from '@ant-design/icons';

import CollapsiblePanel from './components/CollapsiblePanel';
import { RasaSSEClient } from './sseClient';
import { sendToSSEWebhook } from './api';

// ========== 调试模式（嵌入 devtools: eruda） ==========
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
function initDebugFromEnv() {
  return /(?:\?|&)debug=1\b/.test(window.location.search) ||
    localStorage.getItem('debug_mode') === '1';
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
// 原来 12000，改为 45000，更适合移动端/弱网
const STREAM_GUARD_MS = 45000;

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
  // 新增：首事件标记
  const gotFirstEventRef = useRef(false);
  const [debugMode, setDebugMode] = useState(initDebugFromEnv);
  


  function createSSEClient(genId) {
    const client = new RasaSSEClient({
      senderId: SESSION_SENDER,

      onUserEcho: (line) => {
        gotFirstEventRef.current = true;                      // ⭐ 收到首事件
        debugMode && console.log('[SSE][message]', line);
        setThinking((prev) => [...prev, `> ${line}`]);
        guardRef.current.kick(STREAM_GUARD_MS, handleStreamTimeout);
      },

      onToken: (piece) => {
        gotFirstEventRef.current = true;                      // ⭐ 收到首事件
        debugMode && console.log('[SSE][token]', piece);
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
        gotFirstEventRef.current = true;                      // ⭐ 收到首事件
        debugMode && console.log('[SSE][bot]', payload);
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
        gotFirstEventRef.current = true;                      // ⭐ 收到首事件
        debugMode && console.log('[SSE][trace]', info);
        guardRef.current.kick(STREAM_GUARD_MS, handleStreamTimeout);
        setThinking((prev) => [...prev, `[trace] ${JSON.stringify(info)}`]);
      },

      onDone: () => {
        debugMode && console.log('[SSE][done]');
        guardRef.current.clear();
        finalizeStreamDueTo('done event');
      },

      onError: (err) => {
        debugMode && console.log('[SSE][error]', err);
        // 错误后等待是否还有事件自动重连；仍由看门狗兜底
        guardRef.current.kick(STREAM_GUARD_MS, handleStreamTimeout);
        setThinking((prev) => [...prev, `[sse-error] ${err?.message || err}`]);
      },
    });

    return client;
  }

  function finalizeStreamDueTo(reason) {
    debugMode && console.log('[FINALIZE]', reason);
    try { sseRef.current?.close?.(); } catch(e) { console.error('Failed to close SSE:', e); }
    sseRef.current = null;
    hasStreamBubbleRef.current = false;
    setSending(false);
    setThinking((prev) => [...prev, `[finalize] ${reason}`]);
  }

  function handleStreamTimeout() {
    const reason = gotFirstEventRef.current
      ? 'no events within guard window'
      : 'no first event (likely not subscribed/blocked)';
    finalizeStreamDueTo(reason);
    guardRef.current.clear();
  }

  useEffect(() => {
    return () => {
      try { sseRef.current?.close?.(); } catch(e) { console.error('Failed to close SSE on unmount:', e); }
      guardRef.current.clear();
      gotFirstEventRef.current = false; // ⭐ 清理
      try { const eruda = (window.eruda && (window.eruda.default || window.eruda)); eruda && eruda.destroy && eruda.destroy(); } catch (e) { console.error('Failed to destroy eruda:', e); }
    };
  }, []);

  useEffect(() => {
    if (debugMode) {
      localStorage.setItem('debug_mode', '1');
      initEruda();
    } else {
      localStorage.removeItem('debug_mode');
      try {
        const eruda = (window.eruda && (window.eruda.default || window.eruda));
        eruda && eruda.destroy && eruda.destroy();
      } catch (e) {
        console.error('Failed to destroy eruda:', e);
      }
    }
  }, [debugMode]);

  // ----------- 发送消息 -----------
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
    gotFirstEventRef.current = false; // ⭐ 新一轮，重置“首事件”标记
    setStreamTextMap((prev) => { const n = { ...prev }; delete n[genId]; return n; });

    // —— 每轮新建 SSE —— //
    sseRef.current = createSSEClient(genId);

    try {
      debugMode && console.log('[SSE] open per-turn /stream');
      // 允许自动重连，避免弱网/切后台立刻失败
      await sseRef.current.open({ reconnectMs: 2000 });

      // ❌ 不要在 open 后立即 kick 看门狗（等待首事件触发 kick）
      // guardRef.current.kick(STREAM_GUARD_MS, handleStreamTimeout);

      debugMode && console.log('[HTTP] POST /webhooks/sse/webhook', { content, sender: SESSION_SENDER, genId });
      await sendToSSEWebhook(content, SESSION_SENDER, genId);
      // 后续由事件/看门狗/ done 控制收尾
    } catch (e) {
      try { sseRef.current?.close?.(); } catch (e){console.error('Failed to close SSE on error:', e);}
      sseRef.current = null;
      guardRef.current.clear();

      setThinking((prev) => [...prev, `[http-error] ${e?.message || e}`]);
      appendMsg({ type: 'text', content: { text: '发送失败：无法连接后端 /webhook' }, position: 'left', avatar: botAvatar });
      setSending(false);
    }
  }
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
              onClick={() => setDebugMode((prev) => !prev)}
              style={{
                position: 'absolute',
                right: 48,
                top: 8,
                height: 32,
                padding: '0 10px',
                borderRadius: 16,
                fontSize: 12,
                border: '1px solid rgba(255,255,255,0.6)',
                background: debugMode ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)',
                color: '#fff',
                cursor: 'pointer',
              }}
              title={debugMode ? '关闭调试（不会刷新，立即生效）' : '打开调试（不会刷新，立即生效）'}
            >
              {debugMode ? '调试已开' : '打开调试'}
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
