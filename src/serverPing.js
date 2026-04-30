/**
 * serverPing.js
 * Minecraft 1.7+ server list ping protocol over raw TCP.
 */

const net = require('net');

// ─── VarInt encoding ─────────────────────────────────────────────────────────

function encodeVarInt(value) {
  const bytes = [];
  do {
    let b = value & 0x7f;
    value >>>= 7;
    if (value !== 0) b |= 0x80;
    bytes.push(b);
  } while (value !== 0);
  return Buffer.from(bytes);
}

function decodeVarInt(buf, offset) {
  let value = 0;
  let shift  = 0;
  let read   = 0;
  let byte;
  do {
    if (offset + read >= buf.length) throw new Error('Buffer underflow reading VarInt');
    byte = buf[offset + read];
    value |= (byte & 0x7f) << shift;
    shift += 7;
    read++;
    if (shift >= 35) throw new Error('VarInt too large');
  } while (byte & 0x80);
  return { value, bytesRead: read };
}

// ─── Packet builder ──────────────────────────────────────────────────────────

function encodeString(str) {
  const buf = Buffer.from(str, 'utf8');
  return Buffer.concat([encodeVarInt(buf.length), buf]);
}

function buildHandshake(host, port) {
  // Packet 0x00 Handshake
  const body = Buffer.concat([
    encodeVarInt(0x00),          // Packet ID
    encodeVarInt(767),           // Protocol version (1.21.1 = 767)
    encodeString(host),          // Server address
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(port); return b; })(),
    encodeVarInt(1)              // Next state: STATUS
  ]);
  return Buffer.concat([encodeVarInt(body.length), body]);
}

function buildStatusRequest() {
  // Packet 0x00 Status Request (empty body)
  const body = encodeVarInt(0x00);
  return Buffer.concat([encodeVarInt(body.length), body]);
}

// ─── Main ping ───────────────────────────────────────────────────────────────

function ping(host, port = 25565, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const offline = () => resolve({ online: false, ping: -1, players: { online: 0, max: 0 } });

    if (!host || host === 'YOUR_SERVER_IP') return offline();

    const socket = new net.Socket();
    const start  = Date.now();
    let done     = false;
    let buf      = Buffer.alloc(0);

    const finish = (result) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.on('timeout', offline);
    socket.on('error',   offline);

    socket.connect(port, host, () => {
      socket.write(Buffer.concat([buildHandshake(host, port), buildStatusRequest()]));
    });

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);

      try {
        // Outer: packet length
        const { value: pktLen, bytesRead: pktLenSize } = decodeVarInt(buf, 0);
        if (buf.length < pktLenSize + pktLen) return; // need more data

        // Packet ID
        const { value: pktId, bytesRead: pktIdSize } = decodeVarInt(buf, pktLenSize);
        if (pktId !== 0x00) return;

        // JSON string
        const jsonOff = pktLenSize + pktIdSize;
        const { value: jsonLen, bytesRead: jsonLenSize } = decodeVarInt(buf, jsonOff);
        const jsonStart = jsonOff + jsonLenSize;
        const jsonEnd   = jsonStart + jsonLen;

        if (buf.length < jsonEnd) return;

        const jsonStr  = buf.slice(jsonStart, jsonEnd).toString('utf8');
        const response = JSON.parse(jsonStr);

        finish({
          online:  true,
          ping:    Date.now() - start,
          players: {
            online: response.players?.online ?? 0,
            max:    response.players?.max    ?? 0
          },
          motd:    typeof response.description === 'string'
            ? response.description
            : response.description?.text ?? '',
          version: response.version?.name ?? ''
        });
      } catch (_) {
        // Incomplete data — wait for more
      }
    });
  });
}

module.exports = { ping };
