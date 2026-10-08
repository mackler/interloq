// A stub of Effect's HTTP client (issue #120, part 1): answers each request from a handler and records what was sent,
// so the tracker adapters are tested without a network, as the agents' adapters are over test/fakeSdk.ts.
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

/** A request as the stub saw it: the method, the whole URL with its parameters, the headers and the body's text. */
export type SentRequest = Readonly<{ method: string; url: URL; headers: Readonly<Record<string, string>>; body: string | null }>;
/** The answer to a request: a web Response, or a transport failure (no answer at all). */
export type Answer = Response | "transport";

export type Stub = Readonly<{ layer: Layer.Layer<HttpClient.HttpClient>; sent: () => readonly SentRequest[] }>;

export const json = (value: unknown, status = 200, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });

export const makeStub = (handler: (request: SentRequest) => Answer): Stub => {
  const sent: SentRequest[] = [];
  const client = HttpClient.make((request, url) => {
    const body = request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : null;
    const seen: SentRequest = { method: request.method, url, headers: { ...request.headers }, body };
    sent.push(seen);
    const answer = handler(seen);
    return answer === "transport"
      ? Effect.fail(new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request, description: "connection reset" }) }))
      : Effect.succeed(HttpClientResponse.fromWeb(request, answer));
  });
  return { layer: Layer.succeed(HttpClient.HttpClient, client), sent: () => [...sent] };
};
