// path: vite.config.js
 import { defineConfig } from 'vite'
 import react from '@vitejs/plugin-react'

 // https://vite.dev/config/
 export default defineConfig({
   plugins: [react()],
   server: {
     proxy: {
       // 其他 /webhooks 路由按需保留，这里单独把 SSE 路由特殊对待
       '/webhooks/sse/stream': {
         target: 'http://192.168.18.13:5005',
         changeOrigin: true,
         ws: false,            // SSE 不是 WebSocket
         secure: false,
         // —— 关键：禁用上游压缩，避免“尾包”被代理攒住
         headers: { 'Accept-Encoding': 'identity' },
         // —— 关键：不让 dev 代理超时/收尾
         proxyTimeout: 0,
         timeout: 0,
         // —— 关键：在响应头上再保险，阻止中间层“优化/变换”
         configure: (proxy) => {
           proxy.on('proxyRes', (proxyRes) => {
             try {
              // 有些链路看这些头才老实
              proxyRes.headers['cache-control'] = 'no-cache, no-transform';
              proxyRes.headers['x-accel-buffering'] = 'no';
              // 避免出现 Content-Length 导致中间节点按长度截断
              delete proxyRes.headers['content-length'];
              // 不要 chunked 的声明（移动端上偶发粘包/延迟刷出）
              delete proxyRes.headers['transfer-encoding'];
              // 明确告诉下游是 SSE
              proxyRes.headers['content-type'] = 'text/event-stream; charset=utf-8';
            } catch (e) {
              console.error('SSE proxyRes 处理失败', e);
            }
          });
        },
      },
      // 其他 REST 路由（可选）
       '/webhooks': {
         target: 'http://192.168.18.13:5005',
         changeOrigin: true,
         secure: false,
         ws: false,
       },
     },
   },
 })
