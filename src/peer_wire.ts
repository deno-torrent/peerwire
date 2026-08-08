import {
  type ByteReader,
  BytesUtil,
  type ByteWriter,
  InvalidByteCountError,
  IoUtil,
  UnexpectedEofError,
} from "@deno-torrent/toolkit";
import {
  DEFAULT_MAX_MESSAGE_LENGTH,
  HANDSHAKE_LENGTH,
  HandshakeExtension,
} from "@src/constants.ts";
import {
  PeerWireEofError,
  PeerWireError,
  PeerWireProtocolError,
} from "@src/errors.ts";
import {
  decodeHandshake,
  encodeHandshake,
  type PeerHandshake,
} from "@src/handshake.ts";
import {
  decodeMessagePayload,
  encodeMessage,
  type PeerMessage,
} from "@src/message.ts";
import { Bitfield } from "@src/bitfield.ts";

/** The minimal stream contract needed by {@link PeerWire}. */
export interface PeerWireTransport extends ByteReader, ByteWriter {
  close(): void | Promise<void>;
}

export enum PeerWireState {
  Handshaking,
  Connected,
  Closed,
}

export interface PeerWireOptions {
  transport: PeerWireTransport;
  infoHash: Uint8Array;
  peerId: Uint8Array | string;
  /** Optional peer ID expected from a tracker or another trusted source. */
  expectedPeerId?: Uint8Array | string;
  extensions?: Iterable<HandshakeExtension>;
  /** Used to validate and track incoming bitfield/have messages. */
  pieceCount?: number;
  /** Maximum accepted message length, including its one-byte message ID. */
  maxMessageLength?: number;
}

/**
 * A transport-independent BitTorrent peer wire connection.
 *
 * `Deno.TcpConn`, a uTP connection, or any compatible Reader/Writer can be used
 * as the transport. The class owns that transport and closes it from `close()`.
 */
export class PeerWire implements AsyncIterable<PeerMessage> {
  readonly transport: PeerWireTransport;
  readonly infoHash: Uint8Array;
  readonly peerId: Uint8Array;
  readonly expectedPeerId?: Uint8Array;
  readonly extensions: ReadonlySet<HandshakeExtension>;
  readonly pieceCount?: number;
  readonly maxMessageLength: number;

  state = PeerWireState.Handshaking;
  remoteHandshake?: PeerHandshake;
  remoteBitfield?: Bitfield;

  /** Whether this client currently prevents the peer from requesting blocks. */
  localChoking = true;
  localInterested = false;
  /** Whether the remote peer currently prevents this client from requesting. */
  remoteChoking = true;
  remoteInterested = false;

  uploadedBytes = 0;
  downloadedBytes = 0;

  #writeTail: Promise<void> = Promise.resolve();
  #reading = false;
  #handshakeSent = false;
  #handshakeReceived = false;

  constructor(options: PeerWireOptions) {
    if (options.infoHash.length !== 20) {
      throw new RangeError("infoHash must contain 20 bytes");
    }
    if (
      options.pieceCount !== undefined &&
      (!Number.isSafeInteger(options.pieceCount) || options.pieceCount < 0)
    ) {
      throw new RangeError("pieceCount must be a non-negative safe integer");
    }
    const maxMessageLength = options.maxMessageLength ??
      DEFAULT_MAX_MESSAGE_LENGTH;
    if (!Number.isSafeInteger(maxMessageLength) || maxMessageLength < 1) {
      throw new RangeError("maxMessageLength must be a positive safe integer");
    }

    const peerId = typeof options.peerId === "string"
      ? new TextEncoder().encode(options.peerId)
      : options.peerId;
    if (peerId.length !== 20) {
      throw new RangeError("peerId must contain 20 bytes");
    }
    const expectedPeerId = typeof options.expectedPeerId === "string"
      ? new TextEncoder().encode(options.expectedPeerId)
      : options.expectedPeerId;
    if (expectedPeerId && expectedPeerId.length !== 20) {
      throw new RangeError("expectedPeerId must contain 20 bytes");
    }

    this.transport = options.transport;
    this.infoHash = new Uint8Array(options.infoHash);
    this.peerId = new Uint8Array(peerId);
    this.expectedPeerId = expectedPeerId
      ? new Uint8Array(expectedPeerId)
      : undefined;
    this.extensions = new Set(options.extensions);
    this.pieceCount = options.pieceCount;
    this.maxMessageLength = maxMessageLength;
  }

  /** Exchange and validate handshakes. Safe for both connection directions. */
  async handshake(): Promise<PeerHandshake> {
    this.#assertOpen();
    const [, remote] = await Promise.all([
      this.sendHandshake(),
      this.receiveHandshake(),
    ]);
    return remote;
  }

  /** Send this endpoint's handshake exactly once. */
  async sendHandshake(): Promise<void> {
    this.#assertOpen();
    if (this.#handshakeSent) {
      throw new PeerWireError("local handshake has already been sent");
    }
    this.#handshakeSent = true;
    const bytes = encodeHandshake({
      infoHash: this.infoHash,
      peerId: this.peerId,
      extensions: this.extensions,
    });
    try {
      await this.#write(bytes);
      this.#updateConnectedState();
    } catch (error) {
      this.#handshakeSent = false;
      throw error;
    }
  }

  /** Read and validate the remote endpoint's handshake exactly once. */
  async receiveHandshake(): Promise<PeerHandshake> {
    this.#assertOpen();
    if (this.#handshakeReceived) {
      throw new PeerWireError("remote handshake has already been received");
    }
    const bytes = await this.#read(HANDSHAKE_LENGTH, false);
    const handshake = decodeHandshake(bytes!);
    if (!BytesUtil.equals(handshake.infoHash, this.infoHash)) {
      throw new PeerWireProtocolError(
        "remote handshake has a different info hash",
      );
    }
    if (
      this.expectedPeerId &&
      !BytesUtil.equals(handshake.peerId, this.expectedPeerId)
    ) {
      throw new PeerWireProtocolError(
        "remote handshake has an unexpected peer ID",
      );
    }
    this.#handshakeReceived = true;
    this.remoteHandshake = handshake;
    this.#updateConnectedState();
    return handshake;
  }

  /** Send one message. Concurrent calls are serialized in call order. */
  async send(message: PeerMessage): Promise<void> {
    this.#assertConnected();
    this.#assertExtensionNegotiated(message);
    const frame = encodeMessage(message);
    if (frame.length - 4 > this.maxMessageLength) {
      throw new RangeError(
        `message length exceeds configured limit ${this.maxMessageLength}`,
      );
    }
    await this.#write(frame);
    this.uploadedBytes += frame.length;
    this.#applyLocalState(message);
  }

  /** Read one message, or `null` after a clean transport EOF. */
  async readMessage(): Promise<PeerMessage | null> {
    this.#assertConnected();
    const prefix = await this.#read(4, true);
    if (prefix === null) return null;
    const length = new DataView(prefix.buffer).getUint32(0);
    if (length > this.maxMessageLength) {
      throw new PeerWireProtocolError(
        `peer message length ${length} exceeds limit ${this.maxMessageLength}`,
      );
    }

    let message: PeerMessage;
    if (length === 0) {
      message = { type: "keepAlive" };
    } else {
      const payload = await this.#read(length, false);
      message = decodeMessagePayload(payload!);
    }
    this.#assertExtensionNegotiated(message);
    this.downloadedBytes += 4 + length;
    this.#applyRemoteState(message);
    return message;
  }

  /** Gracefully release the owned transport. Idempotent. */
  async close(): Promise<void> {
    if (this.state === PeerWireState.Closed) return;
    this.state = PeerWireState.Closed;
    await this.#writeTail.catch(() => undefined);
    await this.transport.close();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<PeerMessage> {
    for (;;) {
      const message = await this.readMessage();
      if (message === null) return;
      yield message;
    }
  }

  choke(): Promise<void> {
    return this.send({ type: "choke" });
  }

  unchoke(): Promise<void> {
    return this.send({ type: "unchoke" });
  }

  interested(): Promise<void> {
    return this.send({ type: "interested" });
  }

  notInterested(): Promise<void> {
    return this.send({ type: "notInterested" });
  }

  have(pieceIndex: number): Promise<void> {
    return this.send({ type: "have", pieceIndex });
  }

  bitfield(bitfield: Bitfield | Uint8Array): Promise<void> {
    const bytes = bitfield instanceof Bitfield ? bitfield.toBytes() : bitfield;
    return this.send({ type: "bitfield", bitfield: bytes });
  }

  request(pieceIndex: number, begin: number, length: number): Promise<void> {
    return this.send({ type: "request", pieceIndex, begin, length });
  }

  piece(pieceIndex: number, begin: number, block: Uint8Array): Promise<void> {
    return this.send({ type: "piece", pieceIndex, begin, block });
  }

  cancel(pieceIndex: number, begin: number, length: number): Promise<void> {
    return this.send({ type: "cancel", pieceIndex, begin, length });
  }

  port(port: number): Promise<void> {
    return this.send({ type: "port", port });
  }

  extended(extensionId: number, payload: Uint8Array): Promise<void> {
    return this.send({ type: "extended", extensionId, payload });
  }

  #write(bytes: Uint8Array): Promise<void> {
    const operation = this.#writeTail.then(async () => {
      try {
        await IoUtil.writeAll(this.transport, bytes);
      } catch (error) {
        if (error instanceof InvalidByteCountError) {
          if (error.count <= 0) {
            throw new PeerWireEofError("transport stopped while writing", {
              cause: error,
            });
          }
          throw new PeerWireError(
            "transport reported an invalid write length",
            { cause: error },
          );
        }
        throw error;
      }
    });
    this.#writeTail = operation.catch(() => undefined);
    return operation;
  }

  async #read(
    length: number,
    allowCleanEof: boolean,
  ): Promise<Uint8Array | null> {
    if (this.#reading) {
      throw new PeerWireError("concurrent reads are not supported");
    }
    this.#reading = true;
    try {
      const bytes = new Uint8Array(length);
      try {
        const complete = await IoUtil.readExactly(this.transport, bytes, {
          allowCleanEof,
        });
        return complete ? bytes : null;
      } catch (error) {
        if (error instanceof UnexpectedEofError) {
          throw new PeerWireEofError(
            `transport ended after ${error.bytesRead} of ${error.expectedBytes} bytes`,
            { cause: error },
          );
        }
        if (error instanceof InvalidByteCountError) {
          throw new PeerWireError(
            "transport reported an invalid read length",
            { cause: error },
          );
        }
        throw error;
      }
    } finally {
      this.#reading = false;
    }
  }

  #updateConnectedState(): void {
    if (this.#handshakeSent && this.#handshakeReceived) {
      this.state = PeerWireState.Connected;
    }
  }

  #applyLocalState(message: PeerMessage): void {
    switch (message.type) {
      case "choke":
        this.localChoking = true;
        break;
      case "unchoke":
        this.localChoking = false;
        break;
      case "interested":
        this.localInterested = true;
        break;
      case "notInterested":
        this.localInterested = false;
        break;
    }
  }

  #applyRemoteState(message: PeerMessage): void {
    switch (message.type) {
      case "choke":
        this.remoteChoking = true;
        break;
      case "unchoke":
        this.remoteChoking = false;
        break;
      case "interested":
        this.remoteInterested = true;
        break;
      case "notInterested":
        this.remoteInterested = false;
        break;
      case "bitfield":
        if (this.pieceCount !== undefined) {
          this.remoteBitfield = Bitfield.fromBytes(
            this.pieceCount,
            message.bitfield,
          );
        }
        break;
      case "have":
        if (this.pieceCount !== undefined) {
          if (message.pieceIndex >= this.pieceCount) {
            throw new PeerWireProtocolError(
              `remote have index ${message.pieceIndex} is out of range`,
            );
          }
          this.remoteBitfield ??= new Bitfield(this.pieceCount);
          this.remoteBitfield.set(message.pieceIndex);
        }
        break;
      case "haveAll":
        if (this.pieceCount !== undefined) {
          this.remoteBitfield = new Bitfield(this.pieceCount);
          for (let index = 0; index < this.pieceCount; index++) {
            this.remoteBitfield.set(index);
          }
        }
        break;
      case "haveNone":
        if (this.pieceCount !== undefined) {
          this.remoteBitfield = new Bitfield(this.pieceCount);
        }
        break;
    }
  }

  #assertExtensionNegotiated(message: PeerMessage): void {
    let required: HandshakeExtension | undefined;
    switch (message.type) {
      case "suggestPiece":
      case "haveAll":
      case "haveNone":
      case "rejectRequest":
      case "allowedFast":
        required = HandshakeExtension.Fast;
        break;
      case "extended":
        required = HandshakeExtension.ExtensionProtocol;
        break;
      case "port":
        required = HandshakeExtension.Dht;
        break;
      default:
        return;
    }
    if (
      !this.extensions.has(required) ||
      !this.remoteHandshake?.extensions.has(required)
    ) {
      throw new PeerWireProtocolError(
        `${required} message was used without handshake negotiation`,
      );
    }
  }

  #assertOpen(): void {
    if (this.state === PeerWireState.Closed) {
      throw new PeerWireError("peer wire is closed");
    }
  }

  #assertConnected(): void {
    this.#assertOpen();
    if (this.state !== PeerWireState.Connected) {
      throw new PeerWireError("peer wire handshake is not complete");
    }
  }
}
