/* Minimal static server for the Polaroid web app.
   Serves from this file's own directory (never calls process.cwd(),
   which is blocked in the preview sandbox). */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = 8741;
const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
};

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const urlPath = decodeURIComponent(url.pathname);

    // POST /save?name=foo.png writes the request body into charts/
    // (used to export generated calibration charts to disk)
    if (req.method === 'POST' && urlPath === '/save') {
      const name = (url.searchParams.get('name') || '').replace(/[^\w.-]/g, '');
      if (!name) {
        res.writeHead(400).end('missing name');
        return;
      }
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const dir = path.join(ROOT, 'charts');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, name), Buffer.concat(chunks));
        res.writeHead(200).end('saved');
      });
      return;
    }

    let filePath = path.normalize(path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    });
  })
  .listen(PORT, () => console.log(`serving ${ROOT} on http://localhost:${PORT}`));
