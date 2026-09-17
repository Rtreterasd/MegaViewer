const { Readable } = require("node:stream");
// MEGAJS 1.x's Web Streams path ignores backpressure and leaves rejected
// reader.read() promises on abort. Give it a Node stream via its public API.
async function megaFetch(url, options) {
  if (!options?.signal)
    options = { ...options, signal: AbortSignal.timeout(15000) };
  const response = await fetch(url, options);
  let body;
  return {
    status: response.status,
    statusText: response.statusText,
    ok: response.ok,
    headers: response.headers,
    json: () => response.json(),
    arrayBuffer: () => response.arrayBuffer(),
    get body() {
      if (!response.body) return null;
      if (!body) {
        body = Readable.fromWeb(response.body);
        body.on("error", () => {});
        const pipe = body.pipe.bind(body);
        body.pipe = (destination) => {
          body.on("error", (error) => {
            if (!destination.destroyed) destination.destroy(error);
          });
          destination.once("close", () => body.destroy());
          return pipe(destination);
        };
      }
      return body;
    },
  };
}
module.exports = { megaFetch };
