// The browser APIs that jsdom lacks and that m3-svelte reads, for the component tests only (Vitest's setupFiles).
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string): MediaQueryList =>
    ({ matches: false, media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false }) as MediaQueryList;
}
// jsdom has <dialog> without the modal methods that m3-svelte's Dialog calls.
if (typeof HTMLDialogElement !== "undefined" && typeof HTMLDialogElement.prototype.showModal !== "function") {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  };
}
// Issue #16: jsdom has no Notification. This stub records what the page shows and asks, and logs nothing; the tests
// set its permission and its answer to a request, and reset it after each test.
export type NotificationCall = { title: string; options: NotificationOptions | undefined; closed: boolean };
export class NotificationStub {
  static calls: NotificationCall[] = [];
  static requests = 0;
  static permission: NotificationPermission = "default";
  static nextAnswer: NotificationPermission = "granted";
  onclick: ((this: NotificationStub, event: Event) => unknown) | null = null;
  readonly #call: NotificationCall;
  constructor(title: string, options?: NotificationOptions) {
    this.#call = { title, options, closed: false };
    NotificationStub.calls.push(this.#call);
  }
  close(): void {
    this.#call.closed = true;
  }
  static requestPermission(): Promise<NotificationPermission> {
    NotificationStub.requests += 1;
    NotificationStub.permission = NotificationStub.nextAnswer;
    return Promise.resolve(NotificationStub.permission);
  }
  static reset(): void {
    NotificationStub.calls = [];
    NotificationStub.requests = 0;
    NotificationStub.permission = "default";
    NotificationStub.nextAnswer = "granted";
  }
}
if (typeof (window as { Notification?: unknown }).Notification === "undefined") {
  Object.defineProperty(window, "Notification", { configurable: true, writable: true, value: NotificationStub });
}
// W2-R1-1: jsdom has no AudioContext. This silent stub counts the contexts built and the tones started.
export class AudioContextStub {
  static constructed = 0;
  static started = 0;
  readonly currentTime = 0;
  readonly destination = {};
  constructor() {
    AudioContextStub.constructed += 1;
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
  createOscillator() {
    return {
      frequency: { value: 0 },
      connect: <T>(node: T): T => node,
      start: () => {
        AudioContextStub.started += 1;
      },
      stop: () => undefined,
    };
  }
  createGain() {
    return { gain: { setValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined }, connect: <T>(node: T): T => node };
  }
  static reset(): void {
    AudioContextStub.constructed = 0;
    AudioContextStub.started = 0;
  }
}
if (typeof (window as { AudioContext?: unknown }).AudioContext === "undefined") {
  Object.defineProperty(window, "AudioContext", { configurable: true, writable: true, value: AudioContextStub });
}
