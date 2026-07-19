

const net = require('net');


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


function encodeString(str) {
  const buf = Buffer.from(str, 'utf8');
  return Buffer.concat([encodeVarInt(buf.length), buf]);
}

function buildHandshake(host, port) {
  const body = Buffer.concat([
    encodeVarInt(0x00),
    encodeVarInt(767),
    encodeString(host),
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(port); return b; })(),
    encodeVarInt(1)
  ]);
  return Buffer.concat([encodeVarInt(body.length), body]);
}

function buildStatusRequest() {
  const body = encodeVarInt(0x00);
  return Buffer.concat([encodeVarInt(body.length), body]);
}


function ping(host, port = 25565, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const offlineResult = { online: false, ping: -1, players: { online: 0, max: 0 } };

    if (!host || host === 'YOUR_SERVER_IP') return resolve(offlineResult);

    const socket = new net.Socket();
    const start  = Date.now();
    let done     = false;
    let buf      = Buffer.alloc(0);
    let timer    = null;

    const finish = (result) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };

    const offline = () => finish(offlineResult);
    timer = setTimeout(offline, timeoutMs);

    socket.setTimeout(timeoutMs);
    socket.once('timeout', offline);
    socket.once('error', offline);
    socket.once('close', () => {
      if (!done) offline();
    });

    socket.connect(port, host, () => {
      socket.write(Buffer.concat([buildHandshake(host, port), buildStatusRequest()]));
    });

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);

      try {
        const { value: pktLen, bytesRead: pktLenSize } = decodeVarInt(buf, 0);
        if (buf.length < pktLenSize + pktLen) return;

        const { value: pktId, bytesRead: pktIdSize } = decodeVarInt(buf, pktLenSize);
        if (pktId !== 0x00) return;

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
      }
    });
  });
}

module.exports = { ping };
