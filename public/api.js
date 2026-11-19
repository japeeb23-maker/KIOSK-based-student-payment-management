(function () {
  const revisions = new Map();
  async function request(url, options = {}) {
    if (window.location.protocol === "file:") {
      throw new Error("Open FBC Paypoint through the backend at http://127.0.0.1:4177/index.html. Do not open index.html directly from File Explorer.");
    }

    let response;
    try {
      response = await fetch(url, {
        credentials: "same-origin",
        cache: "no-store",
        ...options,
        headers: { "Content-Type": "application/json", ...(options.headers || {}) }
      });
    } catch (error) {
      throw new Error(`Cannot connect to the FBC Paypoint server. Check that the backend is running. (${error.message})`);
    }

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error || `Server request failed (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    const revision = response.headers.get("ETag");
    if (revision) revisions.set(url, revision);
    return body;
  }

  window.fbcApi = {
    get(url) { return request(url); },
    post(url, body = {}, headers = {}) { return request(url, { method: "POST", headers, body: JSON.stringify(body) }); },
    put(url, body) {
      const revision = revisions.get(url);
      return request(url, { method: "PUT", headers: revision ? { "If-Match": revision } : {}, body: JSON.stringify(body) });
    }
  };
})();
