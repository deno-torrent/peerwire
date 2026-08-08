# Peer Wire for Deno

[![JSR](https://jsr.io/badges/@deno-torrent/peerwire)](https://jsr.io/@deno-torrent/peerwire)

[中文文档](./README.zh-CN.md)

A transport-independent TypeScript implementation of the BitTorrent peer wire
protocol for Deno. It provides a bounded peer session, a BEP 10 extension host,
metadata and peer exchange, Fast Extension semantics, and BitTorrent v2 hash
messages.

## Status

The library provides the protocol layer that sits on top of TCP or μTP. It does
not perform peer discovery, piece scheduling, hashing, or storage.

- Runtime verified with Deno 2.9.5; CI tracks the current Deno 2.x release.
- Works with `Deno.TcpConn`, `@deno-torrent/utp` connections, and compatible
  custom transports.
- BEP 3/5/6/9/10/11/52 support, including built-in `ut_metadata` and `ut_pex`.
- Request correlation, timeouts, keepalive, idle deadlines, and bounded writes.
- Public API: `PeerWire`, `ExtensionHost`, built-in extensions, codecs, and
  `Bitfield`.
- Unknown message IDs are retained as raw messages for forward compatibility.
- Incoming frame size is bounded before allocation.

## Installation

```ts
import { PeerWire } from "jsr:@deno-torrent/peerwire";
```

For repository development:

```ts
import { PeerWire } from "./mod.ts";
```

## Quick start

```ts
import { HandshakeExtension, PeerWire } from "jsr:@deno-torrent/peerwire";

const connection = await Deno.connect({
  hostname: "127.0.0.1",
  port: 6881,
});

const wire = new PeerWire({
  transport: connection,
  infoHash, // exactly 20 bytes
  peerId: "-PW0001-123456789012", // exactly 20 UTF-8 bytes
  pieceCount: torrent.pieces.length,
  extensions: [
    HandshakeExtension.ExtensionProtocol,
    HandshakeExtension.Dht,
  ],
});

try {
  const remote = await wire.handshake();
  console.log("connected to", new TextDecoder().decode(remote.peerId));

  await wire.interested();

  for await (const message of wire) {
    if (message.type === "unchoke") {
      await wire.request(0, 0, 16 * 1024);
    } else if (message.type === "piece") {
      console.log("received", message.block.length, "bytes");
      break;
    }
  }
} finally {
  await wire.close();
}
```

The same API can run over μTP:

```ts
import { Utp } from "jsr:@deno-torrent/utp";

const endpoint = new Utp("peer-wire");
const connection = await endpoint.connect({
  hostname: "127.0.0.1",
  port: 6881,
});
const wire = new PeerWire({ transport: connection, infoHash, peerId });
await wire.handshake();
```

Close both `wire` and the owning `Utp` endpoint when finished.

## API

### `new PeerWire(options)`

`transport` must provide `read()`, `write()`, and `close()`. `infoHash` and
`peerId` must each contain exactly 20 bytes. `pieceCount` enables validation and
tracking of the remote peer's bitfield. `pieceLength` and `totalLength` enable
block boundary checks. `maxMessageLength` defaults to 2 MiB and `maxBlockLength`
to 16 KiB. When a tracker supplies the remote peer ID, pass it as
`expectedPeerId` to reject a handshake from a different peer.

### Handshake

- `handshake()` concurrently sends and receives the standard 68-byte handshake.
- `sendHandshake()` and `receiveHandshake()` are available when a caller needs
  to control ordering.
- A different info hash, invalid protocol identifier, or truncated transport is
  rejected.
- When configured, `expectedPeerId` is checked against the remote handshake.

### Messages

`send(message)` writes any `PeerMessage`; `readMessage()` returns the next
message or `null` at clean EOF. `PeerWire` is also an async iterable.
Convenience methods cover base, Fast, extended, and v2 hash messages.
`requestBlock()` and `requestHashes()` correlate responses and support timeout
and `AbortSignal` options. Keep a read loop active while awaiting them so
incoming responses can be dispatched.

The message union covers:

- BEP 3: keep-alive, choke state, interest state, have, bitfield, request,
  piece, and cancel.
- BEP 5: DHT port.
- BEP 6: Fast messages plus request/reject/choke/allowed-fast semantics.
- BEP 10: extended handshakes, per-peer ID maps, registration, updates, and
  dispatch.
- BEP 52: v2/hybrid flag and hash request/hashes/hash reject messages.

Fast, DHT port, and extended messages are accepted by `PeerWire` only when both
handshakes advertise the corresponding capability. The DHT implementation itself
belongs in
[`deno-torrent/torrent-dht`](https://github.com/deno-torrent/torrent-dht); this
package only transports the BEP 5 `PORT` message.

`encodeHandshake`, `decodeHandshake`, `encodeMessage`, and `decodeMessage` can
be used independently of a connection.

### Built-in extensions

Register extensions before `handshake()`:

```ts
import {
  HandshakeExtension,
  PeerWire,
  UtMetadataExtension,
  UtPexExtension,
} from "jsr:@deno-torrent/peerwire";

const wire = new PeerWire({
  transport,
  infoHash,
  peerId,
  extensions: [HandshakeExtension.ExtensionProtocol],
});
const metadata = wire.use(new UtMetadataExtension({ infoHash }));
wire.use(
  new UtPexExtension({
    onUpdate: (update) => peerManager.addCandidates(update.added),
  }),
);
await wire.handshake();
```

`metadata.fetch()` downloads and SHA-1 verifies the raw bencoded `info`
dictionary. Parsing it into a metainfo model remains an application concern.
`UtPexExtension` validates and reports updates; it never opens connections or
manages a swarm.

### Connection policy

`setKeepAlive()` enables inactivity-based keepalives. Constructor options cover
handshake/read/write/idle/request deadlines, pending requests, queued write
bytes, and extension payload limits. Protocol or I/O failures close the owned
transport and are retained in `terminalError`.

### State

After each sent or received message, `localChoking`, `localInterested`,
`remoteChoking`, and `remoteInterested` reflect the current protocol state. If
`pieceCount` is configured, `remoteBitfield` tracks bitfield and have messages.
`uploadedBytes` and `downloadedBytes` count complete wire frames after the
handshake.

## Development

```sh
deno task fmt
deno task check
deno task lint
deno task test
deno task test:live # opt-in public-network handshake
deno task test:coverage
deno task coverage
```

See [Architecture](./docs/architecture.md), [Testing](./docs/testing.md), and
[Contributing](./docs/contributing.md).

## License

[MIT](./LICENSE)
