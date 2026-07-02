'use strict';

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const { v4: uuidv4 } = require('uuid');
const AdmZip   = require('adm-zip');
const pino     = require('pino');
const { Boom } = require('@hapi/boom');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} = require('@whiskeysockets/baileys');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory store: token -> { socket, dir, status, sessionId, timer }
const sessions = new Map();
const SESSION_TIMEOUT = 5 * 60 * 1000; // 5 min

function cleanup(token) {
  const s = sessions.get(token);
  if (!s) return;
  try { s.socket?.end?.(); } catch (_) {}
  try { s.socket?.ws?.close?.(); } catch (_) {}
  try {
    if (s.dir && fs.existsSync(s.dir))
      fs.rmSync(s.dir, { recursive: true, force: true });
  } catch (_) {}
  if (s.timer) clearTimeout(s.timer);
  sessions.delete(token);
}

// POST /api/pair  { phone: "2348012345678" }
// Returns { token, code: "ABCD-EFGH" }
app.post('/api/pair', async (req, res) => {
  let { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'Phone number is required' });

  phone = phone.replace(/[^0-9]/g, '');
  if (phone.length < 7 || phone.length > 15)
    return res.status(400).json({ error: 'Invalid phone number format' });

  const token = uuidv4();
  const dir   = path.join(os.tmpdir(), `botifyx-${token}`);
  fs.mkdirSync(dir, { recursive: true });

  const entry = { socket: null, dir, status: 'pending', sessionId: null, timer: null };
  sessions.set(token, entry);
  entry.timer = setTimeout(() => cleanup(token), SESSION_TIMEOUT);

  try {
    const { state, saveCreds } = await useMultiFileAuthState(dir);
    const { version }          = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      auth: {
        creds: state.creds,
        keys:  makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
      },
      browser:           Browsers.ubuntu('Chrome'),
      printQRInTerminal: false,
      syncFullHistory:   false,
      getMessage:        async () => ({ conversation: '' }),
    });

    entry.socket = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'open') {
        try {
          await saveCreds();
          // Small delay to let creds flush to disk
          await new Promise(r => setTimeout(r, 1500));

          const zip   = new AdmZip();
          const items = fs.readdirSync(dir);
          for (const item of items) {
            const full = path.join(dir, item);
            if (fs.statSync(full).isFile()) zip.addLocalFile(full);
          }
          const buf     = zip.toBuffer();
          // Replace / with * to match Core-botifyX's decoder
          const encoded = buf.toString('base64').replace(/\//g, '*');
          const sid     = `BOTIFY-X=${encoded}`;

          const e = sessions.get(token);
          if (e) { e.status = 'connected'; e.sessionId = sid; }
        } catch (err) {
          const e = sessions.get(token);
          if (e) e.status = 'error';
        }
      }

      if (connection === 'close') {
        const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const e = sessions.get(token);
        if (e && e.status !== 'connected') e.status = 'error';
      }
    });

    // Brief pause before requesting pairing code (Baileys needs to init)
    await new Promise(r => setTimeout(r, 3000));
    const rawCode = await sock.requestPairingCode(phone);
    // Format as XXXX-XXXX
    const formatted = rawCode?.replace(/(.{4})(.{4})/, '$1-$2') || rawCode;

    res.json({ token, code: formatted });

  } catch (err) {
    cleanup(token);
    res.status(500).json({ error: err.message || 'Pairing failed. Check the number and try again.' });
  }
});

// GET /api/session/:token — poll until connected or error
app.get('/api/session/:token', (req, res) => {
  const s = sessions.get(req.params.token);
  if (!s) return res.status(404).json({ status: 'expired' });

  if (s.status === 'connected' && s.sessionId) {
    const sid = s.sessionId;
    cleanup(req.params.token);
    return res.json({ status: 'connected', sessionId: sid });
  }

  res.json({ status: s.status });
});

app.listen(PORT, () =>
  console.log(`[BOTIFY-X Portal] Listening on port ${PORT}`)
);
