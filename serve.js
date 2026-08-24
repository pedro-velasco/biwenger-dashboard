const http = require('http');
const fs   = require('fs');
const path = require('path');

const BLOCKED = new Set(['.env', '.env.local', '.env.development']);
const MIME = { '.html': 'text/html', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css' };
const PORT = 8090;

http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  const name    = path.basename(urlPath);

  if (BLOCKED.has(name)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return;
  }

  const file = path.join(__dirname, urlPath === '/' ? 'dashboard.html' : urlPath);
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not found');
      return;
    }
    const ext = path.extname(file);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`Dashboard → http://localhost:${PORT}/`);
  console.log('Ctrl+C para detener');
});
