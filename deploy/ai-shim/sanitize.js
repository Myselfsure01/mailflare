// ai.bbyd.cc shim sanitizer: proxies Workers AI OpenAI-compatible API and
// coerces numeric `content` values in chat-completion chunks to strings.
// Workers AI serializes number-like tokens (e.g. "4") as JSON numbers, which
// strict OpenAI chunk validators (Vercel AI SDK) reject.
const http = require('http');

const ACCOUNT = '3674c011fdc81e3ce40f96cedde4c23c';
const UPSTREAM = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai`;

function fixObj(o) {
  try {
    for (const ch of o.choices || []) {
      const d = ch.delta || ch.message || {};
      if (typeof d.content === 'number' || typeof d.content === 'boolean') d.content = String(d.content);
      if (typeof d.text === 'number' || typeof d.text === 'boolean') d.text = String(d.text);
    }
  } catch (e) { /* pass through untouched */ }
  return o;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = UPSTREAM + req.url; // req.url is /v1/...
    const headers = { ...req.headers };
    delete headers.host;
    delete headers['content-length'];
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const up = await fetch(url, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    });
    const ct = up.headers.get('content-type') || '';
    if (ct.includes('text/event-stream')) {
      res.writeHead(up.status, { 'content-type': ct, 'cache-control': 'no-cache', connection: 'keep-alive' });
      const reader = up.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const emit = (line) => {
        if (line.startsWith('data: ') && line.slice(6) !== '[DONE]') {
          try { res.write('data: ' + JSON.stringify(fixObj(JSON.parse(line.slice(6)))) + '\n'); return; } catch (e) { /* fall through */ }
        }
        res.write(line + '\n');
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) { emit(buf.slice(0, idx)); buf = buf.slice(idx + 1); }
      }
      if (buf) emit(buf);
      res.end();
    } else if (ct.includes('json')) {
      const text = await up.text();
      try { res.end(JSON.stringify(fixObj(JSON.parse(text)))); }
      catch (e) { res.writeHead(up.status, { 'content-type': ct }); res.end(text); }
    } else {
      res.writeHead(up.status, { 'content-type': ct });
      if (up.body) {
        const reader = up.body.getReader();
        while (true) { const { done, value } = await reader.read(); if (done) break; res.write(value); }
      }
      res.end();
    }
  } catch (e) {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'ai shim sanitizer upstream error', type: 'shim_error' } }));
  }
});

server.listen(19320, '127.0.0.1', () => console.log('ai-shim sanitizer on 127.0.0.1:19320'));
