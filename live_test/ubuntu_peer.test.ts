import { HashUtil, NetUtil } from "@deno-torrent/toolkit";
import { assert, assertEquals } from "std/assert/mod.ts";
import { PeerWire } from "@src/peer_wire.ts";

const DEFAULT_TORRENT_URL =
  "https://releases.ubuntu.com/24.04.4/ubuntu-24.04.4-live-server-amd64.iso.torrent";
const decoder = new TextDecoder();

Deno.test({
  name: "PeerWire handshakes with a live Ubuntu torrent peer",
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
    assert(peers.length > 0, "Ubuntu tracker returned no IPv4 peers");

    const attempts = peers.slice(0, 12).map((peer) =>
      handshakeWithPeer(peer, torrent.infoHash, torrent.pieceCount, peerId)
    );
    let remotePeerId: Uint8Array;
    try {
      remotePeerId = await Promise.any(attempts);
    } catch (error) {
      if (error instanceof AggregateError) {
        const reasons = error.errors.map((reason) =>
          reason instanceof Error ? reason.message : String(reason)
        );
        throw new Error(
          `could not handshake with ${attempts.length} Ubuntu peers: ${
            reasons.join("; ")
          }`,
        );
      }
      throw error;
    } finally {
      await Promise.allSettled(attempts);
      await stopAnnounce(torrent, peerId).catch(() => undefined);
    }

    assertEquals(remotePeerId.length, 20);
  },
});

interface TorrentMetadata {
  announceUrl: string;
  infoHash: Uint8Array;
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
  const url = announceUrl(torrent, peerId, "started", 50);
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  assert(response.ok, `tracker announce failed: ${response.status}`);

  const value = new BencodeDecoder(
    new Uint8Array(await response.arrayBuffer()),
  ).decode();
  const dictionary = expectDictionary(value, "tracker response");
  const failure = dictionary.get("failure reason");
  if (failure) throw new Error(decoder.decode(expectBytes(failure)));
  const peers = expectBytes(dictionary.get("peers"), "tracker peers");
  assertEquals(peers.length % 6, 0, "invalid compact IPv4 peer list");

  const addresses: PeerAddress[] = [];
  for (let offset = 0; offset < peers.length; offset += 6) {
    const endpoint = NetUtil.compactIPv4ToEndpoint(
      peers.subarray(offset, offset + 6),
    );
    addresses.push({
      hostname: endpoint.host,
      port: endpoint.port,
    });
  }
  return addresses;
}

async function stopAnnounce(
  torrent: TorrentMetadata,
  peerId: Uint8Array,
): Promise<void> {
  const response = await fetch(announceUrl(torrent, peerId, "stopped", 0), {
    signal: AbortSignal.timeout(5_000),
  });
  await response.body?.cancel();
}

function announceUrl(
  torrent: TorrentMetadata,
  peerId: Uint8Array,
  event: "started" | "stopped",
  numwant: number,
): string {
  const separator = torrent.announceUrl.includes("?") ? "&" : "?";
  return torrent.announceUrl + separator + [
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

async function handshakeWithPeer(
  peer: PeerAddress,
  infoHash: Uint8Array,
  pieceCount: number,
  peerId: Uint8Array,
): Promise<Uint8Array> {
  let connection: Deno.TcpConn | undefined;
  let wire: PeerWire | undefined;
  try {
    connection = await withTimeout(
      Deno.connect({ hostname: peer.hostname, port: peer.port }),
      5_000,
      `connect to ${peer.hostname}:${peer.port}`,
      undefined,
      (lateConnection) => lateConnection.close(),
    );
    wire = new PeerWire({
      transport: connection,
      infoHash,
      peerId,
      pieceCount,
    });
    const handshake = await withTimeout(
      wire.handshake(),
      5_000,
      `handshake with ${peer.hostname}:${peer.port}`,
      () => wire?.close(),
    );
    return handshake.peerId;
  } finally {
    if (wire) {
      await wire.close();
    } else {
      connection?.close();
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
  const announceUrl = decoder.decode(
    expectBytes(root.get("announce"), "torrent announce URL"),
  );
  const info = root.get("info");
  const infoDictionary = expectDictionary(info, "torrent info");
  const length = expectInteger(infoDictionary.get("length"), "torrent length");
  const pieces = expectBytes(infoDictionary.get("pieces"), "torrent pieces");
  assertEquals(pieces.length % 20, 0, "invalid torrent pieces field");
  const infoBytes = bytes.subarray(info!.start, info!.end);

  return {
    announceUrl,
    infoHash: await HashUtil.sha1(infoBytes),
    length,
    pieceCount: pieces.length / 20,
  };
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
