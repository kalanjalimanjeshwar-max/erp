import http from 'http';
import { BiometricBridgeRunner } from './bridge-runner.js';
import { BridgeLogger } from './logger.js';

export class BridgeHealthServer {
  private server: http.Server | null = null;
  private readonly host: string;
  private readonly port: number;
  private readonly runner: BiometricBridgeRunner;
  private readonly logger: BridgeLogger;

  constructor(options: {
    host: string;
    port: number;
    runner: BiometricBridgeRunner;
    logger: BridgeLogger;
  }) {
    this.host = options.host;
    this.port = options.port;
    this.runner = options.runner;
    this.logger = options.logger;
  }

  async start(): Promise<void> {
    if (this.server) return;

    this.server = http.createServer((req, res) => {
      const urlPath = (req.url || '/').split('?')[0];
      const snapshot = this.runner.getStatusSnapshot();

      if (req.method === 'GET' && urlPath === '/health') {
        const anyAuthError = snapshot.terminals.some((t) => t.authError);
        const statusCode = snapshot.running && !anyAuthError ? 200 : 503;
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: statusCode === 200 ? 'ok' : 'degraded',
            running: snapshot.running,
            pid: snapshot.pid,
            uptimeSeconds: snapshot.uptimeSeconds,
            terminalCount: snapshot.terminals.length,
            bridgeConnectedCount: snapshot.terminals.filter((t) => t.bridgeConnected).length,
            deviceConnectedCount: snapshot.terminals.filter((t) => t.deviceReachable).length,
            onlineCount: snapshot.terminals.filter((t) => t.bridgeConnected && t.deviceReachable).length,
          })
        );
        return;
      }

      if (req.method === 'GET' && urlPath === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(snapshot, null, 2));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found. Available endpoints: GET /health, GET /status' }));
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.port, this.host, () => {
        this.logger.info('health_server_listening', {
          host: this.host,
          port: this.port,
        });
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const srv = this.server;
    this.server = null;
    await new Promise<void>((resolve) => {
      srv.close(() => resolve());
    });
  }
}
