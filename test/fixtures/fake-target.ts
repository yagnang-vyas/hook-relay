import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export type Responder = (
  req: RecordedRequest,
  res: ServerResponse,
  index: number,
) => void | Promise<void>;

/** A local HTTP server standing in for a downstream service. */
export class FakeTarget {
  readonly requests: RecordedRequest[] = [];
  private server: Server | undefined;
  private responder: Responder = (_req, res) => {
    res.statusCode = 200;
    res.end('ok');
  };
  private readonly sockets = new Set<Socket>();

  get url(): string {
    const address = this.server?.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  respondWith(responder: Responder): this {
    this.responder = responder;
    return this;
  }

  /** Responds with each status in turn, repeating the last one. */
  respondWithSequence(statuses: number[]): this {
    return this.respondWith((_req, res, index) => {
      res.statusCode = statuses[Math.min(index, statuses.length - 1)] ?? 200;
      res.end('response body that must never be stored');
    });
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    return this;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  reset(): void {
    this.requests.length = 0;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const recorded: RecordedRequest = {
      method: req.method ?? '',
      url: req.url ?? '',
      headers: req.headers,
      body: Buffer.concat(chunks),
    };
    const index = this.requests.push(recorded) - 1;
    await this.responder(recorded, res, index);
  }
}
