# Architecture

The package mirrors the component-oriented layout used by `deno-torrent/utp`:
the root module only defines the public surface, protocol components live in
`src`, and matching tests live in `test`.

## Data flow

```text
application PeerMessage
        │
        ▼
 encodeMessage ── length prefix + ID + body
        │
        ▼
 PeerWire serialized writer
        │
        ▼
 Deno.TcpConn / UtpConn / custom transport
```

Incoming frames take the reverse path. `PeerWire` first reads the four-byte
length prefix and enforces `maxMessageLength`, then allocates and decodes the
body. This order prevents a peer-controlled length from causing an unbounded
allocation.

Named extensions pass through a second bounded layer:

```text
extended frame -> ExtensionHost -> ut_metadata / ut_pex / custom extension
```

## Components

- `handshake.ts` owns the fixed 68-byte BEP 3 handshake and reserved-bit flags.
- `message.ts` owns the discriminated message union and frame codec.
- `extension.ts` owns BEP 10 handshakes, directional peer ID maps, and dispatch.
- `ut_metadata.ts` owns BEP 9 transfer, assembly, limits, and info-hash
  verification; it returns raw metadata bytes.
- `ut_pex.ts` owns BEP 11 compact endpoint and flag messages without managing
  peer connections.
- `bitfield.ts` adapts toolkit's MSB0 `BitArray` to piece availability and owns
  protocol-specific spare-bit validation.
- `peer_wire.ts` owns stream I/O, connection state, request correlation, Fast
  semantics, deadlines, bounded write serialization, and availability tracking.
  Exact reads and complete writes use toolkit's bounded `IoUtil` helpers.

The transport interface deliberately matches Deno's `Reader`/`Writer` shape.
Tracker/DHT discovery, swarm connection policy, piece scheduling, downloaded
piece verification, and storage remain outside this package.
