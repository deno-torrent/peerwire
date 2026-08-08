import { assertEquals, assertThrows } from "std/assert/mod.ts";
import { PeerWireProtocolError } from "@src/errors.ts";
import {
  decodeMessage,
  decodeMessagePayload,
  encodeMessage,
  type PeerMessage,
} from "@src/message.ts";

const messages: PeerMessage[] = [
  { type: "keepAlive" },
  { type: "choke" },
  { type: "unchoke" },
  { type: "interested" },
  { type: "notInterested" },
  { type: "have", pieceIndex: 0x10203040 },
  { type: "bitfield", bitfield: new Uint8Array([0xaa, 0x80]) },
  { type: "request", pieceIndex: 5, begin: 16_384, length: 16_384 },
  {
    type: "piece",
    pieceIndex: 5,
    begin: 16_384,
    block: new Uint8Array([1, 2, 3]),
  },
  { type: "cancel", pieceIndex: 5, begin: 0, length: 16_384 },
  { type: "port", port: 6881 },
  { type: "suggestPiece", pieceIndex: 42 },
  { type: "haveAll" },
  { type: "haveNone" },
  { type: "rejectRequest", pieceIndex: 5, begin: 0, length: 16_384 },
  { type: "allowedFast", pieceIndex: 7 },
  { type: "extended", extensionId: 1, payload: new Uint8Array([100, 1]) },
  {
    type: "hashRequest",
    piecesRoot: new Uint8Array(32).fill(1),
    baseLayer: 0,
    index: 0,
    length: 2,
    proofLayers: 1,
  },
  {
    type: "hashes",
    piecesRoot: new Uint8Array(32).fill(2),
    baseLayer: 0,
    index: 0,
    length: 2,
    proofLayers: 1,
    hashes: new Uint8Array(64).fill(3),
  },
  {
    type: "hashReject",
    piecesRoot: new Uint8Array(32).fill(4),
    baseLayer: 0,
    index: 0,
    length: 2,
    proofLayers: 1,
  },
  { type: "unknown", id: 99, payload: new Uint8Array([7, 8]) },
];

Deno.test("all supported messages round trip", async (test) => {
  for (const message of messages) {
    await test.step(message.type, () => {
      assertEquals(decodeMessage(encodeMessage(message)), message);
    });
  }
});

Deno.test("message codec validates frame and fixed message lengths", () => {
  assertThrows(() => decodeMessage(new Uint8Array(3)), PeerWireProtocolError);
  assertThrows(
    () => decodeMessagePayload(new Uint8Array()),
    PeerWireProtocolError,
  );
  assertThrows(
    () => decodeMessage(new Uint8Array([0, 0, 0, 2, 0])),
    PeerWireProtocolError,
  );
  assertThrows(
    () => decodeMessage(new Uint8Array([0, 0, 0, 2, 0, 1])),
    PeerWireProtocolError,
  );
  assertThrows(
    () =>
      encodeMessage({ type: "request", pieceIndex: 0, begin: 0, length: 0 }),
    RangeError,
  );
});

Deno.test("message encoding matches BEP network byte order", () => {
  assertEquals(
    encodeMessage({ type: "choke" }),
    new Uint8Array([0, 0, 0, 1, 0]),
  );
  assertEquals(
    encodeMessage({ type: "have", pieceIndex: 0x01020304 }),
    new Uint8Array([0, 0, 0, 5, 4, 1, 2, 3, 4]),
  );
  assertEquals(
    encodeMessage({
      type: "request",
      pieceIndex: 1,
      begin: 0x4000,
      length: 0x4000,
    }),
    new Uint8Array([
      0,
      0,
      0,
      13,
      6,
      0,
      0,
      0,
      1,
      0,
      0,
      0x40,
      0,
      0,
      0,
      0x40,
      0,
    ]),
  );
  assertEquals(
    encodeMessage({ type: "port", port: 6881 }),
    new Uint8Array([0, 0, 0, 3, 9, 0x1a, 0xe1]),
  );
  assertEquals(
    encodeMessage({
      type: "extended",
      extensionId: 0,
      payload: new TextEncoder().encode("de"),
    }),
    new Uint8Array([0, 0, 0, 4, 20, 0, 100, 101]),
  );
});

Deno.test("known message IDs reject every invalid fixed body length", () => {
  const fixedLengths = new Map<number, number>([
    [0, 0],
    [1, 0],
    [2, 0],
    [3, 0],
    [4, 4],
    [6, 12],
    [8, 12],
    [9, 2],
    [13, 4],
    [14, 0],
    [15, 0],
    [16, 12],
    [17, 4],
  ]);
  for (const [id, validLength] of fixedLengths) {
    for (
      const invalidLength of new Set([
        Math.max(0, validLength - 1),
        validLength + 1,
      ])
    ) {
      if (invalidLength === validLength) continue;
      assertThrows(
        () => decodeMessage(makeFrame(id, new Uint8Array(invalidLength))),
        PeerWireProtocolError,
      );
    }
  }
  assertThrows(
    () => decodeMessage(makeFrame(7, new Uint8Array(7))),
    PeerWireProtocolError,
  );
  assertThrows(
    () => decodeMessage(makeFrame(20, new Uint8Array())),
    PeerWireProtocolError,
  );
});

Deno.test("message codec round trips deterministic randomized values", () => {
  let state = 0xc0ffee;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  for (let iteration = 0; iteration < 500; iteration++) {
    const byteLength = random() % 257;
    const bytes = Uint8Array.from(
      { length: byteLength },
      () => random() & 0xff,
    );
    let message: PeerMessage;
    switch (random() % 9) {
      case 0:
        message = { type: "have", pieceIndex: random() };
        break;
      case 1:
        message = { type: "bitfield", bitfield: bytes };
        break;
      case 2:
        message = {
          type: "request",
          pieceIndex: random(),
          begin: random(),
          length: (random() || 1) >>> 0,
        };
        break;
      case 3:
        message = {
          type: "piece",
          pieceIndex: random(),
          begin: random(),
          block: bytes,
        };
        break;
      case 4:
        message = { type: "port", port: random() & 0xffff };
        break;
      case 5:
        message = { type: "suggestPiece", pieceIndex: random() };
        break;
      case 6:
        message = {
          type: "rejectRequest",
          pieceIndex: random(),
          begin: random(),
          length: (random() || 1) >>> 0,
        };
        break;
      case 7:
        message = {
          type: "extended",
          extensionId: random() & 0xff,
          payload: bytes,
        };
        break;
      default:
        message = { type: "unknown", id: 200, payload: bytes };
    }
    assertEquals(decodeMessage(encodeMessage(message)), message);
  }
});

Deno.test("message codec validates numeric ranges and copies byte payloads", () => {
  assertThrows(
    () => encodeMessage({ type: "have", pieceIndex: -1 }),
    RangeError,
  );
  assertThrows(
    () => encodeMessage({ type: "unknown", id: -1, payload: new Uint8Array() }),
    RangeError,
  );
  assertThrows(
    () =>
      decodeMessage(
        makeFrame(
          6,
          new Uint8Array(12),
        ),
      ),
    PeerWireProtocolError,
  );
  assertThrows(
    () => encodeMessage({ type: "port", port: 65_536 }),
    RangeError,
  );
  assertThrows(
    () =>
      encodeMessage({
        type: "extended",
        extensionId: 256,
        payload: new Uint8Array(),
      }),
    RangeError,
  );

  const source = new Uint8Array([1, 2, 3]);
  const frame = encodeMessage({
    type: "piece",
    pieceIndex: 0,
    begin: 0,
    block: source,
  });
  source.fill(9);
  assertEquals(
    decodeMessage(frame),
    {
      type: "piece",
      pieceIndex: 0,
      begin: 0,
      block: new Uint8Array([1, 2, 3]),
    },
  );
});

function makeFrame(id: number, body: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + body.length);
  new DataView(frame.buffer).setUint32(0, 1 + body.length);
  frame[4] = id;
  frame.set(body, 5);
  return frame;
}
