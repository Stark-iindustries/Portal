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

// ─── Build session string ─────────────────────────────────────────────────────
async function buildSessionString(sessionId) {
    const dir   = path.join(SESSION_DIR, sessionId);
    const zip   = new AdmZip();
    for (const f of fs.readdirSync(dir)) zip.addLocalFile(path.join(dir, f));
    const encoded = zip.toBuffer().toString('base64').replace(/\//g, '*');
    return `BOTIFY-X=${encoded}`;
}

// ─── POST /generate ───────────────────────────────────────────────────────────
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

    // Respond immediately so the client can show the waiting screen and start polling
    res.json({ sessionId });

    // ── Start pairing socket (async) ─────────────────────────────────────────
    ;(async () => {
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
                // Chrome fingerprint — most reliable for triggering WA's notification
                browser:              Browsers.ubuntu('Chrome'),
                printQRInTerminal:    false,
                syncFullHistory:      false,
                markOnlineOnConnect:  false,
                getMessage:           async () => ({ conversation: '' }),
            });

            let codeRequested = false;

            // Helper: request pairing code and store result
            const requestCode = async () => {
                if (codeRequested || sock.authState.creds.registered) return;
                codeRequested = true;
                try {
                    const code      = await sock.requestPairingCode(cleanNumber);
                    const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
                    info.code   = formatted;
                    info.status = 'code_ready';
                } catch (e) {
                    if (!codeRequested) return; // already handled
                    info.status = 'error';
                    info.error  = 'Pairing code request failed: ' + e.message;
                }
            };

            sock.ev.on('connection.update', async (update) => {
                const { connection, qr, lastDisconnect } = update;

                // The 'qr' field means WA's WebSocket handshake is done and the
                // server is ready. Request pairing code here instead of showing QR.
                if (qr) await requestCode();

                if (connection === 'open') {
                    info.status = 'connected';
                    try {
                        info.sessionStr = await buildSessionString(sessionId);
                    } catch (e) {
                        info.error = 'Session build failed: ' + e.message;
                    }
                    sock.end();
                }

                if (connection === 'close') {
                    const code2 = new Boom(lastDisconnect?.error)?.output?.statusCode;
                    if (code2 !== DisconnectReason.loggedOut && info.status !== 'connected') {
                        if (!codeRequested) {
                            // Never even got to request code — connection dropped early
                            info.status = 'error';
                            info.error  = `Connection closed before pairing code (code ${code2}). Check the phone number format — it must include country code, e.g. 2348012345678`;
                        } else if (info.status !== 'code_ready' && info.status !== 'connected') {
                            info.status = 'error';
                            info.error  = `Connection closed (code ${code2})`;
                        }
                    }
                }
            });

            sock.ev.on('creds.update', saveCreds);

            // Fallback: if 'qr' event hasn't fired after 4s, try anyway.
            // Some environments / Baileys versions delay or skip the qr event.
            await new Promise(r => setTimeout(r, 4000));
            await requestCode();

        } catch (err) {
            info.status = 'error';
            info.error  = err.message;
        }
    })();
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
