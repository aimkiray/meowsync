const { Router } = require('express');
const http = require('http');
const https = require('https');

const router = Router();

// 音频代理：用于转发 googlevideo 等需要服务端 IP 的音频流
router.get('/audio-proxy', (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ error: 'missing url' });

  let parsed;
  try { parsed = new URL(targetUrl); } catch { return res.status(400).json({ error: 'invalid url' }); }
  if (!parsed.hostname.endsWith('googlevideo.com')) {
    return res.status(403).json({ error: 'forbidden host' });
  }

  const proxyHeaders = { 'User-Agent': 'Mozilla/5.0' };
  if (req.headers['range']) proxyHeaders['Range'] = req.headers['range'];

  const mod = parsed.protocol === 'https:' ? https : http;
  const proxyReq = mod.request(targetUrl, { headers: proxyHeaders }, (proxyRes) => {
    const resHeaders = {
      'Content-Type': proxyRes.headers['content-type'] || 'audio/mp4',
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
    };
    if (proxyRes.headers['content-length']) resHeaders['Content-Length'] = proxyRes.headers['content-length'];
    if (proxyRes.headers['content-range']) resHeaders['Content-Range'] = proxyRes.headers['content-range'];
    res.writeHead(proxyRes.statusCode, resHeaders);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (e) => res.status(502).json({ error: e.message }));
  proxyReq.end();
});

module.exports = router;
