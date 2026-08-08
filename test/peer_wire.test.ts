import { assertEquals, assertRejects, assertThrows } from "std/assert/mod.ts";
import { HandshakeExtension } from "@src/constants.ts";
import {
  PeerWireEofError,
  PeerWireError,
  PeerWireProtocolError,
} from "@src/errors.ts";
import { encodeMessage, type PeerMessage } from "@src/message.ts";
import {
  PeerWire,
  PeerWireState,
  type PeerWireTransport,
} from "@src/peer_wire.ts";
import { memoryTransportPair } from "./_memory_transport.ts";

const infoHash = Uint8Array.from({ length: 20 }, (_, index) => index + 1);

function createWires(maxChunk = Infinity, rightInfoHash = infoHash) {
  const [leftTransport, rightTransport] = memoryTransportPair(maxChunk);
  const left = new PeerWire({
    transport: leftTransport,
    infoHash,
    peerId: "-PW0001-LEFT00000000",
    pieceCount: 10,
    extensions: [HandshakeExtension.ExtensionProtocol],
  });
  const right = new PeerWire({
    transport: rightTransport,
    infoHash: rightInfoHash,
    peerId: "-PW0001-RIGHT0000000",
    pieceCount: 10,
  });
  return { left, right, leftTransport, rightTransport };
}

Deno.test("PeerWire exchanges handshakes over partial reads and writes", async () => {
  const { left, right } = createWires(3);
  const [leftRemote, rightRemote] = await Promise.all([
    left.handshake(),
    right.handshake(),
  ]);

  assertEquals(left.state, PeerWireState.Connected);
  assertEquals(right.state, PeerWireState.Connected);
  assertEquals(
    new TextDecoder().decode(leftRemote.peerId),
    "-PW0001-RIGHT0000000",
  );
  assertEquals(
    rightRemote.extensions.has(HandshakeExtension.ExtensionProtocol),
    true,
  );

  await Promise.all([left.interested(), left.unchoke()]);
  assertEquals(await right.readMessage(), { type: "interested" });
  assertEquals(await right.readMessage(), { type: "unchoke" });
  assertEquals(left.localInterested, true);
  assertEquals(left.localChoking, false);
  assertEquals(right.remoteInterested, true);
  assertEquals(right.remoteChoking, false);

  await Promise.all([left.close(), right.close()]);
});

Deno.test("PeerWire transfers blocks and tracks remote availability", async () => {
  const { left, right } = createWires(5);
  await Promise.all([left.handshake(), right.handshake()]);

  await left.bitfield(new Uint8Array([0x80, 0x40]));
  assertEquals((await right.readMessage())?.type, "bitfield");
  assertEquals([...right.remoteBitfield!.availablePieces()], [0, 9]);

  await left.have(4);
  assertEquals(await right.readMessage(), { type: "have", pieceIndex: 4 });
  assertEquals([...right.remoteBitfield!.availablePieces()], [0, 4, 9]);

  const block = Uint8Array.from({ length: 16_384 }, (_, index) => index & 0xff);
  await left.piece(3, 16_384, block);
  assertEquals(await right.readMessage(), {
    type: "piece",
    pieceIndex: 3,
    begin: 16_384,
    block,
  });
  assertEquals(left.uploadedBytes, right.downloadedBytes);

  await Promise.all([left.close(), right.close()]);
});

Deno.test("PeerWire rejects a handshake for another torrent", async () => {
  const otherHash = new Uint8Array(20).fill(9);
  const { left, right } = createWires(Infinity, otherHash);
  const results = await Promise.allSettled([
    left.handshake(),
    right.handshake(),
  ]);
  assertEquals(results[0].status, "rejected");
  assertEquals(results[1].status, "rejected");
  if (results[0].status === "rejected") {
    assertEquals(results[0].reason instanceof PeerWireProtocolError, true);
  }
  await Promise.all([left.close(), right.close()]);
});

Deno.test("PeerWire rejects oversized incoming frames before allocation", async () => {
  const { left, right, leftTransport } = createWires();
  await Promise.all([left.handshake(), right.handshake()]);
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, right.maxMessageLength + 1);
  await leftTransport.write(prefix);
  await assertRejects(() => right.readMessage(), PeerWireProtocolError);
  await Promise.all([left.close(), right.close()]);
});

Deno.test("PeerWire serializes a burst of concurrent partial writes", async () => {
  const { left, right } = createWires(1);
  await Promise.all([left.handshake(), right.handshake()]);

  await Promise.all(
    Array.from({ length: 100 }, (_, pieceIndex) => left.have(pieceIndex % 10)),
  );
  for (let pieceIndex = 0; pieceIndex < 100; pieceIndex++) {
    assertEquals(await right.readMessage(), {
      type: "have",
      pieceIndex: pieceIndex % 10,
    });
  }
  await Promise.all([left.close(), right.close()]);
});

Deno.test("PeerWire async iterator ends at clean EOF", async () => {
  const { left, right } = createWires();
  await Promise.all([left.handshake(), right.handshake()]);
  await left.have(1);
  await left.have(2);
  await left.close();

  const received: PeerMessage[] = [];
  for await (const message of right) received.push(message);
  assertEquals(received, [
    { type: "have", pieceIndex: 1 },
    { type: "have", pieceIndex: 2 },
  ]);
  await right.close();
});

Deno.test("PeerWire distinguishes truncated frames from clean EOF", async () => {
  const { left, right, leftTransport } = createWires();
  await Promise.all([left.handshake(), right.handshake()]);
  await leftTransport.write(new Uint8Array([0, 0, 0, 5, 4, 0]));
  leftTransport.close();

  await assertRejects(() => right.readMessage(), PeerWireEofError);
  await Promise.all([left.close(), right.close()]);
});

Deno.test("PeerWire rejects concurrent reads without corrupting the stream", async () => {
  const { left, right } = createWires();
  await Promise.all([left.handshake(), right.handshake()]);

  const firstRead = right.readMessage();
  await assertRejects(() => right.readMessage(), PeerWireError);
  await left.send({ type: "keepAlive" });
  assertEquals(await firstRead, { type: "keepAlive" });
  await Promise.all([left.close(), right.close()]);
});

Deno.test("PeerWire enforces negotiated extension capabilities", async () => {
  const [leftTransport, rightTransport] = memoryTransportPair(2);
  const extensions = Object.values(HandshakeExtension);
  const left = new PeerWire({
    transport: leftTransport,
    infoHash,
    peerId: "-PW0001-LEFT00000000",
    pieceCount: 10,
    extensions,
  });
  const right = new PeerWire({
    transport: rightTransport,
    infoHash,
    peerId: "-PW0001-RIGHT0000000",
    pieceCount: 10,
    extensions,
  });
  await Promise.all([left.handshake(), right.handshake()]);

  // Automatic BEP 10 handshakes are the first extended frames.
  assertEquals((await left.readMessage())?.type, "extended");
  assertEquals((await right.readMessage())?.type, "extended");

  await left.haveAll();
  assertEquals(await right.readMessage(), { type: "haveAll" });
  assertEquals(right.remoteBitfield?.completedCount, 10);
  await right.haveNone();
  assertEquals(await left.readMessage(), { type: "haveNone" });

  await left.port(6881);
  assertEquals(await right.readMessage(), { type: "port", port: 6881 });
  await left.extended(0, new TextEncoder().encode("de"));
  assertEquals(await right.readMessage(), {
    type: "extended",
    extensionId: 0,
    payload: new TextEncoder().encode("de"),
  });
  await left.choke();
  assertEquals(await right.readMessage(), { type: "choke" });
  assertEquals(right.remoteChoking, true);
  await left.notInterested();
  assertEquals(await right.readMessage(), { type: "notInterested" });
  assertEquals(right.remoteInterested, false);

  await left.cancel(2, 0, 16_384);
  assertEquals(await right.readMessage(), {
    type: "cancel",
    pieceIndex: 2,
    begin: 0,
    length: 16_384,
  });

  for (
    const message of [
      { type: "suggestPiece", pieceIndex: 2 } as const,
      { type: "allowedFast", pieceIndex: 2 } as const,
    ]
  ) {
    await left.send(message);
    assertEquals(await right.readMessage(), message);
  }
  assertEquals(right.remoteBitfield?.completedCount, 10);
  await Promise.all([left.close(), right.close()]);
});

Deno.test("PeerWire rejects extension messages without negotiation", async () => {
  const { left, right, leftTransport } = createWires();
  await Promise.all([left.handshake(), right.handshake()]);

  await assertRejects(
    () => left.send({ type: "haveNone" }),
    PeerWireProtocolError,
  );
  const rawPort = encodeMessage({ type: "port", port: 6881 });
  await leftTransport.write(rawPort);
  await assertRejects(() => right.readMessage(), PeerWireProtocolError);
  await Promise.all([left.close(), right.close()]);
});

Deno.test("PeerWire validates expected peer ID and remote piece indexes", async () => {
  const [leftTransport, rightTransport] = memoryTransportPair();
  const left = new PeerWire({
    transport: leftTransport,
    infoHash,
    peerId: "-PW0001-LEFT00000000",
    expectedPeerId: "-PW0001-WRONG0000000",
  });
  const right = new PeerWire({
    transport: rightTransport,
    infoHash,
    peerId: "-PW0001-RIGHT0000000",
  });
  const results = await Promise.allSettled([
    left.handshake(),
    right.handshake(),
  ]);
  assertEquals(results[0].status, "rejected");
  await Promise.all([left.close(), right.close()]);

  const pair = createWires();
  await Promise.all([pair.left.handshake(), pair.right.handshake()]);
  await assertRejects(() => pair.left.have(10), RangeError);
  await Promise.all([pair.left.close(), pair.right.close()]);
});

Deno.test("PeerWire validates construction and closed state", async () => {
  const [transport, unusedTransport] = memoryTransportPair();
  assertThrows(
    () =>
      new PeerWire({
        transport,
        infoHash: new Uint8Array(19),
        peerId: "-PW0001-VALID0000000",
      }),
    RangeError,
  );
  assertThrows(
    () => new PeerWire({ transport, infoHash, peerId: "short" }),
    RangeError,
  );
  assertThrows(
    () =>
      new PeerWire({
        transport,
        infoHash,
        peerId: "-PW0001-VALID0000000",
        expectedPeerId: "short",
      }),
    RangeError,
  );
  assertThrows(
    () =>
      new PeerWire({
        transport,
        infoHash,
        peerId: "-PW0001-VALID0000000",
        pieceCount: -1,
      }),
    RangeError,
  );
  assertThrows(
    () =>
      new PeerWire({
        transport,
        infoHash,
        peerId: "-PW0001-VALID0000000",
        maxMessageLength: 0,
      }),
    RangeError,
  );
  const byteIdWire = new PeerWire({
    transport,
    infoHash,
    peerId: new Uint8Array(20),
    expectedPeerId: new Uint8Array(20),
  });
  await byteIdWire.close();
  unusedTransport.close();

  const { left, right } = createWires();
  await assertRejects(() => left.have(0), PeerWireError);
  await Promise.all([left.handshake(), right.handshake()]);
  await assertRejects(() => left.sendHandshake(), PeerWireError);
  await assertRejects(() => left.receiveHandshake(), PeerWireError);
  await left.close();
  await left.close();
  await assertRejects(() => left.have(0), PeerWireError);
  await right.close();
});

Deno.test("PeerWire enforces outgoing size limits", async () => {
  const [leftTransport, rightTransport] = memoryTransportPair();
  const left = new PeerWire({
    transport: leftTransport,
    infoHash,
    peerId: "-PW0001-LEFT00000000",
    maxMessageLength: 1,
  });
  const right = new PeerWire({
    transport: rightTransport,
    infoHash,
    peerId: "-PW0001-RIGHT0000000",
  });
  await Promise.all([left.handshake(), right.handshake()]);
  await assertRejects(() => left.have(0), RangeError);
  await Promise.all([left.close(), right.close()]);
});

Deno.test("PeerWire rejects invalid transport read and write counts", async () => {
  const invalidWrite = (count: number): PeerWireTransport => ({
    read: () => Promise.resolve(null),
    write: (buffer) => Promise.resolve(count < 0 ? buffer.length + 1 : count),
    close: () => undefined,
  });
  for (const count of [0, -1]) {
    const wire = new PeerWire({
      transport: invalidWrite(count),
      infoHash,
      peerId: "-PW0001-VALID0000000",
    });
    await assertRejects(() => wire.sendHandshake(), PeerWireError);
    await wire.close();
  }

  const invalidRead: PeerWireTransport = {
    read: (buffer) => Promise.resolve(buffer.length + 1),
    write: (buffer) => Promise.resolve(buffer.length),
    close: () => undefined,
  };
  const wire = new PeerWire({
    transport: invalidRead,
    infoHash,
    peerId: "-PW0001-VALID0000000",
  });
  await assertRejects(() => wire.receiveHandshake(), PeerWireError);
  await wire.close();
});
