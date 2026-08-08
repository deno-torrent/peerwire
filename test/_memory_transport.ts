import type { PeerWireTransport } from "@src/peer_wire.ts";

class ByteChannel {
  #chunks: Uint8Array[] = [];
  #waiters: Array<(chunk: Uint8Array | null) => void> = [];
  #closed = false;

  push(chunk: Uint8Array): void {
    if (this.#closed) throw new Error("channel is closed");
    const waiter = this.#waiters.shift();
    if (waiter) waiter(chunk);
    else this.#chunks.push(chunk);
  }

  receive(): Promise<Uint8Array | null> {
    const chunk = this.#chunks.shift();
    if (chunk) return Promise.resolve(chunk);
    if (this.#closed) return Promise.resolve(null);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter(null);
  }
}

export class MemoryTransport implements PeerWireTransport {
  #incoming: ByteChannel;
  #outgoing: ByteChannel;
  #current?: Uint8Array;
  #maxChunk: number;
  #closed = false;

  constructor(incoming: ByteChannel, outgoing: ByteChannel, maxChunk: number) {
    this.#incoming = incoming;
    this.#outgoing = outgoing;
    this.#maxChunk = maxChunk;
  }

  async read(buffer: Uint8Array): Promise<number | null> {
    if (buffer.length === 0) return 0;
    this.#current ??= (await this.#incoming.receive()) ?? undefined;
    if (!this.#current) return null;
    const length = Math.min(
      buffer.length,
      this.#current.length,
      this.#maxChunk,
    );
    buffer.set(this.#current.subarray(0, length));
    this.#current = length === this.#current.length
      ? undefined
      : this.#current.subarray(length);
    return length;
  }

  write(buffer: Uint8Array): Promise<number> {
    if (this.#closed) return Promise.resolve(0);
    const length = Math.min(buffer.length, this.#maxChunk);
    this.#outgoing.push(buffer.slice(0, length));
    return Promise.resolve(length);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#outgoing.close();
  }
}

export function memoryTransportPair(maxChunk = Infinity): [
  MemoryTransport,
  MemoryTransport,
] {
  const leftToRight = new ByteChannel();
  const rightToLeft = new ByteChannel();
  return [
    new MemoryTransport(rightToLeft, leftToRight, maxChunk),
    new MemoryTransport(leftToRight, rightToLeft, maxChunk),
  ];
}
