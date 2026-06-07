// Source code of the Web Worker that runs user functions in a sandbox.
// Exported as a string so we can build it into a Blob URL at runtime.

export const WORKER_SOURCE = /* js */ `
self.addEventListener('message', async (event) => {
  const { code, request, secrets } = event.data;
  const logs = [];
  const startedAt = Date.now();

  // Capture console
  const mkLog = (level) => (...args) => {
    logs.push({
      level,
      time: Date.now(),
      message: args.map(a => {
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch { return String(a); }
      }).join(' '),
    });
  };
  self.console = {
    log: mkLog('log'),
    info: mkLog('info'),
    warn: mkLog('warn'),
    error: mkLog('error'),
    debug: mkLog('debug'),
  };

  // Build Request object
  const req = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
  });

  // Sandboxed env (secrets) — mimic Deno.env.get
  const envMap = secrets || {};
  self.Deno = {
    env: {
      get: (k) => envMap[k],
      toObject: () => ({ ...envMap }),
    },
  };

  try {
    // Strip ESM imports/exports for the sandbox (simple regex — good enough for demo)
    let userCode = code
      .replace(/^\\s*import\\s+[^;]+;?\\s*$/gm, '')
      .replace(/^\\s*export\\s+default\\s+/m, 'return ')
      .replace(/^\\s*export\\s+/gm, '');

    // If no "return", assume the handler is the last expression / Deno.serve pattern
    let handler;
    const fn = new Function('Request', 'Response', 'fetch', 'console', 'Deno', \`
      let __handler = null;
      const Deno_orig = Deno;
      Deno = { ...Deno_orig, serve: (h) => { __handler = h; return { finished: Promise.resolve() }; } };
      const __result = (function() { \${userCode} })();
      return __handler || __result;
    \`);

    handler = fn(Request, Response, fetch, self.console, self.Deno);

    if (typeof handler !== 'function') {
      throw new Error('Function must export a default handler or call Deno.serve(handler)');
    }

    const result = await handler(req);
    if (!(result instanceof Response)) {
      throw new Error('Handler must return a Response object');
    }

    const respBody = await result.text();
    const respHeaders = {};
    result.headers.forEach((v, k) => { respHeaders[k] = v; });

    self.postMessage({
      ok: true,
      status: result.status,
      headers: respHeaders,
      body: respBody,
      logs,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    self.postMessage({
      ok: false,
      error: err && err.message ? err.message : String(err),
      stack: err && err.stack ? err.stack : null,
      logs,
      durationMs: Date.now() - startedAt,
    });
  }
});
`;
