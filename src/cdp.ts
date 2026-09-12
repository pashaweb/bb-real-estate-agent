// Drives a real Chrome over the DevTools Protocol.
//
// Idealista answers plain HTTP fetches with 403 (DataDome), so listings are read
// through an actual browser instead. Chrome is launched once with its own
// profile directory, so any challenge you solve is remembered for later runs.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface BrowserRuntime {
  /** DevTools port to attach to, or launch Chrome on. */
  port: number;
  /** Chrome profile directory. Keeps the bot-challenge cookie between runs. */
  profileDir: string;
  /** Explicit Chrome binary; falls back to the usual install locations. */
  chromeBin: string | null;
}

let runtime: BrowserRuntime = {
  port: 9222,
  profileDir: join(homedir(), '.bb-real-estate-agent', 'chrome-profile'),
  chromeBin: null,
};

/** The server owns the settings, so it configures the browser before any fetch. */
export function configureBrowser(next: Partial<BrowserRuntime>): void {
  runtime = { ...runtime, ...next };
}

const chromeCandidates = (): string[] =>
  [
    runtime.chromeBin,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ].filter((p): p is string => Boolean(p));

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function version(timeoutMs = 1500): Promise<any> {
  try {
    const res = await fetch(`http://127.0.0.1:${runtime.port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export async function chromeStatus() {
  const v = await version();
  return v
    ? { running: true, browser: v.Browser, port: runtime.port }
    : { running: false, port: runtime.port };
}

/** Attaches to a Chrome already listening on the debug port, or launches one. */
export async function ensureChrome({ headless = false }: { headless?: boolean } = {}): Promise<any> {
  const existing = await version();
  if (existing) return existing;

  const bin = chromeCandidates().find((p) => existsSync(p));
  if (!bin)
    throw new Error(
      `No Chrome found. Tried:\n  ${chromeCandidates().join('\n  ')}\nSet the "Chrome binary" plugin setting to override.`
    );

  mkdirSync(runtime.profileDir, { recursive: true });
  const args = [
    `--remote-debugging-port=${runtime.port}`,
    `--user-data-dir=${runtime.profileDir}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1280,900',
    ...(headless ? ['--headless=new'] : []),
    'about:blank',
  ];
  spawn(bin, args, { detached: true, stdio: 'ignore' }).unref();

  for (let i = 0; i < 60; i++) {
    await delay(500);
    const v = await version();
    if (v) return v;
  }
  throw new Error(
    `Chrome did not open a debug port on ${runtime.port} within 30s.`
  );
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: { message: string };
  sessionId?: string;
}

type Pending = {
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
};

class Cdp {
  private readonly ws: WebSocket;
  private id = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(msg: CdpMessage) => void>();

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (ev: MessageEvent) => {
      const msg: CdpMessage = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const entry = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) {
          entry.reject(new Error(`${msg.error.message} (${msg.method ?? ''})`));
        } else {
          entry.resolve(msg.result);
        }
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg);
      }
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener(
        'error',
        () => reject(new Error(`Cannot open DevTools socket ${url}`)),
        { once: true }
      );
    });
    return new Cdp(ws);
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = ++this.id;
    const payload = JSON.stringify({
      id,
      method,
      params,
      ...(sessionId ? { sessionId } : {}),
    });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(payload);
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, 45_000);
    });
  }

  once(
    method: string,
    predicate: (msg: CdpMessage) => boolean = () => true,
    timeoutMs = 30_000
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const fn = (msg: CdpMessage) => {
        if (msg.method === method && predicate(msg)) {
          this.listeners.delete(fn);
          clearTimeout(timer);
          resolve(msg.params);
        }
      };
      const timer = setTimeout(() => {
        this.listeners.delete(fn);
        reject(new Error(`CDP wait timeout: ${method}`));
      }, timeoutMs);
      this.listeners.add(fn);
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}

const EXTRACT = `(() => {
  const pick = (sel) => document.querySelector(sel)?.textContent?.trim() ?? null;
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    text: document.body ? document.body.innerText : '',
    structured: {
      title: pick('.main-info__title-main'),
      subtitle: pick('.main-info__title-minor'),
      price: pick('.info-data-price'),
      features: Array.from(document.querySelectorAll('.details-property li, .info-features span'))
        .map((n) => n.textContent.trim()).filter(Boolean).slice(0, 60),
      description: pick('.comment .adCommentsLanguage') ?? pick('.comment'),
    },
  };
})()`;

const BLOCK_HINTS = [
  'datadome',
  'captcha',
  'just a moment',
  'verificando',
  'acceso denegado',
  'geo.captcha',
  'unusual traffic',
  'verify you are human',
];

/**
 * Opens `url` in Chrome and returns the rendered page text.
 * On a bot challenge the tab is deliberately left open so it can be solved by hand.
 */
export async function fetchPage(
  url: string,
  { settleMs = 1200, maxWaitMs = 25_000 } = {}
) {
  const v = await ensureChrome();
  const cdp = await Cdp.connect(v.webSocketDebuggerUrl);
  let targetId: string | null = null;
  try {
    ({ targetId } = await cdp.send('Target.createTarget', {
      url: 'about:blank',
    }));
    const { sessionId } = await cdp.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);

    const loaded = cdp
      .once('Page.loadEventFired', (m) => m.sessionId === sessionId, maxWaitMs)
      .catch(() => null);
    await cdp.send('Page.navigate', { url }, sessionId);
    await loaded;

    let page: any = null;
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      await delay(settleMs);
      const { result } = await cdp.send(
        'Runtime.evaluate',
        { expression: EXTRACT, returnByValue: true, awaitPromise: true },
        sessionId
      );
      page = result.value;
      if (
        page?.readyState === 'complete' &&
        (page.text ?? '').length > 800 &&
        page.text.includes('€')
      )
        break;
    }
    if (!page) throw new Error('Chrome returned no page content.');

    const haystack = `${page.title} ${page.text.slice(0, 4000)}`.toLowerCase();
    const blocked =
      BLOCK_HINTS.some((h) => haystack.includes(h)) || page.text.length < 400;
    if (blocked) {
      return {
        blocked: true,
        url: page.url,
        title: page.title,
        text: page.text,
        message:
          'Idealista served a bot challenge. The tab is open in Chrome — solve it there, then press Add again. The profile keeps the cookie, so it is usually a one-off.',
      };
    }

    await cdp.send('Target.closeTarget', { targetId });
    targetId = null;
    return {
      blocked: false,
      url: page.url,
      title: page.title,
      text: page.text,
      structured: page.structured,
    };
  } catch (err) {
    if (targetId)
      await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    throw err;
  } finally {
    cdp.close();
  }
}
