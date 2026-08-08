/** Base error for invalid or failed peer wire operations. */
export class PeerWireError extends Error {
  override name = "PeerWireError";
}

/** Raised when bytes do not represent a valid handshake or message. */
export class PeerWireProtocolError extends PeerWireError {
  override name = "PeerWireProtocolError";
}

/** Raised when a transport closes before the requested bytes are read. */
export class PeerWireEofError extends PeerWireError {
  override name = "PeerWireEofError";
}
