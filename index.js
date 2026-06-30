'use strict';

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const pino     = require('pino');
const AdmZip   = require('adm-zip');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    makeCacheableSignalKeyStore,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Paths ────────────────────────────────────────────────────────────────────
const PUBLIC_DIR  = path.join(__dirname, 'public');
const SESSION_DIR = path.join(__dirname, 'sessions');

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// Active pairing sessions: { id → { socket, status, code, sessionStr } }
const sessions = new Map();

// ─── Helper: create session string from session folder ────────────────────────
async function buildSessionString(sessionId) {
    const dir = path.join(SESSION_DIR, sessionId);
    const zip = new AdmZip();
    const files = fs.readdirSync(dir);
    for (const f of files) {
        zip.addLocalFile(path.join(dir, f));
    }
    const buf     = zip.toBuffer();
    const encoded = buf.toString('base64').replace(/\//g, '*');
    return `BOTIFY-X=${encoded}`;
}

// ─── POST /generate — start pairing session ───────────────────────────────────
app.post('/generate', async (req, res) => {
    const { number } = req.body;
    if (!number || !/^\d{7,15}$/.test(number.replace(/\D/g, ''))) {
        return res.status(400).json({ error: 'Provide a valid phone number (digits only, 7-15 chars).' });
    }

    const cleanNumber = number.replace(/\D/g, '');
    const sessionId   = `session_${cleanNumber}_${Date.now()}`;
    const sessionDir  = path.join(SESSION_DIR, sessionId);

    fs.mkdirSync(sessionDir, { recursive: true });

    const info = { status: 'pending', code: null, sessionStr: null, error: null };
    sessions.set(sessionId, info);

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version }          = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
            },
            browser: Browsers.ubuntu('Chrome'),
            printQRInTerminal: false,
        });

        // Request pairing code
        await new Promise(r => setTimeout(r, 1500));
        const code = await sock.requestPairingCode(cleanNumber);
        const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
        info.code   = formatted;
        info.status = 'paired_pending';

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === 'open') {
                info.status = 'connected';
                try {
                    info.sessionStr = await buildSessionString(sessionId);
                } catch (e) {
                    info.error = 'Failed to build session string: ' + e.message;
                }
                sock.end();
            }
            if (connection === 'close') {
                const code2 = new Boom(lastDisconnect?.error)?.output?.statusCode;
                if (code2 !== DisconnectReason.loggedOut && info.status !== 'connected') {
                    info.status = 'error';
                    info.error  = `Connection closed (code ${code2})`;
                }
            }
        });

        res.json({ sessionId, code: formatted });

    } catch (err) {
        info.status = 'error';
        info.error  = err.message;
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /status/:sessionId — poll for connection result ──────────────────────
app.get('/status/:sessionId', (req, res) => {
    const info = sessions.get(req.params.sessionId);
    if (!info) return res.status(404).json({ error: 'Session not found.' });
    res.json(info);
});

// ─── Serve SPA for all other routes ──────────────────────────────────────────
app.get('*', (_, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.listen(PORT, () => {
    console.log(`[BOTIFY-X] Pairing portal running on port ${PORT}`);
});
