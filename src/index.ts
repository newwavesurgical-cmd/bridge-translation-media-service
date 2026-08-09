import { getConfig } from './config.js';
import { createBridgeMediaServer } from './http.js';

const config = getConfig();
const { server } = createBridgeMediaServer(config);

server.listen(config.PORT, () => {
  console.log(`Bridge translation media service listening on :${config.PORT}`);
});
