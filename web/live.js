export function connectLive({ api, changed, connected, disconnected }) {
  const controller = new AbortController();
  let retryTimer;
  let reader;
  let open = false;
  async function connect() {
    try {
      const response = await api("/api/stream", { signal: controller.signal });
      if (!response.ok || !response.body) throw new Error(`Stream HTTP ${response.status}`);
      reader = response.body.getReader();
      open = true;
      connected();
      changed(); // Catch changes missed while disconnected, before subscribing.
      const decoder = new TextDecoder();
      let buffer = "";
      while (!controller.signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (frame.startsWith("data:")) changed();
        }
      }
    } catch {
      // Fetch is aborted on hiding; network failures use the regular poll until reconnect.
    } finally {
      open = false;
      reader?.releaseLock();
      reader = undefined;
      if (!controller.signal.aborted) {
        disconnected();
        retryTimer = setTimeout(connect, 3000);
      }
    }
  }
  void connect();
  return {
    get open() { return open; },
    close() {
      controller.abort();
      clearTimeout(retryTimer);
    },
  };
}
