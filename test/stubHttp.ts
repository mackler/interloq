// A stub of Effect's HTTP client (issue #120, part 1): answers each request from a handler and records what was sent,
// so the tracker adapters are tested without a network, as the agents' adapters are over test/fakeSdk.ts.
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

/** A request as the stub saw it: the method, the whole URL with its parameters, the headers and the body's text. */
export type SentRequest = Readonly<{ method: string; url: URL; headers: Readonly<Record<string, string>>; body: string | null }>;
/**
 * The answer to a request: a web Response; a transport failure (no answer at all); or a failure of the client after an
 * answer, its body undecodable ("decode") or empty ("emptyBody"), as a client may report it (W1-R1-2).
 */
export type Answer = Response | "transport" | "decode" | "emptyBody";
/** `filtered`: the client wrapped by HttpClient.filterStatusOk, which fails a non-2xx answer with a StatusCodeError. */
export type StubOptions = Readonly<{ filtered: boolean }>;

export type Stub = Readonly<{ layer: Layer.Layer<HttpClient.HttpClient>; sent: () => readonly SentRequest[] }>;

export const json = (value: unknown, status = 200, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });

export const makeStub = (handler: (request: SentRequest) => Answer, options: StubOptions = { filtered: false }): Stub => {
  const sent: SentRequest[] = [];
  const client = HttpClient.make((request, url) => {
    const body = request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : null;
    const seen: SentRequest = { method: request.method, url, headers: { ...request.headers }, body };
    sent.push(seen);
    const answer = handler(seen);
    if (answer === "transport") return Effect.fail(new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request, description: "connection reset" }) }));
    if (answer === "decode") return Effect.fail(new HttpClientError.HttpClientError({ reason: new HttpClientError.DecodeError({ request, response: HttpClientResponse.fromWeb(request, new Response("<html>")), description: "not JSON" }) }));
    if (answer === "emptyBody") return Effect.fail(new HttpClientError.HttpClientError({ reason: new HttpClientError.EmptyBodyError({ request, response: HttpClientResponse.fromWeb(request, new Response(null)), description: "empty body" }) }));
    return Effect.succeed(HttpClientResponse.fromWeb(request, answer));
  });
  return { layer: Layer.succeed(HttpClient.HttpClient, options.filtered ? HttpClient.filterStatusOk(client) : client), sent: () => [...sent] };
};
