/**
 * A server-sent event stream for React Native, which has no EventSource: its XMLHttpRequest hands the text over as it
 * arrives once a progress listener is set. Only `data:` lines are read — all Deskzo's chat stream sends (src/app/api/
 * app/chat/stream). Returns the way to close it; `onEnd` is told how it ended (the HTTP status, 0 offline).
 */
export function openEventStream(
  url: string,
  headers: Record<string, string>,
  on: { open?: () => void; data: (text: string) => void; end: (status: number) => void },
): () => void {
  let xhr: XMLHttpRequest | null = new XMLHttpRequest();
  let seen = 0;
  let buffer = "";
  let opened = false;

  xhr.open("GET", url);
  for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
  xhr.setRequestHeader("accept", "text/event-stream");
  xhr.setRequestHeader("cache-control", "no-cache");

  const read = () => {
    if (!xhr) return;
    const text = xhr.responseText ?? "";
    buffer += text.slice(seen);
    seen = text.length;
    let end = buffer.indexOf("\n\n");
    while (end >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) on.data(data);
      end = buffer.indexOf("\n\n");
    }
  };

  xhr.onreadystatechange = () => {
    if (!xhr) return;
    if (xhr.readyState >= 2 && !opened && xhr.status === 200) {
      opened = true;
      on.open?.();
    }
    if (xhr.readyState === 3 || xhr.readyState === 4) read();
    if (xhr.readyState === 4) {
      const status = xhr.status;
      xhr = null;
      on.end(status);
    }
  };
  // Set before send: with it, React Native streams the response instead of waiting for its end.
  xhr.onprogress = read;
  xhr.send();

  return () => {
    const x = xhr;
    xhr = null;
    x?.abort();
  };
}
