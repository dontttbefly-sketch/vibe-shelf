import { createShelfServer } from "../lib/app.mjs";
import { makeTempDir } from "./helpers.mjs";

export const validBookHtml = `<!doctype html><style>body{}</style><div class="progress"></div><main class="book-main"><section class="chapter" id="ch-1"><h2>主书</h2><p>正文</p></section></main><script>void 0</script>`;

export function fakeModel(results = ["answer"]) {
  let index = 0;
  return {
    complete: async () => {
      const result = results[index++];
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

export async function startTestServer(t, { modelClient = fakeModel(), environment } = {}) {
  const root = makeTempDir(t);
  const server = createShelfServer({
    dataDir: `${root}/data`,
    publicDir: `${root}/public`,
    modelClient,
    environment,
  });
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  return { base: `http://127.0.0.1:${server.address().port}`, root };
}
