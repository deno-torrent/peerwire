# Deno BitTorrent Peer Wire 协议库

[English](./README.md)

面向 Deno 的、与传输层无关的 BitTorrent Peer Wire 协议 TypeScript
实现。库中实现了 BEP 3 握手及消息流，并支持 BEP 5、BEP 6 与 BEP 10
引入的常用消息。

## 项目状态

该库负责 TCP 或 μTP 之上的协议层，不负责节点发现、分片调度、哈希校验与文件存储。

- 已在 Deno 2.9.5 验证；CI 持续跟踪当前 Deno 2.x 版本。
- 可使用 `Deno.TcpConn`、`@deno-torrent/utp` 的连接或兼容的自定义传输。
- 公共 API：`PeerWire`、握手/消息编解码器和 `Bitfield`。
- 未知消息 ID 会保留为原始消息，便于兼容未来扩展。
- 在分配消息缓冲区前校验长度上限。

## 安装

```ts
import { PeerWire } from "jsr:@deno-torrent/peerwire";
```

仓库内开发可使用：

```ts
import { PeerWire } from "./mod.ts";
```

## 快速开始

```ts
import { HandshakeExtension, PeerWire } from "jsr:@deno-torrent/peerwire";

const connection = await Deno.connect({
  hostname: "127.0.0.1",
  port: 6881,
});

const wire = new PeerWire({
  transport: connection,
  infoHash, // 必须为 20 字节
  peerId: "-PW0001-123456789012", // UTF-8 编码后必须为 20 字节
  pieceCount: torrent.pieces.length,
  extensions: [
    HandshakeExtension.ExtensionProtocol,
    HandshakeExtension.Dht,
  ],
});

try {
  const remote = await wire.handshake();
  console.log("已连接", new TextDecoder().decode(remote.peerId));

  await wire.interested();
  for await (const message of wire) {
    if (message.type === "unchoke") {
      await wire.request(0, 0, 16 * 1024);
    } else if (message.type === "piece") {
      console.log("收到", message.block.length, "字节");
      break;
    }
  }
} finally {
  await wire.close();
}
```

μTP 连接也可直接作为传输层：

```ts
import { Utp } from "jsr:@deno-torrent/utp";

const endpoint = new Utp("peer-wire");
const connection = await endpoint.connect({
  hostname: "127.0.0.1",
  port: 6881,
});
const wire = new PeerWire({ transport: connection, infoHash, peerId });
await wire.handshake();
```

使用结束后应同时关闭 `wire` 和所属的 `Utp` endpoint。

## API

### `new PeerWire(options)`

`transport` 需要实现 `read()`、`write()` 和 `close()`。`infoHash` 与 `peerId`
必须各为 20 字节。配置 `pieceCount` 后会校验并跟踪远端 bitfield。
`maxMessageLength` 默认是 2 MiB。 如果 tracker 已给出远端 peer ID，可通过
`expectedPeerId` 配置，拒绝来自其他节点的握手。

### 握手

- `handshake()` 并发收发标准的 68 字节握手。
- 需要控制顺序时可以分别调用 `sendHandshake()` 与 `receiveHandshake()`。
- info hash 不一致、协议标识非法或传输提前结束时会拒绝连接。
- 配置 `expectedPeerId` 后还会校验远端握手中的 peer ID。

### 消息

`send(message)` 可发送任意 `PeerMessage`；`readMessage()` 返回下一条消息，正常
EOF 时返回 `null`。`PeerWire` 同时支持异步迭代。便捷方法包括
`choke`、`unchoke`、
`interested`、`have`、`bitfield`、`request`、`piece`、`cancel`、`port` 和
`extended`。

消息联合类型包括：

- BEP 3：keep-alive、choke/interest
  状态、have、bitfield、request、piece、cancel。
- BEP 5：DHT port。
- BEP 6：suggest piece、have all/none、reject request、allowed fast。
- BEP 10：原始 extended 消息。扩展 ID `0` 表示扩展握手；bencode
  负载由应用层管理。

Fast、DHT port 和 extended 消息只有在双方握手均声明相应能力后才会被 `PeerWire`
接受。DHT 本身由
[`deno-torrent/torrent-dht`](https://github.com/deno-torrent/torrent-dht)
负责；本库仅传输 BEP 5 定义的 `PORT` 消息。

无需建立连接时，也可独立使用 `encodeHandshake`、`decodeHandshake`、
`encodeMessage` 与 `decodeMessage`。

### 状态

每次收发消息后，`localChoking`、`localInterested`、`remoteChoking` 和
`remoteInterested` 会反映当前协议状态。配置 `pieceCount` 后，`remoteBitfield`
会跟踪 bitfield 与 have 消息。`uploadedBytes` 与 `downloadedBytes`
统计握手之后的 完整消息帧字节数。

## 开发

```sh
deno task fmt
deno task check
deno task lint
deno task test
deno task test:live # 可选的公网握手测试
deno task test:coverage
deno task coverage
```

更多说明见[架构](./docs/architecture.md)、[测试](./docs/testing.md)与
[贡献指南](./docs/contributing.md)。

## 许可证

[MIT](./LICENSE)
