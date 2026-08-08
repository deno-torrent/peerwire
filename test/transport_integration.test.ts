import { assertEquals } from "std/assert/mod.ts";
import { Utp } from "@deno-torrent/utp";
import { PeerWire } from "@src/peer_wire.ts";

const infoHash = Uint8Array.from({ length: 20 }, (_, index) => 255 - index);
const clientPeerId = "-PW0001-TCPCLIENT000";
const serverPeerId = "-PW0001-TCPSERVER000";

Deno.test("PeerWire exchanges messages over real TCP loopback", async () => {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const address = listener.addr as Deno.NetAddr;
  let clientWire: PeerWire | undefined;
  let serverWire: PeerWire | undefined;

  try {
    const serverTask = (async () => {
      const connection = await listener.accept();
      listener.close();
      const wire = new PeerWire({
        transport: connection,
        infoHash,
        peerId: serverPeerId,
        expectedPeerId: clientPeerId,
      });
      await wire.handshake();
      return wire;
    })();

    const connection = await Deno.connect({
      hostname: address.hostname,
      port: address.port,
    });
    clientWire = new PeerWire({
      transport: connection,
      infoHash,
      peerId: clientPeerId,
      expectedPeerId: serverPeerId,
    });
    await clientWire.handshake();
    serverWire = await serverTask;

    await clientWire.request(3, 16_384, 16_384);
    assertEquals(await serverWire.readMessage(), {
      type: "request",
      pieceIndex: 3,
      begin: 16_384,
      length: 16_384,
    });

    const block = Uint8Array.from(
      { length: 16_384 },
      (_, index) => (index * 31) & 0xff,
    );
    await serverWire.piece(3, 16_384, block);
    assertEquals(await clientWire.readMessage(), {
      type: "piece",
      pieceIndex: 3,
      begin: 16_384,
      block,
    });
  } finally {
    await Promise.allSettled([
      clientWire?.close(),
      serverWire?.close(),
    ].filter((promise): promise is Promise<void> => promise !== undefined));
    try {
      listener.close();
    } catch {
      // The listener is normally closed immediately after accept.
    }
  }
});

Deno.test("PeerWire exchanges messages over deno-torrent uTP loopback", async () => {
  const serverEndpoint = new Utp("peerwire-test-server");
  const clientEndpoint = new Utp("peerwire-test-client");
  const listener = serverEndpoint.listen({ hostname: "127.0.0.1", port: 0 });
  const address = serverEndpoint.localAddr!;
  let clientWire: PeerWire | undefined;
  let serverWire: PeerWire | undefined;
  let serverTask: Promise<PeerWire> | undefined;

  try {
    serverTask = (async () => {
      const connection = await listener.accept();
      const wire = new PeerWire({
        transport: connection,
        infoHash,
        peerId: serverPeerId,
        expectedPeerId: clientPeerId,
      });
      await wire.handshake();
      return wire;
    })();

    const connection = await clientEndpoint.connect({
      hostname: address.hostname,
      port: address.port,
    });
    clientWire = new PeerWire({
      transport: connection,
      infoHash,
      peerId: clientPeerId,
      expectedPeerId: serverPeerId,
    });
    await clientWire.handshake();
    serverWire = await serverTask;

    await clientWire.interested();
    assertEquals(await serverWire.readMessage(), { type: "interested" });
    await serverWire.unchoke();
    assertEquals(await clientWire.readMessage(), { type: "unchoke" });
  } finally {
    await Promise.allSettled([
      clientWire?.close(),
      serverWire?.close(),
    ].filter((promise): promise is Promise<void> => promise !== undefined));
    listener.close();
    await serverTask?.catch(() => undefined);
    await Promise.allSettled([
      clientEndpoint.close(),
      serverEndpoint.close(),
    ]);
  }
});
