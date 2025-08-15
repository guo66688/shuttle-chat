// src/App.jsx
import React, { useState, useRef, useEffect } from 'react';
import Chat, { Bubble, Avatar, useMessages } from '@chatui/core';
import '@chatui/core/dist/index.css';
import { LeftOutlined, ReloadOutlined, AudioOutlined, SendOutlined } from '@ant-design/icons';

import CollapsiblePanel from './components/CollapsiblePanel';
import { RasaSSEClient } from './sseClient';
import { sendToSSEWebhook } from './api';

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

export default function App() {
  const { messages, appendMsg } = useMessages([]);
  const [inputVal, setInputVal] = useState('');
  const [thinking, setThinking] = useState([]);
  const [sending, setSending] = useState(false); // 改动①：移除 currentGen

  const sseRef = useRef(null);
  const lastUserTextRef = useRef('');
  const activeStreamKeyRef = useRef(null);
  const hasStreamBubbleRef = useRef(false);
  const [streamTextMap, setStreamTextMap] = useState({});

  // 卸载清理
  useEffect(() => {
    return () => {
      if (sseRef.current) {
        try {
          sseRef.current.close();
        } catch (e) {
          console.error('SSE close failed', e);
        }
      }
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

    // 流式气泡：用 map 中实时文本
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
  const handleSendMsg = async (text) => {
    const content = text?.trim();
    if (!content || sending) return;
    setSending(true);
    lastUserTextRef.current = content;

    appendMsg({ type: 'text', content: { text: content }, position: 'right', avatar: userAvatar });
    setInputVal('');

    const genId = safeUUID();
    setThinking([]); // 改动②：删除 setCurrentGen(genId)
    activeStreamKeyRef.current = genId;
    hasStreamBubbleRef.current = false;
    setStreamTextMap((prev) => {
      const n = { ...prev };
      delete n[genId];
      return n;
    });

    if (sseRef.current) sseRef.current.close();
    sseRef.current = new RasaSSEClient({
      senderId: SESSION_SENDER,

      onUserEcho: (line) => setThinking((prev) => [...prev, `> ${line}`]),

      onToken: (piece) => {
        const key = activeStreamKeyRef.current;
        if (!key) return;

        // 首次 token：插入空气泡
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

        // 累加文本
        setStreamTextMap((prev) => ({ ...prev, [key]: (prev[key] || '') + piece }));
      },

      onBotMessage: (payload) => {
        // 过滤用户回显
        if (payload?.text) {
          const t = String(payload.text || '').trim();
          const u = String(lastUserTextRef.current || '').trim();
          if (!payload.assistant_id && t === u) {
            setThinking((prev) => [...prev, '[skip] 用户原话回显']);
            return;
          }
        }

        // 流式完成：更新同一气泡
        if (hasStreamBubbleRef.current && activeStreamKeyRef.current && payload?.text) {
          const key = activeStreamKeyRef.current;
          setStreamTextMap((prev) => ({ ...prev, [key]: payload.text }));
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

      onTrace: (info) => setThinking((prev) => [...prev, `[trace] ${JSON.stringify(info)}`]),

      onDone: async (meta) => {
        hasStreamBubbleRef.current = false;
        if (meta?.timeout) {
          try {
            await sendToSSEWebhook(content, SESSION_SENDER, genId);
          } catch {
            appendMsg({ type: 'text', content: { text: '网络错误（兜底失败）' }, position: 'left', avatar: botAvatar });
            setThinking((prev) => [...prev, '[error] 兜底 /webhook 调用失败']);
          }
        }
        setSending(false);
      },

      onError: (err) => setThinking((prev) => [...prev, `[sse-error] ${err?.message || err}`]),
    });

    try {
      // ① 先等待 /stream 成功连接
      await sseRef.current.open({ fallbackAfterMs: 8000 });
      setThinking((prev) => ['[sse] 已连通 /stream', ...prev]);

      // ② 再 POST /webhook
      await sendToSSEWebhook(content, SESSION_SENDER, genId);
    } catch (e) {
      appendMsg({ type: 'text', content: { text: '发送失败：无法连接后端 /webhook' }, position: 'left', avatar: botAvatar });
      setThinking((prev) => [...prev, `[http-error] ${e?.message || e}`]);
      setSending(false);
    }
  };

  const onSendClick = () => handleSendMsg(inputVal);
  const onKeyDown = (e) => { // 改动③：支持 Enter 发送、Shift+Enter 换行
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMsg(inputVal);
    }
  };
  const handleQuickReply = (q) => handleSendMsg(q);

  // ---------------- UI ----------------
  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      <aside style={{ width: 200, background: '#F7F8FA', padding: 20 }}>
        <img src="/images/logo.png" alt="logo" style={{ width: 32, marginBottom: 16 }} />
        <h2>班车客服</h2>
      </aside>

      <div style={{ flex: 1, display: 'flex', background: '#E5E5E5' }}>
        <div style={{ flex: 1, display: 'flex' }}>
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
              }}
            >
              <LeftOutlined style={{ fontSize: 18, marginRight: 16 }} />
              <div style={{ flex: 1, textAlign: 'center' }}>智能客服小助手</div>
              <ReloadOutlined style={{ fontSize: 18, marginLeft: 16 }} />
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
    </div>
  );
}
