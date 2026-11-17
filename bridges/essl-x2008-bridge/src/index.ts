import path from 'path';
import { loadBridgeConfig } from './config.js';
import { CheckpointStore } from './checkpoint-store.js';
import { CoreErpHttpClient } from './coreerp-client.js';
import { BridgeLogger } from './logger.js';
import { BiometricBridgeRunner } from './bridge-runner.js';
import { BridgeHealthServer } from './health-server.js';
import { saveDpapiSecret, validateTransportUrl } from './security/dpapi.js';

function getArgValue(args: string[], flag: string): string | undefined {
  const eqArg = args.find((a) => a.startsWith(`${flag}=`));
  if (eqArg) return eqArg.slice(flag.length + 1);
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const baseDir = process.env.BRIDGE_WORK_DIR ? path.resolve(process.env.BRIDGE_WORK_DIR) : process.cwd();

  if (args.includes('--protect-secret')) {
    const config = loadBridgeConfig(baseDir);
    const credName = getArgValue(args, '--name') || 'coreerp-essl-x2008-primary';
    const scope = (getArgValue(args, '--scope') === 'LocalMachine' ? 'LocalMachine' : 'CurrentUser');
    const secretVal = process.env.SECRET_TO_PROTECT || getArgValue(args, '--value');
    if (!secretVal) {
      console.error('Provide secret via SECRET_TO_PROTECT environment variable.');
      process.exit(1);
    }
    saveDpapiSecret(config.dpapiStorePath, credName, secretVal, scope);
    console.log(`Encrypted credential '${credName}' stored safely via Windows DPAPI (${scope}) at ${config.dpapiStorePath}`);
    process.exit(0);
  }

  const config = loadBridgeConfig(baseDir);
  const logger = new BridgeLogger({
    level: config.logLevel,
    logDir: config.logDir,
  });
  const checkpointStore = new CheckpointStore(config.dataDir);
  const coreErpClient = new CoreErpHttpClient(config.coreErpBaseUrl);
  const runner = new BiometricBridgeRunner({
    config,
    logger,
    checkpointStore,
    coreErpClient,
  });

  if (args.includes('--status')) {
    try {
      const res = await fetch(`http://${config.healthHost}:${config.healthPort}/status`);
      const text = await res.text();
      console.log(text);
      process.exit(res.ok ? 0 : 1);
    } catch {
      console.log(JSON.stringify(runner.getStatusSnapshot(), null, 2));
      process.exit(0);
    }
  }

  if (args.includes('--test-connection') || args.includes('--diagnose')) {
    try {
      validateTransportUrl(config.coreErpBaseUrl, config.allowInsecureHttp);
      const reports = await runner.testAllConnections();
      console.log(JSON.stringify({ bridgeHost: config.bridgeHost, reports }, null, 2));
      const allOk = reports.every((r) => r.tcpConnected && r.serialMatched && r.coreErpHeartbeatOk);
      process.exit(allOk ? 0 : 1);
    } catch (err: unknown) {
      console.error(JSON.stringify({ error: (err as Error).message }, null, 2));
      process.exit(1);
    }
  }

  if (args.includes('--sync-users-once')) {
    let hadError = false;
    const results = [];
    for (const term of config.terminals) {
      if (term.enabled === false) continue;
      try {
        const res = await runner.syncTerminalUsersOnce(term.id);
        results.push({ terminalId: term.id, ok: true, ...res });
      } catch (err: unknown) {
        hadError = true;
        results.push({ terminalId: term.id, ok: false, error: (err as Error).message });
      }
    }
    console.log(JSON.stringify({ results }, null, 2));
    process.exit(hadError ? 1 : 0);
  }

  if (args.includes('--sync-once')) {
    let hadError = false;
    const results = [];
    for (const term of config.terminals) {
      if (term.enabled === false) continue;
      try {
        const res = await runner.syncTerminalOnce(term.id);
        results.push({ terminalId: term.id, ok: true, ...res });
      } catch (err: unknown) {
        hadError = true;
        results.push({ terminalId: term.id, ok: false, error: (err as Error).message });
      }
    }
    console.log(JSON.stringify({ results }, null, 2));
    process.exit(hadError ? 1 : 0);
  }

  // Long-running daemon mode
  const healthServer = new BridgeHealthServer({
    host: config.healthHost,
    port: config.healthPort,
    runner,
    logger,
  });

  await healthServer.start();
  await runner.start();

  const shutdown = async (signal: string) => {
    logger.info('bridge_shutdown_signal', { signal });
    await runner.stop();
    await healthServer.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', event: 'bridge_fatal', error: err.message }));
  process.exit(1);
});
