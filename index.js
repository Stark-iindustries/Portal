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

// token -> { socket, dir, status, sessionId, timer }
const sessions = new Map();
const SESSION_TIMEOUT = 5 * 60 * 1000;

function cleanup(token) {
  const s = sessions.get(token);
  if (!s) return;
  try { s.socket?.end?.(); }    catch (_) {}
  try { s.socket?.ws?.close?.(); } catch (_) {}
  try {
    if (s.dir && fs.existsSync(s.dir))
      fs.rmSync(s.dir, { recursive: true, force: true });
  } catch (_) {}
  if (s.timer) clearTimeout(s.timer);
  sessions.delete(token);
}

// POST /api/pair  { phone }  →  { token, code }
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
      logger:                    pino({ level: 'silent' }),
      auth: {
        creds: state.creds,
        keys:  makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
      },
      // FIX: Use baileys Desktop browser — Ubuntu/Chrome causes WhatsApp to
      // reject the pairing code handshake with "something went wrong"
      browser:                   Browsers.ubuntu('Chrome'),
      printQRInTerminal:         false,
      syncFullHistory:           false,
      connectTimeoutMs:          60_000,
      keepAliveIntervalMs:       10_000,
      defaultQueryTimeoutMs:     30_000,
      getMessage:                async () => ({ conversation: '' }),
    });

    entry.socket = sock;
    sock.ev.on('creds.update', saveCreds);

    // FIX: Wait for the socket to signal it is ready (first connection.update
    // with a qr field = socket has registered with WA servers and is waiting
    // for auth). Only then call requestPairingCode — calling it too early
    // on a not-yet-connected socket produces an invalid code that WhatsApp
    // rejects with "something went wrong".
    const socketReady = new Promise((resolve, reject) => {
      const timeout = setTimeout(() =>
        reject(new Error('Connection timeout — WhatsApp servers unreachable')), 25_000);

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // qr event fires when the socket is fully registered and waiting for
        // auth — this is the correct moment to request the pairing code
        if (qr) {
          clearTimeout(timeout);
          resolve();
        }

        if (connection === 'open') {
          try {
            await saveCreds();
            await new Promise(r => setTimeout(r, 1500));

            const zip   = new AdmZip();
            const items = fs.readdirSync(dir);
            for (const item of items) {
              const full = path.join(dir, item);
              if (fs.statSync(full).isFile()) zip.addLocalFile(full);
            }
            const buf     = zip.toBuffer();
            const encoded = buf.toString('base64').replace(/\//g, '*');
            const sid     = `BOTIFY-X=${encoded}`;

            const e = sessions.get(token);
            if (e) { e.status = 'connected'; e.sessionId = sid; }
          } catch (_) {
            const e = sessions.get(token);
            if (e) e.status = 'error';
          }
        }

        if (connection === 'close') {
          const e = sessions.get(token);
          if (e && e.status !== 'connected') e.status = 'error';
        }
      });
    });

    await socketReady;

    const rawCode   = await sock.requestPairingCode(phone);
    // Strip any separators (spaces, hyphens) Baileys may include, then
    // format as XXXX-XXXX so the frontend always receives exactly 8 alphanum chars
    const clean     = (rawCode || '').replace(/[^A-Z0-9]/gi, '');
    const formatted = clean.length >= 8 ? clean.slice(0, 4) + '-' + clean.slice(4, 8) : clean;

    res.json({ token, code: formatted });

  } catch (err) {
    cleanup(token);
    res.status(500).json({ error: err.message || 'Pairing failed. Check the number and try again.' });
  }
});

// GET /api/session/:token — poll for result
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
  console.log(`[BOTIFY-X Portal] Running on port ${PORT}`)
);
