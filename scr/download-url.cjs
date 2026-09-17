// Reuse the MEGA ticket instead of an API round trip for every media block.
function cacheDownloadUrl(file, ttl = 5 * 60 * 1000) {
  const api = file.api,
    proxy = Object.create(api);
  let ticket = null,
    expires = 0;
  proxy.request = (request, callback) => {
    if (request.a !== "g" || request.g !== 1)
      return api.request(request, callback);
    if (!ticket || Date.now() >= expires) {
      expires = Date.now() + ttl;
      ticket = api.request({
        ...request,
        _querystring: request._querystring
          ? { ...request._querystring }
          : undefined,
      });
      ticket.catch(() => {
        ticket = null;
      });
    }
    const result = ticket;
    if (callback) {
      result.then((r) => callback(null, r), callback);
      return;
    }
    return result;
  };
  file.api = proxy;
  file.invalidateDownloadUrl = () => {
    ticket = null;
  };
  return file;
}
module.exports = { cacheDownloadUrl };
