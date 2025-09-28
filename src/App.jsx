// src/App.jsx
// 修复 eslint no-unused-vars：移除未使用的 node/e 变量；其余逻辑与 remark 插件方案一致

import React, { useState, useRef, useEffect } from 'react';
import Chat, { Bubble, Avatar, useMessages } from '@chatui/core';
import '@chatui/core/dist/index.css';
import { LeftOutlined, ReloadOutlined, AudioOutlined, SendOutlined } from '@ant-design/icons';

import CollapsiblePanel from './components/CollapsiblePanel';
import { RasaSSEClient } from './sseClient';
import { sendToSSEWebhook } from './api';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';

// 自定义 remark 插件（AST 级清洗/规整）
import remarkRemoveSystemLines from './markdown/remark-remove-system-lines';
import remarkPlanHeading from './markdown/remark-plan-heading';
import remarkTypography from './markdown/remark-typography';

// ========== 调试模式（嵌入 devtools: eruda） ==========
async function initEruda() {
  try {
    const mod = await import(/* webpackChunkName: "eruda" */ 'eruda');
    const eruda = mod?.default || mod;
    if (!eruda._isInit) {
      eruda.init({
        tool: ['console', 'elements', 'resources', 'network', 'info'],
        defaults: { displaySize: 50, transparency: 0.95 },
      });
    }
    // 可选：这里不打印 e，避免 no-unused-vars
    // console.log('[DEBUG] eruda inited');
  } catch {
    // 静默忽略，避免 no-unused-vars
  }
}
function initDebugFromEnv() {
  return /(?:\?|&)debug=1\b/.test(window.location.search) || localStorage.getItem('debug_mode') === '1';
}

// ---------- 工具：安全 UUID ----------
function safeUUID() {
  try {
    if (window?.crypto?.randomUUID) return window.crypto.randomUUID();
  } catch {
    // ignore
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

// ✅ 最小化“最终文本规范化”——只做 CRLF→LF 与 trim（清洗交给 remark）
function normalizeFinalText(s) {
  if (!s) return '';
  return String(s).replace(/\r\n?/g, '\n').trim();
}

// ========== 看门狗（流式兜底，防止 done 丢失导致 sending 不复位） ==========
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

function asPlugin(mod) {
  if (typeof mod === 'function') return mod;
  if (mod && typeof mod.default === 'function') return mod.default;
  return null;
}
const GFM = asPlugin(remarkGfm);
const BREAKS = asPlugin(remarkBreaks);

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

  const lastTokenAtRef = useRef(0);
  const quietTimerRef = useRef(null);
  const QUIET_MS = 10000; // 10s 无 token 且收到 ping -> 认为已完成（仅收尾，不落盘）
  const streamTextMapRef = useRef({});
  useEffect(() => {
    streamTextMapRef.current = streamTextMap;
  }, [streamTextMap]);
  const committedKeysRef = useRef(new Set()); // 防止重复固化

  function commitStream(genId, overrideText) {
    if (!genId || committedKeysRef.current.has(genId)) return;
    const raw = overrideText ?? streamTextMapRef.current[genId] ?? '';
    const finalText = normalizeFinalText(raw);
    if (!finalText) return; // 没内容就不落盘

    appendMsg({
      type: 'text',
      content: { text: finalText },
      position: 'left',
      avatar: botAvatar,
    });
    // 清空占位，避免“历史流式气泡”继续占屏
    setStreamTextMap((prev) => ({ ...prev, [genId]: '' }));
    committedKeysRef.current.add(genId);
  }
  function kickQuietTimer() {
    if (quietTimerRef.current) clearTimeout(quietTimerRef.current);
    quietTimerRef.current = setTimeout(() => {
      // 只要这一轮确实收过事件且仍处于发送中，就静默收尾（不落盘）
      if (gotFirstEventRef.current && sending) {
        hasStreamBubbleRef.current = false;
        const key = activeStreamKeyRef.current;
        commitStream(key);
        finalizeStreamDueTo('quiet finalize');
        guardRef.current.clear();
      }
    }, QUIET_MS);
  }

  function createSSEClient(genId) {
    const client = new RasaSSEClient({
      senderId: SESSION_SENDER,

      onUserEcho: (line) => {
        gotFirstEventRef.current = true; // 收到首事件
        setThinking((prev) => [...prev, `> ${line}`]);
        guardRef.current.kick(STREAM_GUARD_MS, handleStreamTimeout);
      },

      onToken: (piece) => {
        gotFirstEventRef.current = true; // 收到首事件
        guardRef.current.kick(STREAM_GUARD_MS, handleStreamTimeout);
        lastTokenAtRef.current = Date.now();
        kickQuietTimer(); // 静默窗口计时，仅用于收尾，不负责落盘

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
        gotFirstEventRef.current = true; // 收到首事件
        guardRef.current.kick(STREAM_GUARD_MS, handleStreamTimeout);

        if (payload?.text) {
          const t = String(payload.text || '').trim();
          const u = String(lastUserTextRef.current || '').trim();
          if (!payload.assistant_id && t === u) {
            setThinking((prev) => [...prev, '[skip] 用户原话回显']);
            return;
          }
          // ☆ 关键：直接落盘一条“普通文本消息”（不依赖占位/commit）
          appendMsg({
            type: 'text',
            content: { text: normalizeFinalText(t) },
            position: 'left',
            avatar: botAvatar,
          });
          // 流式占位若存在，标记结束即可（不强求它参与显示）
          hasStreamBubbleRef.current = false;
          return;
        }

        if (payload?.image) {
          appendMsg({ type: 'image', content: { picUrl: payload.image }, position: 'left', avatar: botAvatar });
        } else if (payload?.attachment || payload?.custom) {
          setThinking((prev) => [...prev, JSON.stringify(payload.attachment || payload.custom)]);
        }
      },

      onTrace: (info) => {
        gotFirstEventRef.current = true; // 收到首事件
        guardRef.current.kick(STREAM_GUARD_MS, handleStreamTimeout);
        setThinking((prev) => [...prev, `[trace] ${JSON.stringify(info)}`]);
      },
      onPing: () => {
        const now = Date.now();
        // 若已出现“静默窗口”，立刻触发静默收尾计时器（很短）
        if (lastTokenAtRef.current && now - lastTokenAtRef.current >= QUIET_MS) {
          kickQuietTimer();
        }
      },
      onDone: () => {
        guardRef.current.clear();
        // 仅收尾，不落盘；展示内容完全依赖 token 累计或最终 text
        try {
          const key = activeStreamKeyRef.current;
          commitStream(key); // ☆ 新增：将当前流式文本固化为普通消息
          finalizeStreamDueTo('done event');
        } catch {
          setSending(false);
          hasStreamBubbleRef.current = false;
        }
      },

      onError: (err) => {
        guardRef.current.kick(STREAM_GUARD_MS, handleStreamTimeout);
        setThinking((prev) => [...prev, `[sse-error] ${err?.message || err}`]);
      },
    });

    return client;
  }

  function finalizeStreamDueTo(reason) {
    try {
      sseRef.current?.close?.();
    } catch {
      // ignore
    }
    if (quietTimerRef.current) {
      clearTimeout(quietTimerRef.current);
      quietTimerRef.current = null;
    }
    sseRef.current = null;
    hasStreamBubbleRef.current = false;
    setSending(false);
    setThinking((prev) => [...prev, `[finalize] ${reason}`]);
  }

  function handleStreamTimeout() {
    const reason = gotFirstEventRef.current ? 'no events within guard window' : 'no first event (likely not subscribed/blocked)';
    const key = activeStreamKeyRef.current;
    commitStream(key);
    finalizeStreamDueTo(`quiet finalize (${reason})`);
    guardRef.current.clear();
  }

  useEffect(() => {
    return () => {
      try {
        sseRef.current?.close?.();
      } catch {
        // ignore
      }
      guardRef.current.clear();
      if (quietTimerRef.current) {
        clearTimeout(quietTimerRef.current);
        quietTimerRef.current = null;
      }
      gotFirstEventRef.current = false; // 清理
      try {
        const eruda = window.eruda && (window.eruda.default || window.eruda);
        if (eruda && eruda.destroy) eruda.destroy();
      } catch {
        // ignore
      }
    };
  }, []);

  useEffect(() => {
    if (debugMode) {
      localStorage.setItem('debug_mode', '1');
      initEruda();
    } else {
      localStorage.removeItem('debug_mode');
      try {
        const eruda = window.eruda && (window.eruda.default || window.eruda);
        if (eruda && eruda.destroy) eruda.destroy();
      } catch {
        // ignore
      }
    }
  }, [debugMode]);

  // ----------- 发送消息 -----------
  async function handleSendMsg(text) {
    const content = text?.trim();
    if (!content) return;
    if (sending) return;
    setSending(true);
    lastUserTextRef.current = content;

    appendMsg({ type: 'text', content: { text: content }, position: 'right', avatar: userAvatar });
    setInputVal('');

    const genId = safeUUID();
    setThinking([]);
    activeStreamKeyRef.current = genId;
    hasStreamBubbleRef.current = false;
    gotFirstEventRef.current = false;
    setStreamTextMap((prev) => {
      const n = { ...prev };
      delete n[genId];
      return n;
    });

    sseRef.current = createSSEClient(genId);

    try {
      await sseRef.current.open({ reconnectMs: 2000 });
      await sendToSSEWebhook(content, SESSION_SENDER, genId);
    } catch {
      try {
        sseRef.current?.close?.();
      } catch {
        // ignore
      }
      sseRef.current = null;
      guardRef.current.clear();

      appendMsg({ type: 'text', content: { text: '发送失败：无法连接后端 /webhook' }, position: 'left', avatar: botAvatar });
      setSending(false);
    }
  }

  const renderMessageContent = (msg) => {
    const isUser = msg.position === 'right';

    // --- 流式占位：保留 pre-wrap，避免半截 Markdown 破版 ---
    const isStreaming = Boolean(msg?.meta?.streaming && msg?.meta?.streamKey);
    if (isStreaming) {
      const t = streamTextMap[msg.meta.streamKey] ?? '';
      return (
        <Bubble
          content={<div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{t}</div>}
          style={{
            backgroundColor: isUser ? '#6C1FBF' : '#F0F0F0',
            color: isUser ? '#FFF' : '#000',
            borderRadius: '12px',
            padding: '8px 12px',
            maxWidth: '70%',
          }}
        />
      );
    }

    // --- 最终消息：ReactMarkdown 渲染（清洗交给 remark 插件） ---
    const text = msg.content?.text ?? '';
    const node = (
      <div className="md" style={{ lineHeight: 1.6, wordBreak: 'break-word' }}>
        <ReactMarkdown
          remarkPlugins={[GFM, BREAKS, remarkRemoveSystemLines, remarkPlanHeading, remarkTypography].filter(Boolean)}
          components={{
            p: (props) => <p style={{ margin: '0.4em 0' }} {...props} />,
            li: (props) => <li style={{ margin: '0.3em 0' }} {...props} />,
            // ✅ 移除未使用的 node 形参，避免 eslint no-unused-vars
            a: (props) => <a {...props} target="_blank" rel="noopener noreferrer" />,
          }}
        >
          {text}
        </ReactMarkdown>
      </div>
    );

    return (
      <Bubble
        content={node}
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

  const onSendClick = () => {
    if (sending) return;
    handleSendMsg(inputVal);
  };
  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !sending) {
      e.preventDefault();
      handleSendMsg(inputVal);
    }
  };
  const handleQuickReply = (q) => {
    if (sending) return;
    handleSendMsg(q);
  };

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
                    cursor: sending ? 'not-allowed' : 'pointer',
                    opacity: sending ? 0.5 : 1,
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
                disabled={sending} // 🚫 单飞锁：按钮禁用
                aria-disabled={sending}
                title={sending ? '正在发送中，请稍候...' : '发送'}
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: '50%',
                  background: sending ? '#999' : '#6C1FBF',
                  border: 'none',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: sending ? 'not-allowed' : 'pointer',
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
