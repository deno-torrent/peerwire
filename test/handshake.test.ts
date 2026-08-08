import { assertEquals, assertThrows } from "std/assert/mod.ts";
import { HANDSHAKE_LENGTH, HandshakeExtension } from "@src/constants.ts";
import { PeerWireProtocolError } from "@src/errors.ts";
import {
  decodeHandshake,
  encodeHandshake,
  hasExtension,
  setExtension,
} from "@src/handshake.ts";

const infoHash = Uint8Array.from({ length: 20 }, (_, index) => index);
const peerId = "-PW0001-123456789012";

Deno.test("handshake round trips IDs and extension flags", () => {
  const bytes = encodeHandshake({
    infoHash,
    peerId,
    extensions: [
      HandshakeExtension.ExtensionProtocol,
      HandshakeExtension.Dht,
      HandshakeExtension.Fast,
    ],
  });
  assertEquals(bytes.length, HANDSHAKE_LENGTH);

  const decoded = decodeHandshake(bytes);
  assertEquals(decoded.infoHash, infoHash);
  assertEquals(new TextDecoder().decode(decoded.peerId), peerId);
  assertEquals(
    [...decoded.extensions].sort(),
    Object.values(HandshakeExtension).sort(),
  );
});

Deno.test("handshake rejects invalid identifiers and protocol bytes", () => {
  assertThrows(
    () => encodeHandshake({ infoHash: new Uint8Array(19), peerId }),
    RangeError,
  );
  const bytes = encodeHandshake({ infoHash, peerId });
  bytes[1] = 0;
  assertThrows(() => decodeHandshake(bytes), PeerWireProtocolError);
  assertThrows(() => decodeHandshake(bytes.subarray(1)), PeerWireProtocolError);
});

Deno.test("handshake matches the BEP 3 byte layout", () => {
  const bytes = encodeHandshake({ infoHash, peerId });
  assertEquals(bytes[0], 19);
  assertEquals(
    new TextDecoder().decode(bytes.subarray(1, 20)),
    "BitTorrent protocol",
  );
  assertEquals(bytes.subarray(20, 28), new Uint8Array(8));
  assertEquals(bytes.subarray(28, 48), infoHash);
  assertEquals(new TextDecoder().decode(bytes.subarray(48)), peerId);
});

Deno.test("handshake preserves caller reserved bits without aliasing", () => {
  const reserved = new Uint8Array([1, 2, 4, 8, 16, 32, 64, 128]);
  const bytes = encodeHandshake({ infoHash, peerId, reserved });
  reserved.fill(0);

  const decoded = decodeHandshake(bytes);
  assertEquals(
    decoded.reserved,
    new Uint8Array([1, 2, 4, 8, 16, 32, 64, 128]),
  );
  decoded.reserved.fill(0);
  assertEquals(bytes[20], 1);
});

Deno.test("handshake validates reserved and UTF-8 peer ID byte lengths", () => {
  assertThrows(
    () =>
      encodeHandshake({
        infoHash,
        peerId,
        reserved: new Uint8Array(7),
      }),
    RangeError,
  );
  assertThrows(
    () => encodeHandshake({ infoHash, peerId: "四五六七八九十" }),
    RangeError,
  );
});

Deno.test("handshake extension helpers support toggling and invalid fields", () => {
  const reserved = new Uint8Array(8);
  setExtension(reserved, HandshakeExtension.Fast, true);
  assertEquals(hasExtension(reserved, HandshakeExtension.Fast), true);
  setExtension(reserved, HandshakeExtension.Fast, false);
  assertEquals(hasExtension(reserved, HandshakeExtension.Fast), false);
  assertEquals(
    hasExtension(new Uint8Array(7), HandshakeExtension.Fast),
    false,
  );
  assertThrows(
    () => setExtension(new Uint8Array(7), HandshakeExtension.Fast, true),
    RangeError,
  );
});
