const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  /\.github\.io$/,       // any GitHub Pages domain
  /\.trycloudflare\.com$/ // Cloudflare tunnels
];

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true); // same-origin / curl
      const allowed = ALLOWED_ORIGINS.some(o =>
        typeof o === 'string' ? o === origin : o.test(origin)
      );
      callback(allowed ? null : new Error('CORS blocked'), allowed);
    },
    methods: ['GET', 'POST']
  },
  maxHttpBufferSize: 1e8
});

// Session store: cleanCode -> session object
const sessions = new Map();
// Rate limiting: socketId -> attempt count
const attempts = new Map();

// Ambiguous chars removed: 0, O, 1, I, L
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateCode() {
  let code;
  do {
    const bytes = crypto.randomBytes(6);
    code = Array.from(bytes)
      .map(b => CODE_CHARS[b % CODE_CHARS.length])
      .join('');
  } while (sessions.has(code));
  return code;
}

function formatCode(code) {
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}

function cleanCode(input) {
  return input.replace(/[-\s]/g, '').toUpperCase();
}

// Expire sessions older than 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [code, session] of sessions.entries()) {
    if (now - session.createdAt > 10 * 60 * 1000) {
      sessions.delete(code);
      console.log(`[expire] Code ${formatCode(code)} expired`);
    }
  }
}, 30 * 1000);

app.use(express.static(path.join(__dirname, 'docs')));

// Healthcheck
app.get('/health', (_, res) => res.json({ status: 'ok', sessions: sessions.size }));

io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);

  // ── SENDER: Register a file and get a code ──────────────────────────────
  socket.on('register', ({ fileName, fileSize }) => {
    // Clean up any previous session from this socket
    if (socket.data.code) sessions.delete(socket.data.code);

    const code = generateCode();
    sessions.set(code, {
      senderSocketId: socket.id,
      fileName,
      fileSize,
      createdAt: Date.now()
    });

    socket.data.code = code;
    socket.data.role = 'sender';

    socket.emit('code', { code: formatCode(code) });
    console.log(`[register] Code ${formatCode(code)} | ${fileName} (${fileSize} bytes)`);
  });

  // ── RECEIVER: Join with a code ──────────────────────────────────────────
  socket.on('join', ({ code: rawCode }) => {
    const code = cleanCode(rawCode);

    // Rate limiting
    const count = (attempts.get(socket.id) || 0) + 1;
    attempts.set(socket.id, count);
    if (count > 5) {
      return socket.emit('error', { message: 'Too many failed attempts. Please wait a moment.' });
    }

    const session = sessions.get(code);
    if (!session) {
      return socket.emit('error', { message: 'Code not found or expired. Check the code and try again.' });
    }

    const senderSocket = io.sockets.sockets.get(session.senderSocketId);
    if (!senderSocket) {
      sessions.delete(code);
      return socket.emit('error', { message: 'Sender disconnected. Ask them for a new code.' });
    }

    // One-time use — delete the session
    sessions.delete(code);
    if (socket.data.code === code) socket.data.code = null;

    // Bridge the two sockets
    socket.data.role = 'receiver';
    socket.data.partnerId = session.senderSocketId;
    senderSocket.data.partnerId = socket.id;

    // Reset attempt counter on success
    attempts.delete(socket.id);

    socket.emit('matched', { fileName: session.fileName, fileSize: session.fileSize });
    senderSocket.emit('receiver-joined');
    console.log(`[match] ${session.senderSocketId} <-> ${socket.id}`);
  });

  // ── WebRTC Signaling Relay ──────────────────────────────────────────────
  socket.on('offer', (data) => {
    const partner = socket.data.partnerId;
    if (partner) io.to(partner).emit('offer', data);
  });

  socket.on('answer', (data) => {
    const partner = socket.data.partnerId;
    if (partner) io.to(partner).emit('answer', data);
  });

  socket.on('ice-candidate', (data) => {
    const partner = socket.data.partnerId;
    if (partner) io.to(partner).emit('ice-candidate', data);
  });

  // ── Disconnect ──────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    if (socket.data.code) {
      sessions.delete(socket.data.code);
      console.log(`[cleanup] Code ${formatCode(socket.data.code)} removed`);
    }
    if (socket.data.partnerId) {
      io.to(socket.data.partnerId).emit('partner-disconnected');
    }
    attempts.delete(socket.id);
    console.log(`[disconnect] ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🦔 Porcupine signaling server running on http://localhost:${PORT}\n`);
});
