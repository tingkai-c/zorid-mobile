#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import QRCode from 'qrcode';
import { Host } from './service';

const { values, positionals } = parseArgs({ args: Bun.argv.slice(2), allowPositionals: true, options: {
  json: { type: 'boolean' }, url: { type: 'string' }, name: { type: 'string' }, 'dev-loopback': { type: 'boolean' },
  port: { type: 'string', default: '8787' }, runtime: { type: 'string' }, platform: { type: 'string', default: 'ios' },
  state: { type: 'string' },
} });
const host = new Host(values.state);
const print = (value: unknown) => console.log(JSON.stringify(value, null, values.json ? undefined : 2));
try {
  switch (positionals[0]) {
    case 'init': {
      if (!values.url) throw new Error('init requires --url');
      print(host.init(values.url, values.name, values['dev-loopback'])); break;
    }
    case 'serve': {
      const port = Number(values.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
      const config = host.config;
      Bun.serve({ hostname: '127.0.0.1', port, fetch: request => host.handle(request), error: () => new Response('Internal host error', { status: 500 }) });
      print({ listening: `http://127.0.0.1:${port}`, publicOrigin: config.origin });
      break;
    }
    case 'pair': {
      const offer = host.pair();
      if (!values.json) console.log(await QRCode.toString(offer.uri, { type: 'terminal', small: true }));
      print(offer); break;
    }
    case 'devices': print(host.devices()); break;
    case 'revoke': {
      if (!positionals[1]) throw new Error('revoke requires a device ID');
      print(host.revoke(positionals[1])); break;
    }
    case 'deploy': {
      if (!positionals[1] || !values.runtime) throw new Error('deploy <export-directory> --runtime <binary-runtime>');
      print(host.deploy(positionals[1], values.runtime, values.platform)); break;
    }
    case 'rollback': {
      if (!positionals[1]) throw new Error('rollback requires a release ID');
      print(host.rollback(positionals[1])); break;
    }
    case 'status': print(host.status()); break;
    default: throw new Error('Commands: init --url <https-origin>, serve, pair, devices, revoke <device>, deploy <export> --runtime <runtime>, rollback <release>, status. Options: --json --state <private-directory>');
  }
} catch (error) {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : 'Host command failed' }));
  process.exitCode = 1;
} finally {
  if (positionals[0] !== 'serve' || process.exitCode) host.close();
}
