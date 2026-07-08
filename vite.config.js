import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import fs from 'fs'
import path from 'path'

const LOG_FILE = path.resolve('C:\\Users\\skese\\opencode\\app.log')
const MUSIC_DIR = path.resolve('C:\\Users\\skese\\Downloads\\Muzik')

function logServerPlugin() {
  return {
    name: 'log-server',
    configureServer(server) {
      const now = new Date()
      const sessionLine = `\n${'='.repeat(80)}\n[${now.toISOString()}] OTONOM SESSION STARTED\n${'='.repeat(80)}\n`
      fs.appendFileSync(LOG_FILE, sessionLine, 'utf-8')

      server.middlewares.use('/api/log', async (req, res, next) => {
        if (req.method === 'POST') {
          let body = ''
          req.on('data', chunk => body += chunk)
          req.on('end', () => {
            try {
              const entry = JSON.parse(body)
              const ts = new Date().toISOString()
              const line = `[${ts}] [${(entry.type || 'INFO').toUpperCase().padEnd(7)}] ${entry.text}${entry.detail ? ' | ' + entry.detail : ''}\n`
              fs.appendFileSync(LOG_FILE, line, 'utf-8')
              if (entry.extra) {
                if (typeof entry.extra === 'object') {
                  try { fs.appendFileSync(LOG_FILE, `  ├─ ${JSON.stringify(entry.extra, null, 2).replace(/\n/g, '\n  │  ')}\n`, 'utf-8') } catch(e) {}
                } else {
                  fs.appendFileSync(LOG_FILE, `  ├─ ${entry.extra}\n`, 'utf-8')
                }
              }
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ ok: true }))
            } catch (e) {
              res.writeHead(400)
              res.end('Bad Request')
            }
          })
        } else if (req.method === 'GET') {
          try {
            const data = fs.readFileSync(LOG_FILE, 'utf-8')
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end(data)
          } catch {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('')
          }
        } else {
          next()
        }
      })

      // Müzik dosyalarını serve et
      server.middlewares.use('/api/music', async (req, res, next) => {
        const url = new URL(req.url, `http://${req.headers.host}`)
        const action = url.pathname.replace('/api/music', '')

        if (action === '/list') {
          try {
            if (!fs.existsSync(MUSIC_DIR)) {
              const msg = JSON.stringify({ files: [], error: 'Müzik klasörü bulunamadı: ' + MUSIC_DIR })
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(msg)
              return
            }
            const files = fs.readdirSync(MUSIC_DIR)
              .filter(f => /\.(mp3|wav|ogg|m4a|flac|aac|wma)$/i.test(f))
              .map((f, i) => ({ id: 'local_' + i, name: path.parse(f).name, file: f }))
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ files }))
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: e.message }))
          }
          return
        }

        const fileMatch = action.match(/^\/file\/(.+)$/)
        if (fileMatch) {
          const decoded = decodeURIComponent(fileMatch[1])
          const filePath = path.resolve(MUSIC_DIR, decoded)
          if (!filePath.startsWith(MUSIC_DIR)) {
            res.writeHead(403)
            res.end('Forbidden')
            return
          }
          if (!fs.existsSync(filePath)) {
            res.writeHead(404)
            res.end('Not Found')
            return
          }
          const stat = fs.statSync(filePath)
          const ext = path.extname(filePath).toLowerCase()
          const mimeTypes = {
            '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
            '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.aac': 'audio/aac', '.wma': 'audio/x-ms-wma'
          }
          res.writeHead(200, {
            'Content-Type': mimeTypes[ext] || 'application/octet-stream',
            'Content-Length': stat.size,
            'Accept-Ranges': 'bytes'
          })
          fs.createReadStream(filePath).pipe(res)
          return
        }

        next()
      })
    }
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), logServerPlugin()],
})
