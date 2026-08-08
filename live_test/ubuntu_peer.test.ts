import { HashUtil, NetUtil } from "@deno-torrent/toolkit";
import { assert, assertEquals } from "std/assert/mod.ts";
import { HandshakeExtension } from "@src/constants.ts";
import { PeerWire } from "@src/peer_wire.ts";
import { UtMetadataExtension } from "@src/ut_metadata.ts";

const DEFAULT_TORRENT_URL =
  "https://releases.ubuntu.com/26.04/ubuntu-26.04-desktop-amd64.iso.torrent";
const decoder = new TextDecoder();

Deno.test({
  name: "PeerWire downloads metadata from a live Ubuntu torrent peer",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const torrentUrl = Deno.env.get("UBUNTU_TORRENT_URL") ??
      DEFAULT_TORRENT_URL;
    const torrentResponse = await fetch(torrentUrl, {
      signal: AbortSignal.timeout(15_000),
    });
    assert(
      torrentResponse.ok,
      `failed to fetch ${torrentUrl}: ${torrentResponse.status}`,
    );

    const torrentBytes = new Uint8Array(await torrentResponse.arrayBuffer());
    const torrent = await parseTorrent(torrentBytes);
    const peerId = new TextEncoder().encode(
      `-PW0001-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
    );
    const peers = await announce(torrent, peerId);
    assert(peers.length > 0, "Ubuntu trackers returned no peers");

    const controllers = peers.slice(0, 12).map(() => new AbortController());
    const attempts = peers.slice(0, controllers.length).map((peer, index) =>
      fetchMetadataFromPeer(
        peer,
        torrent.infoHash,
        torrent.pieceCount,
        peerId,
        controllers[index].signal,
      )
    );
    let result: LivePeerResult;
    try {
      result = await Promise.any(attempts);
    } catch (error) {
      if (error instanceof AggregateError) {
        const reasons = error.errors.map((reason) =>
          reason instanceof Error ? reason.message : String(reason)
        );
        throw new Error(
          `could not fetch metadata from ${attempts.length} Ubuntu peers: ${
            reasons.join("; ")
          }`,
        );
      }
      throw error;
    } finally {
      // Promise.any leaves unsuccessful attempts running. Abort them after the
      // first interoperable peer succeeds so the live test stays courteous.
      for (const controller of controllers) controller.abort();
      await Promise.allSettled(attempts);
      await stopAnnounce(torrent, peerId).catch(() => undefined);
    }

    assertEquals(result.peerId.length, 20);
    assertEquals(result.metadata, torrent.infoBytes);
  },
});

interface TorrentMetadata {
  announceUrls: string[];
  infoHash: Uint8Array;
  infoBytes: Uint8Array;
  length: number;
  pieceCount: number;
}

interface PeerAddress {
  hostname: string;
  port: number;
}

async function announce(
  torrent: TorrentMetadata,
  peerId: Uint8Array,
): Promise<PeerAddress[]> {
  const results = await Promise.allSettled(
    torrent.announceUrls.map((url) => announceTracker(url, torrent, peerId)),
  );
  const peers = results.flatMap((result) =>
    result.status === "fulfilled" ? result.value : []
  );
  if (peers.length === 0) {
    const reasons = results.flatMap((result) =>
      result.status === "rejected" ? [String(result.reason)] : []
    );
    throw new Error(`Ubuntu trackers returned no peers: ${reasons.join("; ")}`);
  }
  // The same endpoint may be returned by more than one announce URL.
  return [...new Map(peers.map((peer) => [
    `${peer.hostname}:${peer.port}`,
    peer,
  ])).values()];
}

async function announceTracker(
  trackerUrl: string,
  torrent: TorrentMetadata,
  peerId: Uint8Array,
): Promise<PeerAddress[]> {
  const url = announceUrl(trackerUrl, torrent, peerId, "started", 50);
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  assert(response.ok, `tracker announce failed: ${response.status}`);

  const value = new BencodeDecoder(
    new Uint8Array(await response.arrayBuffer()),
  ).decode();
  const dictionary = expectDictionary(value, "tracker response");
  const failure = dictionary.get("failure reason");
  if (failure) throw new Error(decoder.decode(expectBytes(failure)));

  const addresses: PeerAddress[] = [];
  const peers4Value = dictionary.get("peers");
  if (peers4Value !== undefined) {
    if (peers4Value.type === "bytes") {
      const peers4 = peers4Value.value;
      assertEquals(peers4.length % 6, 0, "invalid compact IPv4 peer list");
      for (let offset = 0; offset < peers4.length; offset += 6) {
        const endpoint = NetUtil.compactIPv4ToEndpoint(
          peers4.subarray(offset, offset + 6),
        );
        addresses.push({ hostname: endpoint.host, port: endpoint.port });
      }
    } else {
      addresses.push(...decodeTrackerPeerList(peers4Value));
    }
  }
  const peers6Value = dictionary.get("peers6");
  if (peers6Value !== undefined) {
    const peers6 = expectBytes(peers6Value, "tracker IPv6 peers");
    assertEquals(peers6.length % 18, 0, "invalid compact IPv6 peer list");
    for (let offset = 0; offset < peers6.length; offset += 18) {
      addresses.push(compactIPv6Peer(peers6.subarray(offset, offset + 18)));
    }
  }
  return addresses;
}

function decodeTrackerPeerList(value: BencodeValue): PeerAddress[] {
  assert(value.type === "list", "tracker peers must be compact or a list");
  return value.value.map((entry) => {
    const peer = expectDictionary(entry, "tracker peer");
    const hostname = decoder.decode(expectBytes(peer.get("ip"), "peer IP"));
    const port = expectInteger(peer.get("port"), "peer port");
    assert(port >= 1 && port <= 65_535, "peer port is out of range");
    return { hostname, port };
  });
}

async function stopAnnounce(
  torrent: TorrentMetadata,
  peerId: Uint8Array,
): Promise<void> {
  await Promise.allSettled(torrent.announceUrls.map(async (trackerUrl) => {
    const response = await fetch(
      announceUrl(trackerUrl, torrent, peerId, "stopped", 0),
      { signal: AbortSignal.timeout(5_000) },
    );
    await response.body?.cancel();
  }));
}

function announceUrl(
  trackerUrl: string,
  torrent: TorrentMetadata,
  peerId: Uint8Array,
  event: "started" | "stopped",
  numwant: number,
): string {
  const separator = trackerUrl.includes("?") ? "&" : "?";
  return trackerUrl + separator + [
    `info_hash=${percentEncode(torrent.infoHash)}`,
    `peer_id=${percentEncode(peerId)}`,
    "port=6881",
    "uploaded=0",
    "downloaded=0",
    `left=${torrent.length}`,
    "compact=1",
    `numwant=${numwant}`,
    `event=${event}`,
  ].join("&");
}

function compactIPv6Peer(bytes: Uint8Array): PeerAddress {
  assertEquals(bytes.length, 18, "compact IPv6 peer must contain 18 bytes");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const groups = Array.from(
    { length: 8 },
    (_, index) => view.getUint16(index * 2).toString(16),
  );
  return { hostname: groups.join(":"), port: view.getUint16(16) };
}

interface LivePeerResult {
  peerId: Uint8Array;
  metadata: Uint8Array;
}

async function fetchMetadataFromPeer(
  peer: PeerAddress,
  infoHash: Uint8Array,
  pieceCount: number,
  peerId: Uint8Array,
  signal: AbortSignal,
): Promise<LivePeerResult> {
  let connection: Deno.TcpConn | undefined;
  let wire: PeerWire | undefined;
  let readLoop: Promise<never> | undefined;
  try {
    if (signal.aborted) throw abortReason(signal);
    connection = await withTimeout(
      Deno.connect({ hostname: peer.hostname, port: peer.port }),
      5_000,
      `connect to ${peer.hostname}:${peer.port}`,
      undefined,
      (lateConnection) => lateConnection.close(),
    );
    if (signal.aborted) throw abortReason(signal);
    wire = new PeerWire({
      transport: connection,
      infoHash,
      peerId,
      pieceCount,
      extensions: [HandshakeExtension.ExtensionProtocol],
      clientName: "deno-torrent/peerwire live test",
    });
    const metadataExtension = wire.use(
      new UtMetadataExtension({ infoHash, requestTimeoutMs: 30_000 }),
    );
    const handshake = await withTimeout(
      wire.handshake({ signal }),
      5_000,
      `handshake with ${peer.hostname}:${peer.port}`,
      () => wire?.close(),
    );
    // Correlated extension operations depend on a single active frame reader.
    // Treat EOF as a failed attempt when it arrives before verified metadata.
    readLoop = readUntilClosed(wire, signal, peer);
    const metadata = await withTimeout(
      Promise.race([
        metadataExtension.fetch({ signal, timeoutMs: 30_000 }),
        readLoop,
      ]),
      45_000,
      `ut_metadata from ${peer.hostname}:${peer.port}`,
      () => wire?.close(),
    );
    return { peerId: handshake.peerId, metadata };
  } finally {
    if (wire) {
      await wire.close();
    } else {
      connection?.close();
    }
    await readLoop?.catch(() => undefined);
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

async function readUntilClosed(
  wire: PeerWire,
  signal: AbortSignal,
  peer: PeerAddress,
): Promise<never> {
  for (;;) {
    const message = await wire.readMessage({ signal });
    if (message === null) {
      throw new Error(
        `${peer.hostname}:${peer.port} closed before sending metadata`,
      );
    }
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  operation: string,
  onTimeout?: () => void | Promise<void>,
  onLateResult?: (result: T) => void | Promise<void>,
): Promise<T> {
  let settled = false;
  const observed = promise.then(async (result) => {
    if (settled) {
      await onLateResult?.(result);
      throw new Error(`${operation} completed after timeout`);
    }
    return result;
  });
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      settled = true;
      Promise.resolve(onTimeout?.()).finally(() => {
        reject(new Error(`${operation} timed out after ${milliseconds}ms`));
      });
    }, milliseconds);
    observed.then(resolve, reject).finally(() => {
      settled = true;
      clearTimeout(timer);
    });
  });
}

async function parseTorrent(bytes: Uint8Array): Promise<TorrentMetadata> {
  const root = expectDictionary(new BencodeDecoder(bytes).decode(), "torrent");
  const primaryAnnounceUrl = decoder.decode(
    expectBytes(root.get("announce"), "torrent announce URL"),
  );
  const announceUrls = [
    primaryAnnounceUrl,
    ...decodeAnnounceList(root.get("announce-list")),
  ].filter((url, index, urls) => urls.indexOf(url) === index);
  const info = root.get("info");
  const infoDictionary = expectDictionary(info, "torrent info");
  const length = expectInteger(infoDictionary.get("length"), "torrent length");
  const pieces = expectBytes(infoDictionary.get("pieces"), "torrent pieces");
  assertEquals(pieces.length % 20, 0, "invalid torrent pieces field");
  const infoBytes = bytes.subarray(info!.start, info!.end);

  return {
    announceUrls,
    infoHash: await HashUtil.sha1(infoBytes),
    infoBytes: new Uint8Array(infoBytes),
    length,
    pieceCount: pieces.length / 20,
  };
}

function decodeAnnounceList(value: BencodeValue | undefined): string[] {
  if (value === undefined) return [];
  assert(value.type === "list", "torrent announce-list must be a list");
  const urls: string[] = [];
  for (const tier of value.value) {
    assert(tier.type === "list", "torrent announce tier must be a list");
    for (const url of tier.value) urls.push(decoder.decode(expectBytes(url)));
  }
  return urls;
}

function percentEncode(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => `%${byte.toString(16).padStart(2, "0")}`)
    .join("");
}

type BencodeValue =
  | { type: "bytes"; value: Uint8Array; start: number; end: number }
  | { type: "integer"; value: number; start: number; end: number }
  | { type: "list"; value: BencodeValue[]; start: number; end: number }
  | {
    type: "dictionary";
    value: Map<string, BencodeValue>;
    start: number;
    end: number;
  };

class BencodeDecoder {
  #offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  decode(): BencodeValue {
    const value = this.#decodeValue();
    assertEquals(this.#offset, this.bytes.length, "trailing bencode data");
    return value;
  }

  #decodeValue(): BencodeValue {
    const start = this.#offset;
    const marker = this.bytes[this.#offset];
    if (marker === 0x69) return this.#decodeInteger(start);
    if (marker === 0x6c) return this.#decodeList(start);
    if (marker === 0x64) return this.#decodeDictionary(start);
    if (marker >= 0x30 && marker <= 0x39) return this.#decodeBytes(start);
    throw new Error(`invalid bencode marker at byte ${this.#offset}`);
  }

  #decodeInteger(start: number): BencodeValue {
    this.#offset++;
    const end = this.#find(0x65);
    const text = decoder.decode(this.bytes.subarray(this.#offset, end));
    assert(/^-?(0|[1-9]\d*)$/.test(text), `invalid bencode integer: ${text}`);
    this.#offset = end + 1;
    const value = Number(text);
    assert(Number.isSafeInteger(value), "bencode integer exceeds safe range");
    return { type: "integer", value, start, end: this.#offset };
  }

  #decodeBytes(start: number): BencodeValue {
    const colon = this.#find(0x3a);
    const text = decoder.decode(this.bytes.subarray(this.#offset, colon));
    assert(/^(0|[1-9]\d*)$/.test(text), `invalid byte string length: ${text}`);
    const length = Number(text);
    this.#offset = colon + 1;
    const end = this.#offset + length;
    assert(end <= this.bytes.length, "truncated bencode byte string");
    const value = this.bytes.subarray(this.#offset, end);
    this.#offset = end;
    return { type: "bytes", value, start, end };
  }

  #decodeList(start: number): BencodeValue {
    this.#offset++;
    const value: BencodeValue[] = [];
    while (this.bytes[this.#offset] !== 0x65) value.push(this.#decodeValue());
    this.#offset++;
    return { type: "list", value, start, end: this.#offset };
  }

  #decodeDictionary(start: number): BencodeValue {
    this.#offset++;
    const value = new Map<string, BencodeValue>();
    while (this.bytes[this.#offset] !== 0x65) {
      const key = this.#decodeBytes(this.#offset);
      value.set(decoder.decode(expectBytes(key)), this.#decodeValue());
    }
    this.#offset++;
    return { type: "dictionary", value, start, end: this.#offset };
  }

  #find(byte: number): number {
    const index = this.bytes.indexOf(byte, this.#offset);
    assert(index >= 0, "truncated bencode value");
    return index;
  }
}

function expectDictionary(
  value: BencodeValue | undefined,
  name: string,
): Map<string, BencodeValue> {
  assert(value?.type === "dictionary", `${name} must be a dictionary`);
  return value.value;
}

function expectBytes(
  value: BencodeValue | undefined,
  name = "value",
): Uint8Array {
  assert(value?.type === "bytes", `${name} must be a byte string`);
  return value.value;
}

function expectInteger(
  value: BencodeValue | undefined,
  name: string,
): number {
  assert(value?.type === "integer", `${name} must be an integer`);
  return value.value;
}
