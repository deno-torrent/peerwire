import { assertEquals, assertRejects } from "std/assert/mod.ts";
import { HashUtil } from "@deno-torrent/toolkit";
import { HandshakeExtension } from "@src/constants.ts";
import { PeerWire, type PeerWireOptions } from "@src/peer_wire.ts";
import { PexPeerFlag, UtPexExtension } from "@src/ut_pex.ts";
import { UtMetadataExtension } from "@src/ut_metadata.ts";
import { memoryTransportPair } from "./_memory_transport.ts";

async function extensionWires(
  infoHash: Uint8Array,
  configure: (left: PeerWire, right: PeerWire) => void,
) {
  const [leftTransport, rightTransport] = memoryTransportPair(7);
  const common: Omit<PeerWireOptions, "transport" | "peerId"> = {
    infoHash,
    extensions: [HandshakeExtension.ExtensionProtocol],
  };
  const left = new PeerWire({
    ...common,
    transport: leftTransport,
    peerId: "-PW1000-LEFT00000000",
  });
  const right = new PeerWire({
    ...common,
    transport: rightTransport,
    peerId: "-PW1000-RIGHT0000000",
  });
  configure(left, right);
  await Promise.all([left.handshake(), right.handshake()]);
  // Dispatch the automatic extended handshakes before using named extensions.
  assertEquals((await left.readMessage())?.type, "extended");
  assertEquals((await right.readMessage())?.type, "extended");
  return { left, right };
}

Deno.test("ut_metadata downloads, assembles, and verifies metadata", async () => {
  const metadata = Uint8Array.from(
    { length: 2 * 16_384 + 37 },
    (_, index) => (index * 17) & 0xff,
  );
  const infoHash = await HashUtil.sha1(metadata);
  let downloader!: UtMetadataExtension;
  let seeder!: UtMetadataExtension;
  const { left, right } = await extensionWires(infoHash, (left, right) => {
    downloader = left.use(new UtMetadataExtension({ infoHash }));
    seeder = right.use(new UtMetadataExtension({ infoHash, metadata }));
  });

  const fetched = downloader.fetch({ timeoutMs: 1_000 });
  const blocks = Math.ceil(metadata.length / 16_384);
  for (let index = 0; index < blocks; index++) await right.readMessage();
  for (let index = 0; index < blocks; index++) await left.readMessage();
  assertEquals(await fetched, metadata);
  assertEquals(seeder.metadata, metadata);
  await Promise.all([left.close(), right.close()]);
});

Deno.test("ut_metadata verifies BEP-52 metadata with the full SHA-256 hash", async () => {
  const metadata = Uint8Array.from(
    { length: 16_384 + 19 },
    (_, index) => (index * 29) & 0xff,
  );
  const infoHashV2 = await HashUtil.sha256(metadata);
  const handshakeHash = infoHashV2.subarray(0, 20);
  let downloader!: UtMetadataExtension;
  const { left, right } = await extensionWires(
    handshakeHash,
    (left, right) => {
      downloader = left.use(
        new UtMetadataExtension({ infoHash: infoHashV2 }),
      );
      right.use(
        new UtMetadataExtension({ infoHash: infoHashV2, metadata }),
      );
    },
  );

  const fetched = downloader.fetch({ timeoutMs: 1_000 });
  const blocks = Math.ceil(metadata.length / 16_384);
  for (let index = 0; index < blocks; index++) await right.readMessage();
  for (let index = 0; index < blocks; index++) await left.readMessage();
  assertEquals(await fetched, metadata);
  await Promise.all([left.close(), right.close()]);
});

Deno.test("ut_pex exchanges bounded IPv4 and IPv6 updates", async () => {
  const infoHash = new Uint8Array(20).fill(7);
  let sender!: UtPexExtension;
  let received: unknown;
  const { left, right } = await extensionWires(infoHash, (left, right) => {
    sender = left.use(new UtPexExtension({ minSendIntervalMs: 0 }));
    right.use(
      new UtPexExtension({
        minSendIntervalMs: 0,
        onUpdate: (update) => received = update,
      }),
    );
  });
  const update = {
    added: [{
      address: new Uint8Array([127, 0, 0, 1]),
      port: 6881,
      flags: PexPeerFlag.Utp | PexPeerFlag.Outgoing,
    }, {
      address: new Uint8Array(16).fill(1),
      port: 6882,
      flags: PexPeerFlag.Seed,
    }],
    dropped: [{
      address: new Uint8Array([10, 0, 0, 1]),
      port: 6883,
    }],
  };
  await sender.send(update);
  await right.readMessage();
  assertEquals(received, {
    added: update.added,
    dropped: [{ ...update.dropped[0], flags: 0 }],
  });
  await Promise.all([left.close(), right.close()]);
});

Deno.test("ut_metadata rejects content with the wrong info hash", async () => {
  const advertisedHash = new Uint8Array(20).fill(4);
  const metadata = new Uint8Array([1, 2, 3]);
  let downloader!: UtMetadataExtension;
  const { left, right } = await extensionWires(
    advertisedHash,
    (left, right) => {
      downloader = left.use(
        new UtMetadataExtension({ infoHash: advertisedHash }),
      );
      right.use(
        new UtMetadataExtension({ infoHash: advertisedHash, metadata }),
      );
    },
  );
  const fetched = downloader.fetch({ timeoutMs: 1_000 });
  await right.readMessage();
  await left.readMessage();
  await assertRejects(() => fetched);
  await Promise.all([left.close(), right.close()]);
});
