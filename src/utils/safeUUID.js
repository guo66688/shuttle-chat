// src/utils/safeUUID.js
export function safeUUID() {
  try {
    if (window?.crypto?.randomUUID) return window.crypto.randomUUID();
  } catch {console.error( 'crypto.randomUUID failed, falling back to custom UUID generation');
  } 
  // 退化方案：时间 + 随机数（够用来做前端去重/标识）
  return 'u_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}
