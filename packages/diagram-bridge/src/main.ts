import { createBridgeServer } from './server.js';

const port = Number(process.env.BRIDGE_PORT ?? 7070);
const host = process.env.BRIDGE_HOST ?? '127.0.0.1';
const server = createBridgeServer();
server.listen(port, host, () => {
  const address = server.address();
  const actual = address && typeof address === 'object' ? address.port : port;
  // Startup line only (BRIDGE_PORT=0 picks a free port; tests read it from here). No request data is ever logged.
  // bearer:disable javascript_lang_logger_leak
  console.log(`diagram-bridge listening on ${host}:${actual}`);
});
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
