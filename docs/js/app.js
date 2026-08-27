/**
 * Porcupine — app.js
 * P2P File Transfer via WebRTC + Socket.IO signaling
 */

'use strict';

/* ── Server URL ───────────────────────────────────────────────────────── */
// In development (localhost), connect to local server.
// In production (GitHub Pages), connect to your deployed Render server.
// ⬇️  UPDATE THIS URL after deploying to Render:
const RENDER_SERVER_URL = 'https://porcupine-server-31gi.onrender.com';

const SIGNAL_SERVER = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
  ? window.location.origin   // local dev — same machine
  : RENDER_SERVER_URL;        // GitHub Pages — point to Render

/* ── Config ───────────────────────────────────────────────────────────── */
const CHUNK_SIZE  = 256 * 1024;         // 256 KB — sweet spot for WebRTC throughput (was 64KB)
const BUFFER_HIGH = 8   * 1024 * 1024;  // Pause when 8 MB buffered
const BUFFER_LOW  = 1   * 1024 * 1024;  // Resume when back to 1 MB (event-driven)
const CODE_TTL    = 10  * 60;           // 10 minutes in seconds

const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    // Free TURN server for strict NATs (mobile data, corporate networks)
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp'
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ]
};

/* ── State ────────────────────────────────────────────────────────────── */
let socket = null;
let peerConnection = null;
let dataChannel = null;
let selectedFile = null;
let currentCode = null;
let timerInterval = null;
let timerSeconds = CODE_TTL;
let wakeLock = null;
let audioCtx = null;
let receivedChunks = [];
let receivedBytes = 0;
let totalBytes = 0;
let receiveFileName = '';
let writableStream = null;    // FileSystemWritableFileStream (Chrome)
let useStreamAPI = false;
let transferStartTime = null;
let lastBytes = 0;
let lastSpeedTime = null;
let pendingOffer = null;      // Buffers offer that arrives before PC is ready
let pendingCandidates = [];   // Buffers ICE candidates before remote desc is set

/* ── Socket.IO initialization ─────────────────────────────────────────── */
function getSocket() {
  if (!socket) {
    socket = io(SIGNAL_SERVER, { transports: ['websocket'], upgrade: false });

    socket.on('connect', () => console.log('[socket] connected', socket.id));
    socket.on('disconnect', () => console.log('[socket] disconnected'));

    // Sender events
    socket.on('code', ({ code }) => onCodeReceived(code));
    socket.on('receiver-joined', () => onReceiverJoined());

    // Receiver events
    socket.on('matched', ({ fileName, fileSize }) => onMatched(fileName, fileSize));

    // WebRTC signaling
    socket.on('offer',         ({ offer })      => onOffer(offer));
    socket.on('answer',        ({ answer })      => onAnswer(answer));
    socket.on('ice-candidate', ({ candidate })   => onIceCandidate(candidate));

    // Errors & disconnect
    socket.on('error',              ({ message }) => showError(message));
    socket.on('partner-disconnected', () => onPartnerDisconnected());
  }
  return socket;
}

/* ══════════════════════════════════════════════════════════════════════
   NAVIGATION
══════════════════════════════════════════════════════════════════════ */

function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function showSendStep(n) {
  document.querySelectorAll('.send-step').forEach(s => s.classList.remove('active'));
  document.getElementById(`send-s${n}`).classList.add('active');
}

function showRecvStep(n) {
  document.querySelectorAll('.recv-step').forEach(s => s.classList.remove('active'));
  document.getElementById(`recv-s${n}`).classList.add('active');
}

function goHome() {
  cleanup();
  showView('view-home');
  resetSendUI();
  resetReceiveUI();
}

function goToSend() {
  showView('view-send');
  showSendStep(1);
}

function goToReceive() {
  showView('view-receive');
  showRecvStep(1);
  // Focus first OTP box
  setTimeout(() => document.getElementById('otp-0')?.focus(), 100);
}

function resetSendUI() {
  selectedFile = null;
  currentCode = null;
  clearInterval(timerInterval);
  timerSeconds = CODE_TTL;
  document.getElementById('send-s1').classList.add('active');
  document.querySelectorAll('.send-step').forEach((s, i) => s.classList.toggle('active', i === 0));
  document.getElementById('file-input').value = '';
  // Reset drop zone
  const dz = document.getElementById('drop-zone');
  dz.classList.remove('dragging');
  setEl('send-s1', 'dz-title', 'Drop your file here');
}

function resetReceiveUI() {
  for (let i = 0; i < 6; i++) {
    const el = document.getElementById(`otp-${i}`);
    if (el) { el.value = ''; el.classList.remove('filled'); }
  }
  setElById('otp-error', '');
  const btn = document.getElementById('btn-start-download');
  if (btn) btn.disabled = true;
}

/* ══════════════════════════════════════════════════════════════════════
   FILE SELECTION & DRAG-DROP
══════════════════════════════════════════════════════════════════════ */

function handleFileSelect(event) {
  const file = event.target.files?.[0];
  if (file) selectFile(file);
}

function handleDrop(event) {
  event.preventDefault();
  document.getElementById('drop-zone').classList.remove('dragging');
  const file = event.dataTransfer.files?.[0];
  if (file) selectFile(file);
}

function handleDragOver(event) {
  event.preventDefault();
  document.getElementById('drop-zone').classList.add('dragging');
}

function handleDragLeave() {
  document.getElementById('drop-zone').classList.remove('dragging');
}

function selectFile(file) {
  selectedFile = file;
  const sock = getSocket();
  sock.emit('register', { fileName: file.name, fileSize: file.size });

  // Show step 2 immediately with placeholder
  populateFilePill('s2', file);
  populateFilePill('s3', file);
  setElById('code-value', '···-···');
  showSendStep(2);
  startTimer();
}

/* ══════════════════════════════════════════════════════════════════════
   SENDER FLOW
══════════════════════════════════════════════════════════════════════ */

function onCodeReceived(code) {
  currentCode = code;
  setElById('code-value', code);
}

function startTimer() {
  clearInterval(timerInterval);
  timerSeconds = CODE_TTL;
  updateTimerDisplay();
  timerInterval = setInterval(() => {
    timerSeconds--;
    updateTimerDisplay();
    if (timerSeconds <= 0) {
      clearInterval(timerInterval);
      showError('Code expired. Please start over.');
      setTimeout(goHome, 3000);
    }
  }, 1000);
}

function updateTimerDisplay() {
  const m = Math.floor(timerSeconds / 60).toString().padStart(2, '0');
  const s = (timerSeconds % 60).toString().padStart(2, '0');
  setElById('code-timer', `${m}:${s}`);
}

function copyCode() {
  if (!currentCode) return;
  navigator.clipboard.writeText(currentCode).then(() => {
    const btn = document.getElementById('btn-copy');
    btn.classList.add('copied');
    btn.textContent = '✓ Copied!';
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy Code`;
    }, 2000);
  }).catch(() => showToast('Could not copy — try manually'));
}

async function onReceiverJoined() {
  clearInterval(timerInterval);
  showSendStep(3);
  await requestWakeLock();
  startKeepAliveAudio();
  await setupSenderConnection();
}

async function setupSenderConnection() {
  peerConnection = new RTCPeerConnection(ICE_CONFIG);

  // Create data channel
  dataChannel = peerConnection.createDataChannel('porcupine', {
    ordered: true,
    maxRetransmits: null
  });

  dataChannel.bufferedAmountLowThreshold = BUFFER_LOW;
  dataChannel.binaryType = 'arraybuffer';

  dataChannel.onopen = () => {
    console.log('[dc] open — starting transfer');
    setElById('send-status-label', 'Sending…');
    transferStartTime = Date.now();
    lastBytes = 0;
    lastSpeedTime = Date.now();
    sendFile();
  };

  dataChannel.onerror = (e) => {
    console.error('[dc] error', e);
    showTransferError('send', 'Connection error during transfer.');
  };

  // ICE candidate handling
  peerConnection.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit('ice-candidate', { candidate });
  };

  peerConnection.onconnectionstatechange = () => {
    console.log('[pc] state:', peerConnection.connectionState);
    if (peerConnection.connectionState === 'failed') {
      showTransferError('send', 'Connection failed. Check your network.');
    }
  };

  // Create and send offer
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  socket.emit('offer', { offer });
}

async function sendFile() {
  const file = selectedFile;
  if (!file || !dataChannel) return;

  // Send metadata first
  dataChannel.send(JSON.stringify({ type: 'meta', name: file.name, size: file.size }));

  let offset = 0;
  let drainResolve = null;

  // Event-driven flow control: fire when buffer drains below threshold
  dataChannel.bufferedAmountLowThreshold = BUFFER_LOW;
  dataChannel.onbufferedamountlow = () => {
    if (drainResolve) { drainResolve(); drainResolve = null; }
  };

  while (offset < file.size) {
    // Read chunk ahead of time while buffer may still be draining
    const end = Math.min(offset + CHUNK_SIZE, file.size);
    const buffer = await file.slice(offset, end).arrayBuffer();

    // If buffer is full, wait for the drain event (not a poll loop)
    if (dataChannel.bufferedAmount >= BUFFER_HIGH) {
      await new Promise(resolve => { drainResolve = resolve; });
    }

    dataChannel.send(buffer);
    offset += buffer.byteLength;
    updateSendProgress(offset, file.size);
  }

  // Clear the handler before sending done
  dataChannel.onbufferedamountlow = null;
  dataChannel.send(JSON.stringify({ type: 'done' }));
  onSendComplete();
}

function updateSendProgress(sent, total) {
  const pct = Math.min(100, (sent / total) * 100);
  const pctStr = pct.toFixed(1) + '%';
  setElById('send-pct', pctStr);
  setElById('send-transferred', formatBytes(sent) + ' / ' + formatBytes(total));

  const fill = document.getElementById('send-progress-fill');
  const glow = document.getElementById('send-progress-glow');
  if (fill) fill.style.width = pct + '%';
  if (glow) glow.style.left = `calc(${pct}% - 10px)`;

  const track = document.getElementById('send-progress-track');
  if (track) track.setAttribute('aria-valuenow', Math.round(pct));

  // Speed calculation
  const now = Date.now();
  const elapsed = (now - lastSpeedTime) / 1000;
  if (elapsed >= 0.5) {
    const bytesPerSec = (sent - lastBytes) / elapsed;
    const remaining = (total - sent) / bytesPerSec;
    setElById('send-speed', formatBytes(bytesPerSec) + '/s');
    setElById('send-eta', isFinite(remaining) ? formatTime(remaining) + ' left' : '—');
    lastBytes = sent;
    lastSpeedTime = now;
  }
}

function onSendComplete() {
  releaseWakeLock();
  stopKeepAliveAudio();
  showSendStep(4);
  setElById('send-result-icon', '✓');
  setElById('send-result-title', 'Transfer complete!');
  setElById('send-result-sub', `${selectedFile.name} was delivered successfully.`);
  showToast('🦔 File sent!');

  // Notify via Service Worker if available
  notifyCompletion('Send complete', `${selectedFile.name} was delivered.`);
}

/* ══════════════════════════════════════════════════════════════════════
   RECEIVER FLOW
══════════════════════════════════════════════════════════════════════ */

// OTP input logic
function otpInput(el, idx) {
  const val = el.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  el.value = val.slice(-1);
  el.classList.toggle('filled', el.value.length > 0);

  if (el.value && idx < 5) {
    document.getElementById(`otp-${idx + 1}`)?.focus();
  }

  checkOtpComplete();
}

function otpKeydown(el, idx) {
  if (event.key === 'Backspace' && !el.value && idx > 0) {
    const prev = document.getElementById(`otp-${idx - 1}`);
    prev.value = '';
    prev.classList.remove('filled');
    prev.focus();
  }
  checkOtpComplete();
}

function otpPaste(event) {
  event.preventDefault();
  const text = (event.clipboardData || window.clipboardData)
    .getData('text')
    .replace(/[-\s]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

  for (let i = 0; i < 6 && i < text.length; i++) {
    const el = document.getElementById(`otp-${i}`);
    if (el) { el.value = text[i]; el.classList.add('filled'); }
  }
  document.getElementById(`otp-${Math.min(text.length, 5)}`)?.focus();
  checkOtpComplete();
}

function getOtpValue() {
  let val = '';
  for (let i = 0; i < 6; i++) val += (document.getElementById(`otp-${i}`)?.value || '');
  return val;
}

function checkOtpComplete() {
  const val = getOtpValue();
  const btn = document.getElementById('btn-start-download');
  if (btn) btn.disabled = val.length < 6;
  // Show save-location checkbox only if browser supports File System Access API
  const row = document.getElementById('save-location-row');
  if (row) row.style.display = (val.length === 6 && 'showSaveFilePicker' in window) ? 'flex' : 'none';
}

async function startReceive() {
  const code = getOtpValue();
  if (code.length < 6) return;

  setElById('otp-error', '');

  // Only use File System Access API if user explicitly opted in
  const chk = document.getElementById('chk-save-location');
  useStreamAPI = !!(chk && chk.checked && 'showSaveFilePicker' in window);

  const sock = getSocket();
  sock.emit('join', { code });
}

async function onMatched(fileName, fileSize) {
  receiveFileName = fileName;
  totalBytes = fileSize;
  receivedChunks = [];
  receivedBytes = 0;

  // Show progress step
  populateFilePill('r2', { name: fileName, size: fileSize });
  showRecvStep(2);
  setElById('recv-status-label', 'Connecting…');

  await requestWakeLock();
  startKeepAliveAudio();

  // If streaming API available, prompt save location now
  if (useStreamAPI) {
    try {
      const fileHandle = await window.showSaveFilePicker({
        suggestedName: fileName,
        startIn: 'downloads',
      });
      writableStream = await fileHandle.createWritable();
    } catch (e) {
      // User cancelled or not supported — fall back to memory
      useStreamAPI = false;
      writableStream = null;
    }
  }

  await setupReceiverConnection();
}

async function setupReceiverConnection() {
  peerConnection = new RTCPeerConnection(ICE_CONFIG);

  peerConnection.ondatachannel = ({ channel }) => {
    dataChannel = channel;
    dataChannel.binaryType = 'arraybuffer';
    dataChannel.onmessage = onDataMessage;
    dataChannel.onopen = () => {
      setElById('recv-status-label', 'Receiving…');
      transferStartTime = Date.now();
      lastBytes = 0;
      lastSpeedTime = Date.now();
    };
    dataChannel.onerror = () => showTransferError('recv', 'Connection error during download.');
  };

  peerConnection.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit('ice-candidate', { candidate });
  };

  peerConnection.onconnectionstatechange = () => {
    console.log('[pc] receiver state:', peerConnection.connectionState);
    if (peerConnection.connectionState === 'failed') {
      showTransferError('recv', 'Connection failed. Ask sender for a new code.');
    }
  };

  // Process any offer that arrived while we were waiting for file picker
  if (pendingOffer) {
    console.log('[webrtc] processing buffered offer');
    await processOffer(pendingOffer);
    pendingOffer = null;
  }
}

// Buffer offer if peer connection isn't ready yet (race condition fix)
async function onOffer(offer) {
  if (!peerConnection) {
    console.log('[webrtc] offer arrived before PC ready — buffering');
    pendingOffer = offer;
    return;
  }
  await processOffer(offer);
}

async function processOffer(offer) {
  await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
  // Flush any ICE candidates that arrived before remote description
  for (const c of pendingCandidates) {
    try { await peerConnection.addIceCandidate(new RTCIceCandidate(c)); } catch(_) {}
  }
  pendingCandidates = [];
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  socket.emit('answer', { answer });
}

async function onAnswer(answer) {
  if (!peerConnection) return;
  await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
}

async function onIceCandidate(candidate) {
  if (!candidate) return;
  // If remote description not set yet, queue the candidate
  if (!peerConnection || !peerConnection.remoteDescription) {
    pendingCandidates.push(candidate);
    return;
  }
  try {
    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (e) {
    console.warn('[ice] failed to add candidate', e);
  }
}

async function onDataMessage({ data }) {
  if (typeof data === 'string') {
    const msg = JSON.parse(data);
    if (msg.type === 'meta') {
      // metadata already handled in onMatched
      return;
    }
    if (msg.type === 'done') {
      await finalizeReceive();
    }
  } else {
    // Binary chunk
    if (useStreamAPI && writableStream) {
      await writableStream.write(data);
    } else {
      receivedChunks.push(data);
    }
    receivedBytes += data.byteLength;
    updateRecvProgress(receivedBytes, totalBytes);
  }
}

function updateRecvProgress(received, total) {
  const pct = total > 0 ? Math.min(100, (received / total) * 100) : 0;
  setElById('recv-pct', pct.toFixed(1) + '%');
  setElById('recv-transferred', formatBytes(received) + ' / ' + formatBytes(total));

  const fill = document.getElementById('recv-progress-fill');
  const glow = document.getElementById('recv-progress-glow');
  if (fill) fill.style.width = pct + '%';
  if (glow) glow.style.left = `calc(${pct}% - 10px)`;

  const track = document.getElementById('recv-progress-track');
  if (track) track.setAttribute('aria-valuenow', Math.round(pct));

  // Speed
  const now = Date.now();
  const elapsed = (now - lastSpeedTime) / 1000;
  if (elapsed >= 0.5) {
    const bps = (received - lastBytes) / elapsed;
    const rem = (total - received) / bps;
    setElById('recv-speed', formatBytes(bps) + '/s');
    setElById('recv-eta', isFinite(rem) && rem > 0 ? formatTime(rem) + ' left' : '—');
    lastBytes = received;
    lastSpeedTime = now;
  }
}

async function finalizeReceive() {
  releaseWakeLock();
  stopKeepAliveAudio();

  if (useStreamAPI && writableStream) {
    await writableStream.close();
  } else {
    // Fallback: assemble blob and trigger download
    const blob = new Blob(receivedChunks);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = receiveFileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  showRecvStep(3);
  setElById('recv-result-icon', '✓');
  setElById('recv-result-title', 'Download complete!');
  setElById('recv-result-sub', `${receiveFileName} received successfully.`);
  showToast('🦔 File received!');
  notifyCompletion('Download complete', `${receiveFileName} saved.`);
}

/* ══════════════════════════════════════════════════════════════════════
   BACKGROUND OPERATION
══════════════════════════════════════════════════════════════════════ */

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      console.log('[wakelock] acquired');
      wakeLock.addEventListener('release', () => {
        console.log('[wakelock] released');
        // Re-acquire if transfer still running
        if (dataChannel && dataChannel.readyState === 'open') {
          requestWakeLock();
        }
      });
    }
  } catch (e) {
    console.warn('[wakelock] not available:', e.message);
  }
}

function releaseWakeLock() {
  if (wakeLock) { wakeLock.release(); wakeLock = null; }
}

function startKeepAliveAudio() {
  // iOS Safari workaround: silent audio keeps JS alive in background
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const oscillator = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      gain.gain.value = 0.0001; // Nearly silent
      oscillator.connect(gain);
      gain.connect(audioCtx.destination);
      oscillator.start();
      console.log('[audio] keep-alive started');
    }
  } catch (e) {
    console.warn('[audio] keep-alive failed:', e.message);
  }
}

function stopKeepAliveAudio() {
  if (audioCtx) {
    audioCtx.close();
    audioCtx = null;
  }
}

/* ══════════════════════════════════════════════════════════════════════
   SERVICE WORKER & NOTIFICATIONS
══════════════════════════════════════════════════════════════════════ */

if ('serviceWorker' in navigator) {
  // Works on both localhost (/) and GitHub Pages (/porcupine/)
  const swPath = window.location.pathname.replace(/\/[^/]*$/, '/') + 'sw.js';
  navigator.serviceWorker.register(swPath).catch(e => console.warn('[sw] register failed:', e.message));
}

async function notifyCompletion(title, body) {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, { body, icon: '/favicon.ico' });
  } else if ('Notification' in window && Notification.permission !== 'denied') {
    const perm = await Notification.requestPermission();
    if (perm === 'granted') new Notification(title, { body, icon: '/favicon.ico' });
  }
}

/* ══════════════════════════════════════════════════════════════════════
   ERROR HANDLING
══════════════════════════════════════════════════════════════════════ */

function showError(message) {
  // Detect which view is active
  const sendActive = document.getElementById('view-send').classList.contains('active');
  const recvActive = document.getElementById('view-receive').classList.contains('active');

  if (recvActive) {
    setElById('otp-error', message);
    // Shake OTP boxes
    const row = document.getElementById('otp-row');
    if (row) { row.style.animation = 'none'; setTimeout(() => row.style.animation = '', 10); }
  } else {
    showToast('⚠️ ' + message);
  }
}

function showTransferError(mode, message) {
  releaseWakeLock();
  stopKeepAliveAudio();

  if (mode === 'send') {
    showSendStep(4);
    const icon = document.getElementById('send-result-icon');
    const title = document.getElementById('send-result-title');
    const sub = document.getElementById('send-result-sub');
    if (icon) { icon.textContent = '✕'; icon.classList.add('error-icon'); }
    if (title) title.textContent = 'Transfer failed';
    if (sub) sub.textContent = message;
  } else {
    showRecvStep(3);
    const icon = document.getElementById('recv-result-icon');
    const title = document.getElementById('recv-result-title');
    const sub = document.getElementById('recv-result-sub');
    if (icon) { icon.textContent = '✕'; icon.classList.add('error-icon'); }
    if (title) title.textContent = 'Download failed';
    if (sub) sub.textContent = message;
  }
}

function onPartnerDisconnected() {
  const sendActive = document.getElementById('view-send')?.classList.contains('active');
  const recvActive = document.getElementById('view-receive')?.classList.contains('active');

  if (sendActive) showTransferError('send', 'Receiver disconnected before transfer completed.');
  else if (recvActive) showTransferError('recv', 'Sender disconnected. Download incomplete.');
}

/* ══════════════════════════════════════════════════════════════════════
   CLEANUP
══════════════════════════════════════════════════════════════════════ */

function cleanup() {
  clearInterval(timerInterval);
  releaseWakeLock();
  stopKeepAliveAudio();

  if (dataChannel) { try { dataChannel.close(); } catch(_) {} dataChannel = null; }
  if (peerConnection) { try { peerConnection.close(); } catch(_) {} peerConnection = null; }

  receivedChunks = [];
  receivedBytes = 0;
  totalBytes = 0;
  writableStream = null;
  useStreamAPI = false;
  transferStartTime = null;
  pendingOffer = null;
  pendingCandidates = [];
}

/* ══════════════════════════════════════════════════════════════════════
   UI HELPERS
══════════════════════════════════════════════════════════════════════ */

function setElById(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setEl(stepId, className, text) {
  const el = document.querySelector(`#${stepId} .${className}`);
  if (el) el.textContent = text;
}

function populateFilePill(prefix, file) {
  const name = file.name || file;
  const size = typeof file.size === 'number' ? file.size : file;
  setElById(`${prefix}-file-name`, name);
  setElById(`${prefix}-file-size`, typeof size === 'number' ? formatBytes(size) : size);
  // Pick emoji by extension
  const ext = (name.split('.').pop() || '').toLowerCase();
  const emoji = { mp4:'🎬', mkv:'🎬', mov:'🎬', avi:'🎬', webm:'🎬',
    mp3:'🎵', wav:'🎵', flac:'🎵',
    jpg:'🖼️', jpeg:'🖼️', png:'🖼️', gif:'🖼️', webp:'🖼️',
    pdf:'📑', zip:'🗜️', rar:'🗜️', '7z':'🗜️',
    doc:'📝', docx:'📝', txt:'📝', xls:'📊', xlsx:'📊' }[ext] || '📄';
  setElById(`${prefix}-file-emoji`, emoji);
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(i > 1 ? 1 : 0) + ' ' + sizes[i];
}

function formatTime(seconds) {
  if (seconds < 60) return Math.round(seconds) + 's';
  if (seconds < 3600) return Math.round(seconds / 60) + 'm';
  return (seconds / 3600).toFixed(1) + 'h';
}

let toastTimer = null;
function showToast(message) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3000);
}
