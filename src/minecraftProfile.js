const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const config = require('../config');

const TAG_END = 0;
const TAG_BYTE = 1;
const TAG_SHORT = 2;
const TAG_INT = 3;
const TAG_LONG = 4;
const TAG_FLOAT = 5;
const TAG_DOUBLE = 6;
const TAG_BYTE_ARRAY = 7;
const TAG_STRING = 8;
const TAG_LIST = 9;
const TAG_COMPOUND = 10;
const TAG_INT_ARRAY = 11;
const TAG_LONG_ARRAY = 12;

function getServerAddress() {
  const port = Number(config.SERVER_PORT) || 25565;
  return port === 25565 ? String(config.SERVER_IP) : `${config.SERVER_IP}:${port}`;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readString(reader) {
  const len = reader.buf.readUInt16BE(reader.offset);
  reader.offset += 2;
  const value = reader.buf.slice(reader.offset, reader.offset + len).toString('utf8');
  reader.offset += len;
  return value;
}

function writeString(value) {
  const buf = Buffer.from(String(value), 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(buf.length);
  return Buffer.concat([len, buf]);
}

function readPayload(reader, type) {
  switch (type) {
    case TAG_BYTE: {
      const value = reader.buf.readInt8(reader.offset);
      reader.offset += 1;
      return value;
    }
    case TAG_SHORT: {
      const value = reader.buf.readInt16BE(reader.offset);
      reader.offset += 2;
      return value;
    }
    case TAG_INT: {
      const value = reader.buf.readInt32BE(reader.offset);
      reader.offset += 4;
      return value;
    }
    case TAG_LONG: {
      const value = reader.buf.readBigInt64BE(reader.offset);
      reader.offset += 8;
      return value;
    }
    case TAG_FLOAT: {
      const value = reader.buf.readFloatBE(reader.offset);
      reader.offset += 4;
      return value;
    }
    case TAG_DOUBLE: {
      const value = reader.buf.readDoubleBE(reader.offset);
      reader.offset += 8;
      return value;
    }
    case TAG_BYTE_ARRAY: {
      const len = reader.buf.readInt32BE(reader.offset);
      reader.offset += 4;
      const value = reader.buf.slice(reader.offset, reader.offset + len);
      reader.offset += len;
      return value;
    }
    case TAG_STRING:
      return readString(reader);
    case TAG_LIST: {
      const itemType = reader.buf.readUInt8(reader.offset);
      reader.offset += 1;
      const len = reader.buf.readInt32BE(reader.offset);
      reader.offset += 4;
      const value = [];
      for (let i = 0; i < len; i++) value.push(readPayload(reader, itemType));
      return { itemType, value };
    }
    case TAG_COMPOUND: {
      const value = {};
      while (reader.offset < reader.buf.length) {
        const tag = readNamedTag(reader);
        if (!tag) break;
        value[tag.name] = tag;
      }
      return value;
    }
    case TAG_INT_ARRAY: {
      const len = reader.buf.readInt32BE(reader.offset);
      reader.offset += 4;
      const value = [];
      for (let i = 0; i < len; i++) {
        value.push(reader.buf.readInt32BE(reader.offset));
        reader.offset += 4;
      }
      return value;
    }
    case TAG_LONG_ARRAY: {
      const len = reader.buf.readInt32BE(reader.offset);
      reader.offset += 4;
      const value = [];
      for (let i = 0; i < len; i++) {
        value.push(reader.buf.readBigInt64BE(reader.offset));
        reader.offset += 8;
      }
      return value;
    }
    default:
      throw new Error(`Unsupported NBT tag: ${type}`);
  }
}

function readNamedTag(reader) {
  const type = reader.buf.readUInt8(reader.offset);
  reader.offset += 1;
  if (type === TAG_END) return null;
  const name = readString(reader);
  const payload = readPayload(reader, type);
  if (type === TAG_LIST) return { type, name, itemType: payload.itemType, value: payload.value };
  return { type, name, value: payload };
}

function writePayload(type, value) {
  switch (type) {
    case TAG_BYTE: {
      const buf = Buffer.alloc(1);
      buf.writeInt8(Number(value) || 0);
      return buf;
    }
    case TAG_SHORT: {
      const buf = Buffer.alloc(2);
      buf.writeInt16BE(Number(value) || 0);
      return buf;
    }
    case TAG_INT: {
      const buf = Buffer.alloc(4);
      buf.writeInt32BE(Number(value) || 0);
      return buf;
    }
    case TAG_LONG: {
      const buf = Buffer.alloc(8);
      buf.writeBigInt64BE(BigInt(value || 0));
      return buf;
    }
    case TAG_FLOAT: {
      const buf = Buffer.alloc(4);
      buf.writeFloatBE(Number(value) || 0);
      return buf;
    }
    case TAG_DOUBLE: {
      const buf = Buffer.alloc(8);
      buf.writeDoubleBE(Number(value) || 0);
      return buf;
    }
    case TAG_BYTE_ARRAY: {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
      const len = Buffer.alloc(4);
      len.writeInt32BE(bytes.length);
      return Buffer.concat([len, bytes]);
    }
    case TAG_STRING:
      return writeString(value || '');
    case TAG_LIST: {
      const itemType = value.itemType || TAG_END;
      const items = Array.isArray(value.value) ? value.value : [];
      const head = Buffer.alloc(5);
      head.writeUInt8(itemType, 0);
      head.writeInt32BE(items.length, 1);
      return Buffer.concat([head, ...items.map(item => writePayload(itemType, item))]);
    }
    case TAG_COMPOUND:
      return Buffer.concat([...Object.values(value || {}).map(writeNamedTag), Buffer.from([TAG_END])]);
    case TAG_INT_ARRAY: {
      const items = Array.isArray(value) ? value : [];
      const head = Buffer.alloc(4);
      head.writeInt32BE(items.length);
      const body = items.map(item => {
        const buf = Buffer.alloc(4);
        buf.writeInt32BE(Number(item) || 0);
        return buf;
      });
      return Buffer.concat([head, ...body]);
    }
    case TAG_LONG_ARRAY: {
      const items = Array.isArray(value) ? value : [];
      const head = Buffer.alloc(4);
      head.writeInt32BE(items.length);
      const body = items.map(item => {
        const buf = Buffer.alloc(8);
        buf.writeBigInt64BE(BigInt(item || 0));
        return buf;
      });
      return Buffer.concat([head, ...body]);
    }
    default:
      throw new Error(`Unsupported NBT tag: ${type}`);
  }
}

function writeNamedTag(tag) {
  const payload = tag.type === TAG_LIST
    ? { itemType: tag.itemType, value: tag.value }
    : tag.value;
  return Buffer.concat([Buffer.from([tag.type]), writeString(tag.name), writePayload(tag.type, payload)]);
}

function readNbtFile(filePath) {
  let buf = fs.readFileSync(filePath);
  let compression = 'none';
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    buf = zlib.gunzipSync(buf);
    compression = 'gzip';
  } else if (buf[0] === 0x78) {
    try {
      buf = zlib.inflateSync(buf);
      compression = 'zlib';
    } catch (_) {}
  }
  const reader = { buf, offset: 0 };
  const type = reader.buf.readUInt8(reader.offset);
  reader.offset += 1;
  if (type !== TAG_COMPOUND) throw new Error('Invalid servers.dat');
  const name = readString(reader);
  return { root: { type, name, value: readPayload(reader, type) }, compression };
}

function writeNbtFile(filePath, root, compression) {
  const raw = Buffer.concat([Buffer.from([root.type]), writeString(root.name || ''), writePayload(root.type, root.value)]);
  const data = compression === 'gzip'
    ? zlib.gzipSync(raw)
    : compression === 'zlib'
      ? zlib.deflateSync(raw)
      : raw;
  fs.writeFileSync(filePath, data);
}

function createRoot() {
  return {
    type: TAG_COMPOUND,
    name: '',
    value: {
      servers: { type: TAG_LIST, name: 'servers', itemType: TAG_COMPOUND, value: [] }
    }
  };
}

function createServerEntry(address) {
  const entry = {
    name: { type: TAG_STRING, name: 'name', value: config.LAUNCHER_NAME || 'VoID Cube' },
    ip: { type: TAG_STRING, name: 'ip', value: address }
  };
  const icon = readServerIcon();
  if (icon) entry.icon = { type: TAG_STRING, name: 'icon', value: icon };
  return entry;
}

function readServerIcon() {
  const candidates = [
    path.join(__dirname, '..', 'assets', 'server-icon.png'),
    path.join(__dirname, '..', 'assets', 'icon.png')
  ];
  for (const filePath of candidates) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const data = fs.readFileSync(filePath);
      if (data.length < 24 || data.toString('ascii', 1, 4) !== 'PNG') continue;
      return `data:image/png;base64,${data.toString('base64')}`;
    } catch (_) {}
  }
  return null;
}

function ensureServersTag(root) {
  if (!root.value || typeof root.value !== 'object') root.value = {};
  const tag = root.value.servers;
  if (!tag || tag.type !== TAG_LIST || tag.itemType !== TAG_COMPOUND || !Array.isArray(tag.value)) {
    root.value.servers = { type: TAG_LIST, name: 'servers', itemType: TAG_COMPOUND, value: [] };
  }
  return root.value.servers;
}

function tagText(compound, key) {
  const tag = compound && compound[key];
  return tag && tag.type === TAG_STRING ? String(tag.value) : '';
}

function ensureServersDat(gameDir, address) {
  const filePath = path.join(gameDir, 'servers.dat');
  let root = createRoot();
  let compression = 'none';
  try {
    if (fs.existsSync(filePath)) {
      const parsed = readNbtFile(filePath);
      root = parsed.root;
      compression = parsed.compression;
    }
  } catch (_) {
    root = createRoot();
    compression = 'none';
  }

  const servers = ensureServersTag(root);
  const launcherName = String(config.LAUNCHER_NAME || 'VoID Cube').toLowerCase();
  const host = String(config.SERVER_IP).toLowerCase();
  const fullAddress = address.toLowerCase();

  servers.value = servers.value.filter(server => {
    const name = tagText(server, 'name').toLowerCase();
    const ip = tagText(server, 'ip').toLowerCase();
    if (name === launcherName) return false;
    if (ip === fullAddress || ip === host || ip.startsWith(`${host}:`)) return false;
    return true;
  });
  servers.value.unshift(createServerEntry(address));

  writeNbtFile(filePath, root, compression);
}

function upsertOption(lines, key, value) {
  let replaced = false;
  const out = [];
  for (const line of lines) {
    if (line.startsWith(`${key}:`)) {
      if (!replaced) {
        out.push(`${key}:${value}`);
        replaced = true;
      }
    } else {
      out.push(line);
    }
  }
  if (!replaced) out.push(`${key}:${value}`);
  return out;
}

function ensureOptions(gameDir, address) {
  const optionsPath = path.join(gameDir, 'options.txt');
  const text = fs.existsSync(optionsPath) ? fs.readFileSync(optionsPath, 'utf8') : '';
  const normalized = text.replace(/\r\n?/g, '\n').replace(/\n*$/, '');
  let lines = normalized ? normalized.split('\n') : [];
  lines = upsertOption(lines, 'lang', 'ru_ru');
  lines = upsertOption(lines, 'lastServer', address);
  fs.writeFileSync(optionsPath, `${lines.join('\n')}\n`, 'utf8');
}

function ensureServerShortcuts(gameDir) {
  ensureDir(gameDir);
  const address = getServerAddress();
  ensureOptions(gameDir, address);
  ensureServersDat(gameDir, address);
  return address;
}

module.exports = { ensureServerShortcuts, getServerAddress };
