# Contributing

Keep protocol parsing strict for known message IDs and forward compatible for
unknown IDs. Any protocol change should include:

1. A codec round-trip test.
2. At least one malformed or boundary input test.
3. A connection-level test when the change affects stream state.
4. Updated public documentation for exported behavior.

Do not add torrent scheduling or storage policy to `PeerWire`; those concerns
belong to a higher-level client.

## Releasing to JSR

1. Update the version in `deno.jsonc` and run the full local checks plus
   `deno task version` and `deno publish --dry-run`.
2. Commit the release and create a matching Git tag, for example `v0.1.1` for
   package version `0.1.1`.
3. Push the commit and tag, then create and publish the matching GitHub Release.
4. The `Publish to JSR` workflow starts only after the GitHub Release is
   published. It verifies the tag, dependency lock, tests, and package contents
   before publishing with GitHub Actions OIDC.

The JSR package settings must link `@deno-torrent/peerwire` to the
`deno-torrent/peerwire` GitHub repository. No long-lived JSR token is required.
