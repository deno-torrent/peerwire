# Testing

Run the deterministic suite with:

```sh
deno task test
```

The suite only opens local loopback sockets. It covers exact BEP wire layouts,
codec round trips, 500 deterministic randomized messages, malformed inputs,
bitfield boundaries, partial stream reads/writes, handshake validation,
BEP 10 extension negotiation, multi-block `ut_metadata`, IPv4/IPv6 `ut_pex`,
request correlation and rejection, Fast Extension state, BEP 52 hash messages,
hybrid info-hash acceptance, deadlines, keep-alives, bounded write queues,
allocation limits, and real TCP and `deno-torrent/utp` transports. The in-memory
transport intentionally fragments I/O down to one byte to exercise behavior
that a loopback test can otherwise hide.

The opt-in live suite is kept in `live_test/`, outside the deterministic test
directory. It downloads an official Ubuntu torrent, announces to its tracker,
negotiates BEP 10 with returned public peers, and uses `ut_metadata` to download
and verify the raw info dictionary. It does not request or download any payload
pieces:

```sh
deno task test:live
```

Because this test depends on the public internet, tracker availability, and
reachable peers, it is not included in `deno task test` or CI. To exercise a
different Ubuntu release (or another public v1 single-file torrent), set
`UBUNTU_TORRENT_URL`:

```sh
UBUNTU_TORRENT_URL=https://example.test/image.iso.torrent deno task test:live
```

Generate the source coverage report with:

```sh
deno task test:coverage
deno task coverage
```

The current deterministic suite covers 84.2% of source lines, 83.3% of branches,
and 91.8% of functions. These figures include the defensive timeout, rejection,
and transport-failure paths added for version 1.0.0. CI tracks the current Deno
2.x release on Ubuntu.

Before publishing, run all checks:

```sh
deno task fmt
deno task check
deno task lint
deno task test
deno task version
deno publish --dry-run
```
