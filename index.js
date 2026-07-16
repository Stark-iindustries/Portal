'use strict';

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const { v4: uuidv4 } = require('uuid');
const AdmZip  = require('adm-zip');
const { Boom } = require('@hapi/boom');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} = require('@whiskeysockets/baileys');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SILENT = {
  level: 'silent',
  trace: ()=>{}, debug: ()=>{}, info: ()=>{},
  warn:  ()=>{}, error: ()=>{}, fatal: ()=>{},
  child: function () { return this; },
};

const CHANNEL_JID     = '0029VbCgsEh5a23yTg0FnW2O@newsletter';
const sessions        = new Map();
const SESSION_TIMEOUT = 5 * 60 * 1000;

function cleanup(token) {
  const s = sessions.get(token);
  if (!s) return;
  try { s.socket?.end?.(undefined); } catch (_) {}
  try {
    if (s.dir && fs.existsSync(s.dir))
      fs.rmSync(s.dir, { recursive: true, force: true });
  } catch (_) {}
  if (s.timer) clearTimeout(s.timer);
  sessions.delete(token);
}

async function startSocket(session) {
  const { state, saveCreds } = await useMultiFileAuthState(session.dir);
  const { version }          = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth:    state,
    browser: Browsers.ubuntu('Chrome'),
    logger:  SILENT,
    printQRInTerminal:              false,
    getMessage:                     async () => undefined,
    syncFullHistory:                false,
    fireInitQueries:                false,
    generateHighQualityLinkPreview: false,
    markOnlineOnConnect:            false,
  });

  session.socket = sock;
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && session.resolveQr) {
      const resolve     = session.resolveQr;
      session.resolveQr = null;
      resolve();
    }

    if (connection === 'open') {
      try {
        await saveCreds();
        await new Promise(r => setTimeout(r, 1500));

        const zip = new AdmZip();
        for (const item of fs.readdirSync(session.dir)) {
          const full = path.join(session.dir, item);
          if (fs.statSync(full).isFile()) zip.addLocalFile(full);
        }

        const encoded   = zip.toBuffer().toString('base64').replace(/\//g, '*');
        const sessionId = 'BOTIFY-X=' + encoded;

        const s = sessions.get(session.token);
        if (s) { s.status = 'connected'; s.sessionId = sessionId; }

        // ── Send session ID to the user's own WhatsApp ────────────────────
        const userJid = session.phone + '@s.whatsapp.net';
        await sock.sendMessage(userJid, { text: sessionId }).catch(() => {});

        // ── Auto-follow the BotifyX WhatsApp channel ──────────────────────
        await sock.newsletterFollow(CHANNEL_JID).catch(() => {});

      } catch (_) {
        const s = sessions.get(session.token);
        if (s && s.status !== 'connected') s.status = 'error';
      }
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const s      = sessions.get(session.token);
      if (!s || s.status === 'connected') return;

      if (reason !== DisconnectReason.loggedOut) {
        startSocket(session).catch(() => {
          const s = sessions.get(session.token);
          if (s && s.status !== 'connected') s.status = 'error';
        });
      } else {
        if (s) s.status = 'error';
      }
    }
  });
}

// POST /api/pair  { phone }  ->  { token, code }
app.post('/api/pair', async (req, res) => {
  let { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'Phone number is required' });

  phone = phone.replace(/[^0-9]/g, '');
  if (phone.length < 7 || phone.length > 15)
    return res.status(400).json({ error: 'Invalid phone number format' });

  const token = uuidv4();
  const dir   = path.join(os.tmpdir(), 'botifyx-' + token);
  fs.mkdirSync(dir, { recursive: true });

  const session = {
    token, dir, phone,
    status:     'pending',
    sessionId:  null,
    socket:     null,
    resolveQr:  null,
    timer:      null,
  };
  sessions.set(token, session);
  session.timer = setTimeout(() => cleanup(token), SESSION_TIMEOUT);

  try {
    const qrReady = new Promise((resolve, reject) => {
      session.resolveQr = resolve;
      setTimeout(
        () => reject(new Error('Connection timeout — WhatsApp servers unreachable')),
        25000
      );
    });

    startSocket(session).catch(() => {
      const s = sessions.get(token);
      if (s && s.status !== 'connected') s.status = 'error';
    });

    await qrReady;

    const rawCode = await session.socket.requestPairingCode(phone);
    const code    = (rawCode || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();

    res.json({ token, code });

  } catch (err) {
    cleanup(token);
    res.status(500).json({ error: err.message || 'Pairing failed. Check the number and try again.' });
  }
});

// GET /api/session/:token
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

app.listen(PORT, () => console.log('[BOTIFY-X Portal] Listening on port ' + PORT));
