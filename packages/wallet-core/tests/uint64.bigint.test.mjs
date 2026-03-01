import assert from "node:assert/strict";

const UINT64_MAX = 0xffffffffffffffffn;
const SHIFT_32 = 0x100000000n;

function writeUInt64LE(buffer, offset, value) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError("buffer must be Buffer");
  if (!Number.isInteger(offset) || offset < 0 || offset + 8 > buffer.length) {
    throw new RangeError("offset out of range");
  }
  if (typeof value !== "bigint") throw new TypeError("value must be bigint");
  if (value < 0n || value > UINT64_MAX) {
    throw new RangeError("value out of uint64 range");
  }

  if (typeof buffer.writeBigUInt64LE === "function") {
    buffer.writeBigUInt64LE(value, offset);
    return;
  }

  const lo = Number(value & 0xffffffffn);
  const hi = Number(value >> 32n);
  buffer.writeUInt32LE(lo, offset);
  buffer.writeUInt32LE(hi, offset + 4);
}

function readUInt64LE(buffer, offset) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError("buffer must be Buffer");
  if (!Number.isInteger(offset) || offset < 0 || offset + 8 > buffer.length) {
    throw new RangeError("offset out of range");
  }

  if (typeof buffer.readBigUInt64LE === "function") {
    return buffer.readBigUInt64LE(offset);
  }

  const lo = BigInt(buffer.readUInt32LE(offset));
  const hi = BigInt(buffer.readUInt32LE(offset + 4));
  return hi * SHIFT_32 + lo;
}

const value = 10000000000000000n;
const buf = Buffer.alloc(8);

writeUInt64LE(buf, 0, value);
assert.equal(buf.length, 8);

const decoded = readUInt64LE(buf, 0);
assert.equal(decoded, value);

console.log("[wallet-core] uint64 bigint round-trip ok", { hex: buf.toString("hex") });
