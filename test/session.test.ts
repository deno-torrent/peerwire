import { assertEquals, assertRejects } from "std/assert/mod.ts";
import { HandshakeExtension } from "@src/constants.ts";
import {
  PeerWireError,
  PeerWireProtocolError,
  PeerWireRequestRejectedError,
  PeerWireTimeoutError,
} from "@src/errors.ts";
import type { HashRequestFields } from "@src/message.ts";
import {
  PeerWire,
  PeerWireState,
  type PeerWireTransport,
} from "@src/peer_wire.ts";
import { memoryTransportPair } from "./_memory_transport.ts";

const infoHash = new Uint8Array(20).fill(8);

class GatedTransport implements PeerWireTransport {
  blocked = false;
  #inner: PeerWireTransport;
  #release?: () => void;

  constructor(inner: PeerWireTransport) {
    this.#inner = inner;
  }

  read(buffer: Uint8Array): Promise<number | null> {
    return this.#inner.read(buffer);
  }

  async write(buffer: Uint8Array): Promise<number> {
    if (this.blocked) {
      await new Promise<void>((resolve) => this.#release = resolve);
    }
    return await this.#inner.write(buffer);
  }

  release(): void {
    this.blocked = false;
    this.#release?.();
  }

  close(): void | Promise<void> {
    this.release();
    return this.#inner.close();
  }
}

async function wires(extensions: HandshakeExtension[] = []) {
  const [leftTransport, rightTransport] = memoryTransportPair(5);
  const left = new PeerWire({
    transport: leftTransport,
    infoHash,
    peerId: "-PW1000-LEFT00000000",
    pieceCount: 4,
    pieceLength: 32_768,
    totalLength: 4 * 32_768,
    extensions,
  });
  const right = new PeerWire({
    transport: rightTransport,
    infoHash,
    peerId: "-PW1000-RIGHT0000000",
    pieceCount: 4,
    pieceLength: 32_768,
    totalLength: 4 * 32_768,
    extensions,
  });
  await Promise.all([left.handshake(), right.handshake()]);
  return { left, right };
}

async function declareFast(left: PeerWire, right: PeerWire) {
  await Promise.all([left.haveNone(), right.haveAll()]);
  await Promise.all([left.readMessage(), right.readMessage()]);
}

Deno.test("requestBlock correlates piece and reject responses", async () => {
  const { left, right } = await wires([HandshakeExtension.Fast]);
  await declareFast(left, right);
  await right.unchoke();
  await left.readMessage();

  const block = new Uint8Array([1, 2, 3, 4]);
  const requested = left.requestBlock(1, 0, block.length);
  assertEquals((await right.readMessage())?.type, "request");
  assertEquals(right.peerRequests.length, 1);
  await right.piece(1, 0, block);
  await left.readMessage();
  assertEquals(await requested, block);
  assertEquals(left.pendingRequests.length, 0);

  const rejected = left.requestBlock(2, 0, 4);
  await right.readMessage();
  await right.reject(2, 0, 4);
  await left.readMessage();
  await assertRejects(() => rejected, PeerWireRequestRejectedError);
  await Promise.all([left.close(), right.close()]);
});

Deno.test("Fast choke rejects pending requests but preserves allowed-fast", async () => {
  const { left, right } = await wires([HandshakeExtension.Fast]);
  await declareFast(left, right);
  await right.unchoke();
  await left.readMessage();

  const rejected = left.requestBlock(0, 0, 4);
  await right.readMessage();
  await right.choke();
  assertEquals((await left.readMessage())?.type, "choke");
  assertEquals((await left.readMessage())?.type, "rejectRequest");
  await assertRejects(() => rejected, PeerWireRequestRejectedError);

  await right.allowedFast(1);
  await left.readMessage();
  const allowed = left.requestBlock(1, 0, 4);
  await right.readMessage();
  assertEquals(right.peerRequests.length, 1);
  const block = new Uint8Array([9, 8, 7, 6]);
  await right.piece(1, 0, block);
  await left.readMessage();
  assertEquals(await allowed, block);
  await Promise.all([left.close(), right.close()]);
});

Deno.test("strict ordering, block bounds, and request timeout are enforced", async () => {
  const fast = await wires([HandshakeExtension.Fast]);
  await assertRejects(() => fast.left.interested(), PeerWireProtocolError);
  await Promise.all([fast.left.close(), fast.right.close()]);

  const plain = await wires();
  await assertRejects(() => plain.left.request(0, 0, 16_385), RangeError);
  const timedOut = plain.left.requestBlock(0, 0, 4, { timeoutMs: 5 });
  await assertRejects(() => timedOut, PeerWireTimeoutError);
  assertEquals(plain.left.pendingRequests.length, 0);
  await Promise.all([plain.left.close(), plain.right.close()]);
});

Deno.test("BEP 52 hash requests correlate and hybrid hashes are accepted", async () => {
  const alternate = new Uint8Array(20).fill(9);
  const [leftTransport, rightTransport] = memoryTransportPair();
  const left = new PeerWire({
    transport: leftTransport,
    infoHash,
    acceptedInfoHashes: [alternate],
    peerId: "-PW1000-LEFT00000000",
    extensions: [HandshakeExtension.V2],
  });
  const right = new PeerWire({
    transport: rightTransport,
    infoHash: alternate,
    acceptedInfoHashes: [infoHash],
    peerId: "-PW1000-RIGHT0000000",
    extensions: [HandshakeExtension.V2],
  });
  await Promise.all([left.handshake(), right.handshake()]);
  const request: HashRequestFields = {
    piecesRoot: new Uint8Array(32).fill(3),
    baseLayer: 0,
    index: 0,
    length: 2,
    proofLayers: 1,
  };
  const response = left.requestHashes(request);
  assertEquals((await right.readMessage())?.type, "hashRequest");
  const hashes = new Uint8Array(64).fill(6);
  await right.hashes(request, hashes);
  await left.readMessage();
  assertEquals(await response, hashes);
  await Promise.all([left.close(), right.close()]);
});

Deno.test("BEP 52 piece lengths validate short pieces at every file boundary", async () => {
  const [leftTransport, rightTransport] = memoryTransportPair();
  const options = {
    infoHash,
    pieceCount: 3,
    pieceLength: 16 * 1024,
    pieceLengths: [16 * 1024, 37, 81],
    extensions: [HandshakeExtension.V2],
  };
  const left = new PeerWire({
    transport: leftTransport,
    peerId: "-PW1000-LEFT00000000",
    ...options,
  });
  const right = new PeerWire({
    transport: rightTransport,
    peerId: "-PW1000-RIGHT0000000",
    ...options,
  });
  await Promise.all([left.handshake(), right.handshake()]);
  await right.unchoke();
  await left.readMessage();
  await left.request(1, 0, 37);
  assertEquals((await right.readMessage())?.type, "request");
  await assertRejects(
    () => left.request(1, 1, 37),
    RangeError,
    "block exceeds piece boundary",
  );
  await assertRejects(
    () => left.request(2, 80, 2),
    RangeError,
    "block exceeds piece boundary",
  );
  await Promise.all([left.close(), right.close()]);
});

Deno.test("keepalive and read timeout manage connection lifetime", async () => {
  const keepAlive = await wires();
  keepAlive.left.setKeepAlive(5);
  assertEquals(await keepAlive.right.readMessage({ timeoutMs: 100 }), {
    type: "keepAlive",
  });
  await Promise.all([keepAlive.left.close(), keepAlive.right.close()]);

  const timeout = await wires();
  await assertRejects(
    () => timeout.left.readMessage({ timeoutMs: 5 }),
    PeerWireTimeoutError,
  );
  assertEquals(timeout.left.state, PeerWireState.Closed);
  assertEquals(timeout.left.terminalError instanceof PeerWireError, true);
  await timeout.right.close();
});

Deno.test("bounded write queue applies backpressure", async () => {
  const [rawLeft, rightTransport] = memoryTransportPair();
  const leftTransport = new GatedTransport(rawLeft);
  const left = new PeerWire({
    transport: leftTransport,
    infoHash,
    peerId: "-PW1000-LEFT00000000",
    maxQueuedWriteBytes: 68,
  });
  const right = new PeerWire({
    transport: rightTransport,
    infoHash,
    peerId: "-PW1000-RIGHT0000000",
  });
  await Promise.all([left.handshake(), right.handshake()]);
  leftTransport.blocked = true;
  const block = new Uint8Array(55).fill(1);
  const first = left.piece(0, 0, block);
  await Promise.resolve();
  assertEquals(left.queuedWriteBytes, 68);
  await assertRejects(() => left.have(1), PeerWireError);
  leftTransport.release();
  await first;
  assertEquals(await right.readMessage(), {
    type: "piece",
    pieceIndex: 0,
    begin: 0,
    block,
  });
  await Promise.all([left.close(), right.close()]);
});
