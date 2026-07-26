import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();

buildApp({ config })
  .then((app) => app.listen({ port: config.port, host: '0.0.0.0' }))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
