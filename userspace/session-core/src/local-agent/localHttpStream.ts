import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';

/** Long-lived local service streams are bounded by cancellation, not fetch's body idle timer. */
export function postLocalStream(
  url: string,
  headers: Record<string, string>,
  body: string,
  signal: AbortSignal,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = target.protocol === 'http:' ? httpRequest
      : target.protocol === 'https:' ? httpsRequest : null;
    if (!request) throw new Error(`local_stream_protocol_invalid:${target.protocol}`);
    const outgoing = request(target, {
      method: 'POST', headers, signal, agent: false, timeout: 0,
    }, (incoming) => {
      try {
        const responseHeaders = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          responseHeaders.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
        }
        resolve(new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, {
          status: incoming.statusCode,
          statusText: incoming.statusMessage,
          headers: responseHeaders,
        }));
      } catch (error) {
        incoming.destroy();
        outgoing.destroy();
        reject(error);
      }
    });
    outgoing.once('error', reject);
    outgoing.end(body);
  });
}
