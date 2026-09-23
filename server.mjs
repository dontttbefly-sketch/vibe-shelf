import path from "node:path";
import { fileURLToPath } from "node:url";
import { createShelfServer } from "./lib/app.mjs";
import { createConfiguredModelClient } from "./lib/model-client.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8899);
const server = createShelfServer({
  dataDir: path.join(root, "data"),
  publicDir: path.join(root, "public"),
  modelClient: createConfiguredModelClient({ root }),
});

server.listen(port, () => {
  console.log(`知识书架已启动： http://localhost:${port}`);
});
