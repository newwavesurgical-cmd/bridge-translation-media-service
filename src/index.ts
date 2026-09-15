import { getConfig } from './config.js';
import { createBridgeMediaServer } from './http.js';

const config = getConfig();
const { server, crmVoice } = createBridgeMediaServer(config);

// Preserve the durable partial transcript on a normal host shutdown. Abrupt
// termination leaves the CRM intent unfinalized and cannot authorize a redial.
process.once('SIGTERM', () => {
  server.close();
  void crmVoice.close().finally(() => process.exit(0));
  setTimeout(() => process.exit(1), 25_000).unref();
});

server.listen(config.PORT, () => {
  console.log(`Bridge translation media service listening on :${config.PORT}`);
});
