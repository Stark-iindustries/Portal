'use strict';

if (!globalThis.crypto) {
    globalThis.crypto = require('crypto').webcrypto;
}

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

const PUBLIC_DIR  = path.join(__dirname, 'public');
const SESSION_DIR = path.join(__dirname, 'sessions');

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// Active pairing sessions: { id → { status, code, sessionStr, error } }
const sessions = new Map();

// ─── Build session string from session folder ─────────────────────────────────
async function buildSessionString(sessionId) {
    const dir   = path.join(SESSION_DIR, sessionId);
    const zip   = new AdmZip();
    const files = fs.readdirSync(dir);
    for (const f of files) zip.addLocalFile(path.join(dir, f));
    const buf     = zip.toBuffer();
    const encoded = buf.toString('base64').replace(/\//g, '*');
    return `BOTIFY-X=${encoded}`;
}

// ─── POST /generate ───────────────────────────────────────────────────────────
// Starts the Baileys socket, requests pairing code when the WA WebSocket is
// ready (on the 'qr' event), and responds immediately with sessionId so the
// client can poll /status for the code + final session string.
app.post('/generate', async (req, res) => {
    const { number } = req.body;
    if (!number || !/^\d{7,15}$/.test(number.replace(/\D/g, ''))) {
        return res.status(400).json({ error: 'Provide a valid phone number with country code (digits only).' });
    }

    const cleanNumber = number.replace(/\D/g, '');
    const sessionId   = `session_${cleanNumber}_${Date.now()}`;
    const sessionDir  = path.join(SESSION_DIR, sessionId);

    fs.mkdirSync(sessionDir, { recursive: true });

    const info = { status: 'pending', code: null, sessionStr: null, error: null };
    sessions.set(sessionId, info);

    // Respond immediately — client will poll /status for code + result
    res.json({ sessionId });

    // ── Start socket (async, does not block the response) ────────────────────
    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version }          = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            auth: {
                creds: state.creds,
                keys:  makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
            },
            // Chrome fingerprint — triggers WA notification reliably
            browser:           Browsers.ubuntu('Chrome'),
            printQRInTerminal: false,
            syncFullHistory:   false,
            getMessage:        async () => ({ conversation: '' }),
        });

        let codeRequested = false;

        sock.ev.on('connection.update', async (update) => {
            const { connection, qr, lastDisconnect } = update;

            // 'qr' fires when the WA WebSocket handshake is complete and the
            // server is waiting for QR or pairing. This is the correct moment
            // to call requestPairingCode — NOT after an arbitrary timeout.
            if (qr && !codeRequested && !sock.authState.creds.registered) {
                codeRequested = true;
                try {
                    const code      = await sock.requestPairingCode(cleanNumber);
                    const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
                    info.code   = formatted;
                    info.status = 'code_ready';
                } catch (e) {
                    info.status = 'error';
                    info.error  = 'Failed to get pairing code: ' + e.message;
                }
            }

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
                const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
                if (statusCode !== DisconnectReason.loggedOut && info.status !== 'connected') {
                    info.status = 'error';
                    info.error  = `Connection closed (code ${statusCode})`;
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);

    } catch (err) {
        info.status = 'error';
        info.error  = err.message;
    }
});

// ─── GET /status/:sessionId ───────────────────────────────────────────────────
app.get('/status/:sessionId', (req, res) => {
    const info = sessions.get(req.params.sessionId);
    if (!info) return res.status(404).json({ error: 'Session not found.' });
    res.json(info);
});

// ─── SPA fallback ─────────────────────────────────────────────────────────────
app.get('*', (_, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.listen(PORT, () => {
    console.log(`[BOTIFY-X] Pairing portal running on port ${PORT}`);
});
