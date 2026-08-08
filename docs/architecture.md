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

## Components

- `handshake.ts` owns the fixed 68-byte BEP 3 handshake and reserved-bit flags.
- `message.ts` owns the discriminated message union and frame codec.
- `bitfield.ts` adapts toolkit's MSB0 `BitArray` to piece availability and owns
  protocol-specific spare-bit validation.
- `peer_wire.ts` owns stream I/O, connection state, write serialization, and
  remote availability tracking. Exact reads and complete writes use toolkit's
  bounded `IoUtil` helpers.

The transport interface deliberately matches Deno's `Reader`/`Writer` shape.
Peer discovery and torrent policy remain outside this package.
