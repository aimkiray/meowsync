const { Router } = require('express');
const http = require('http');
const https = require('https');

const router = Router();

function proxyAudioRequest(targetUrl, clientReq, clientRes, redirectCount = 0) {
  if (redirectCount > 5) {
    clientRes.status(502).json({ error: 'too many redirects' });
    return;
  }

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    clientRes.status(400).json({ error: 'invalid url' });
    return;
  }

  if (!parsed.hostname.endsWith('googlevideo.com')) {
    clientRes.status(403).json({ error: 'forbidden host' });
    return;
  }

  const proxyHeaders = { 'User-Agent': 'Mozilla/5.0' };
  if (clientReq.headers['range']) proxyHeaders['Range'] = clientReq.headers['range'];

  const mod = parsed.protocol === 'https:' ? https : http;
  const proxyReq = mod.request(targetUrl, { headers: proxyHeaders }, (proxyRes) => {
    const location = proxyRes.headers.location;
    if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && location) {
      proxyRes.resume();
      proxyAudioRequest(location, clientReq, clientRes, redirectCount + 1);
      return;
    }

    const resHeaders = {
      'Content-Type': proxyRes.headers['content-type'] || 'audio/mp4',
      'Accept-Ranges': proxyRes.headers['accept-ranges'] || 'bytes',
      'Access-Control-Allow-Origin': '*',
    };
    if (proxyRes.headers['content-length']) resHeaders['Content-Length'] = proxyRes.headers['content-length'];
    if (proxyRes.headers['content-range']) resHeaders['Content-Range'] = proxyRes.headers['content-range'];

    clientRes.writeHead(proxyRes.statusCode, resHeaders);
    proxyRes.pipe(clientRes);
  });

  proxyReq.on('error', (e) => {
    if (!clientRes.headersSent) {
      clientRes.status(502).json({ error: e.message });
    } else {
      clientRes.destroy(e);
    }
  });

  proxyReq.end();
}

// 音频代理：用于转发 googlevideo 等需要服务端 IP 的音频流
router.get('/audio-proxy', (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ error: 'missing url' });
  proxyAudioRequest(targetUrl, req, res);
});

module.exports = router;
