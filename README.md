# Peer Wire for Deno

[![JSR](https://jsr.io/badges/@deno-torrent/peerwire)](https://jsr.io/@deno-torrent/peerwire)

[中文文档](./README.zh-CN.md)

A transport-independent TypeScript implementation of the BitTorrent peer wire
protocol for Deno. It implements the BEP 3 handshake and message stream, with
the messages introduced by BEP 5, BEP 6, and BEP 10.

## Status

The library provides the protocol layer that sits on top of TCP or μTP. It does
not perform peer discovery, piece scheduling, hashing, or storage.

- Runtime verified with Deno 2.9.5; CI tracks the current Deno 2.x release.
- Works with `Deno.TcpConn`, `@deno-torrent/utp` connections, and compatible
  custom transports.
- Public API: `PeerWire`, handshake/message codecs, and `Bitfield`.
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
tracking of the remote peer's bitfield. `maxMessageLength` defaults to 2 MiB.
When a tracker supplies the remote peer ID, pass it as `expectedPeerId` to
reject a handshake from a different peer.

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
Convenience methods cover `choke`, `unchoke`, `interested`, `have`, `bitfield`,
`request`, `piece`, `cancel`, `port`, and `extended`.

The message union covers:

- BEP 3: keep-alive, choke state, interest state, have, bitfield, request,
  piece, and cancel.
- BEP 5: DHT port.
- BEP 6: suggest piece, have all/none, reject request, and allowed fast.
- BEP 10: raw extended messages. Extension ID `0` is the extended handshake;
  bencoded extension payloads remain application-controlled.

Fast, DHT port, and extended messages are accepted by `PeerWire` only when both
handshakes advertise the corresponding capability. The DHT implementation itself
belongs in
[`deno-torrent/torrent-dht`](https://github.com/deno-torrent/torrent-dht); this
package only transports the BEP 5 `PORT` message.

`encodeHandshake`, `decodeHandshake`, `encodeMessage`, and `decodeMessage` can
be used independently of a connection.

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
