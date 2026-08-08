import { assertEquals, assertThrows } from "std/assert/mod.ts";
import { Bitfield } from "@src/bitfield.ts";
import { PeerWireProtocolError } from "@src/errors.ts";

Deno.test("Bitfield uses the peer wire MSB-first layout", () => {
  const bitfield = new Bitfield(10);
  bitfield.set(0);
  bitfield.set(7);
  bitfield.set(9);

  assertEquals(bitfield.toBytes(), new Uint8Array([0x81, 0x40]));
  assertEquals([...bitfield.availablePieces()], [0, 7, 9]);
  assertEquals(bitfield.completedCount, 3);

  bitfield.set(7, false);
  assertEquals(bitfield.has(7), false);
});

Deno.test("Bitfield copies source and result bytes", () => {
  const source = new Uint8Array([0x80]);
  const bitfield = Bitfield.fromBytes(8, source);
  source[0] = 0;
  const result = bitfield.toBytes();
  result[0] = 0;
  assertEquals(bitfield.has(0), true);
});

Deno.test("Bitfield rejects invalid spare bits and indexes", () => {
  assertThrows(() => new Bitfield(-1), RangeError);
  assertThrows(() => new Bitfield(1.5), RangeError);
  assertThrows(
    () => Bitfield.fromBytes(9, new Uint8Array(1)),
    PeerWireProtocolError,
  );
  assertThrows(
    () => Bitfield.fromBytes(9, new Uint8Array([0, 1])),
    PeerWireProtocolError,
  );
  const bitfield = new Bitfield(1);
  assertThrows(() => bitfield.has(1), RangeError);
});

Deno.test("Bitfield handles byte boundaries and empty torrents", () => {
  for (const pieceCount of [0, 1, 7, 8, 9, 63, 64, 65]) {
    const bitfield = new Bitfield(pieceCount);
    assertEquals(bitfield.byteLength, Math.ceil(pieceCount / 8));
    for (let index = 0; index < pieceCount; index++) {
      if ((index & 1) === 0) bitfield.set(index);
    }
    const decoded = Bitfield.fromBytes(pieceCount, bitfield.toBytes());
    assertEquals(
      [...decoded.availablePieces()],
      Array.from({ length: pieceCount }, (_, index) => index).filter((index) =>
        (index & 1) === 0
      ),
    );
    decoded.clear();
    assertEquals(decoded.completedCount, 0);
  }
});
