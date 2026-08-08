# Contributing

Keep protocol parsing strict for known message IDs and forward compatible for
unknown IDs. Any protocol change should include:

1. A codec round-trip test.
2. At least one malformed or boundary input test.
3. A connection-level test when the change affects stream state.
4. Updated public documentation for exported behavior.

Do not add torrent scheduling or storage policy to `PeerWire`; those concerns
belong to a higher-level client.
