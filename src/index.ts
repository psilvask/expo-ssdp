import { NativeModule, requireNativeModule, EventEmitter } from "expo";

type Subscription = { remove: () => void };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single SSDP device/service discovered via M-SEARCH.
 *
 * When using `"ssdp:all"` as a search target, a single physical device may
 * produce **multiple** `SsdpDevice` entries — one per UPnP service it
 * advertises. Use the `usn` field to group entries belonging to the same
 * physical device (the UUID prefix before `::` is the device identifier).
 */
export type SsdpDevice = {
  /** The IPv4 address of the responding device. */
  address: string;
  /**
   * All HTTP-like headers from the SSDP response, stored twice — once with
   * their original casing and once uppercased — for convenient lookup.
   */
  headers: Record<string, string>;
  /** The LOCATION header — typically a URL to the device's UPnP description XML. */
  location?: string;
  /** The USN (Unique Service Name) — uniquely identifies the device or service. */
  usn?: string;
  /** The ST header from the response — indicates the device/service type. */
  st?: string;
  /** The SERVER header — often contains OS and firmware info. */
  server?: string;
  /** The raw, unparsed SSDP response string. */
  raw: string;
};

/** Options for {@link search} and {@link searchStream}. */
export type SearchOptions = {
  /**
   * List of SSDP Search Target (ST) values. Each entry generates a separate
   * M-SEARCH probe. Defaults to `["ssdp:all"]`.
   */
  searchTargets?: string[];
  /**
   * Total scan duration in milliseconds. Must be greater than `mx * 1000`.
   * @default 5000
   */
  timeoutMs?: number;
  /**
   * MX (Maximum Wait) header in seconds. Should be less than `timeoutMs / 1000`.
   * @default 3
   */
  mx?: number;
  /**
   * When `true`, a second probe burst is sent halfway through the timeout window.
   * @default true
   */
  repeatProbe?: boolean;
  /**
   * Optional list of device IPv4 addresses to send **unicast** M-SEARCH packets
   * to in addition to the standard multicast/broadcast probes. Useful for
   * re-querying a known device or for networks that block multicast.
   */
  unicastTargets?: string[];
  /**
   * Whether to send probes to the UPnP multicast address (`239.255.255.250`).
   * On iOS 14+, this requires the `com.apple.developer.networking.multicast`
   * entitlement, otherwise the socket will crash. Set to `false` to disable.
   * @default true
   */
  multicastEnabled?: boolean;
  /**
   * Whether to send probes to the global broadcast address (`255.255.255.255`).
   * This is a fallback for routers that block multicast.
   * @default true
   */
  broadcastEnabled?: boolean;
};

// ---------------------------------------------------------------------------
// NOTIFY / Passive listener types
// ---------------------------------------------------------------------------

/**
 * An unsolicited SSDP NOTIFY event sent by a device on the network.
 * Received via {@link listenForNotifications}.
 */
export type SsdpNotifyEvent = {
  /** `"ssdp:alive"` — device appeared or refreshed its presence. */
  nts: "ssdp:alive" | "ssdp:byebye" | "ssdp:update";
  /** The device's IPv4 address. */
  address: string;
  /** The USN (Unique Service Name) from the NOTIFY packet. */
  usn?: string;
  /** The NT (Notification Type) — the service/device type. */
  nt?: string;
  /** The LOCATION header (present in `ssdp:alive` and `ssdp:update`). */
  location?: string;
  /**
   * Maximum age in seconds before the announcement expires.
   * Parsed from the `CACHE-CONTROL: max-age=<n>` header.
   * Present in `ssdp:alive` and `ssdp:update`.
   */
  maxAge?: number;
  /** All raw headers from the NOTIFY packet. */
  headers: Record<string, string>;
};

// ---------------------------------------------------------------------------
// Well-known Search Targets
// ---------------------------------------------------------------------------

export const SearchTargets = {
  ALL: "ssdp:all",
  ROOT_DEVICE: "upnp:rootdevice",
  MEDIA_RENDERER: "urn:schemas-upnp-org:device:MediaRenderer:1",
  MEDIA_SERVER: "urn:schemas-upnp-org:device:MediaServer:1",
  DIAL: "urn:dial-multiscreen-org:service:dial:1",
  SAMSUNG_TV: "urn:samsung.com:service:MultiScreenService:1",
  SAMSUNG_REMOTE: "urn:samsung.com:device:RemoteControlReceiver:1",
  ROKU: "urn:roku-com:service:ecp:1",
  SONOS: "urn:schemas-upnp-org:device:ZonePlayer:1",
  /**
   * Philips Hue bridges advertise as a generic UPnP "Basic" device —
   * this ST matches **any** device using the Basic type. Filter results by
   * checking `device.server` contains `"IpBridge"` to identify Hue bridges.
   */
  HUE_BRIDGE: "urn:schemas-upnp-org:device:Basic:1",
  INTERNET_GATEWAY: "urn:schemas-upnp-org:device:InternetGatewayDevice:1",
} as const;

export type SearchTarget = (typeof SearchTargets)[keyof typeof SearchTargets];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link search}, {@link searchStream}, and {@link getNetworkInterfaces}
 * when the native SSDP module is not available.
 */
export class SsdpUnavailableError extends Error {
  constructor() {
    super(
      "[expo-ssdp] Native module is not available. " +
        "Ensure you are running on a physical device or simulator with the native module installed."
    );
    this.name = "SsdpUnavailableError";
  }
}

// ---------------------------------------------------------------------------
// Native Module Binding
// ---------------------------------------------------------------------------

type ExpoSsdpModuleType = InstanceType<typeof NativeModule> & {
  // Batch API
  search(options: {
    searchTargets: string[];
    timeoutMs: number;
    mx: number;
    repeatProbe: boolean;
    unicastTargets: string[];
    multicastEnabled: boolean;
    broadcastEnabled: boolean;
  }): Promise<SsdpDevice[]>;

  // Streaming API
  startSearch(searchId: string, options: {
    searchTargets: string[];
    timeoutMs: number;
    mx: number;
    repeatProbe: boolean;
    unicastTargets: string[];
    multicastEnabled: boolean;
    broadcastEnabled: boolean;
  }): void;
  stopSearch(searchId: string): void;

  // Passive NOTIFY listener
  startNotifyListener(listenerId: string): void;
  stopNotifyListener(listenerId: string): void;

  // Utility
  getNetworkInterfaces(): Promise<string[]>;
};

let NativeSsdp: ExpoSsdpModuleType | null = null;

try {
  NativeSsdp = requireNativeModule<ExpoSsdpModuleType>("ExpoSsdp");
} catch {
  NativeSsdp = null;
}

const emitter = NativeSsdp ? new EventEmitter<Record<string, any>>(NativeSsdp) : null;

/** Whether the native SSDP module is available on the current platform. */
export const isAvailable = NativeSsdp != null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateId(): string {
  const randomStr = Math.random().toString(36).substring(2, 9);
  return `ssdp-${Date.now()}-${randomStr}`;
}

function normalizeOptions(options: SearchOptions) {
  const mx = options.mx ?? 3;
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (mx * 1000 > timeoutMs) {
    console.warn(
      `[expo-ssdp] mx (${mx}s) >= timeoutMs (${timeoutMs}ms). ` +
        "Devices that wait longer than timeoutMs will be missed."
    );
  }
  const searchTargets = options.searchTargets ?? ["ssdp:all"];
  if (searchTargets.length === 0) {
    console.warn(
      "[expo-ssdp] searchTargets is empty — no M-SEARCH probes will be sent. " +
        'Pass at least one target, or omit the option to default to ["ssdp:all"].'
    );
  }
  return {
    searchTargets,
    timeoutMs,
    mx,
    repeatProbe: options.repeatProbe ?? true,
    unicastTargets: options.unicastTargets ?? [],
    multicastEnabled: options.multicastEnabled ?? true,
    broadcastEnabled: options.broadcastEnabled ?? true,
  };
}

// ---------------------------------------------------------------------------
// Public API — Batch search
// ---------------------------------------------------------------------------

/**
 * Performs an active SSDP M-SEARCH and returns a list of all devices
 * discovered within `timeoutMs`. The promise resolves only after the full
 * timeout elapses.
 *
 * For a UI that updates progressively as devices arrive, use
 * {@link searchStream} instead.
 *
 * @throws {SsdpUnavailableError} If the native module is not installed.
 */
export async function search(options: SearchOptions = {}): Promise<SsdpDevice[]> {
  if (!NativeSsdp) throw new SsdpUnavailableError();
  return NativeSsdp.search(normalizeOptions(options));
}

// ---------------------------------------------------------------------------
// Public API — Streaming search (P1)
// ---------------------------------------------------------------------------

/**
 * Performs an active SSDP M-SEARCH and **yields devices as they arrive**,
 * rather than waiting for the full timeout. Ideal for building a live device
 * list in a UI.
 *
 * @throws {SsdpUnavailableError} If the native module is not installed.
 *
 * @example
 * for await (const device of searchStream({ timeoutMs: 8000 })) {
 *   setDevices(prev => [...prev, device]);
 * }
 */
export async function* searchStream(
  options: SearchOptions = {}
): AsyncGenerator<SsdpDevice, void, undefined> {
  if (!NativeSsdp || !emitter) throw new SsdpUnavailableError();

  const searchId = generateId();
  const normalized = normalizeOptions(options);

  const queue: SsdpDevice[] = [];
  let done = false;
  let searchError: Error | null = null;
  let wakeUp: (() => void) | null = null;

  const signal = () => {
    const fn = wakeUp;
    wakeUp = null;
    fn?.();
  };

  const subs: Subscription[] = [
    emitter.addListener("onSsdpDeviceFound", (e: { searchId: string; device: SsdpDevice }) => {
      if (e.searchId !== searchId) return;
      queue.push(e.device);
      signal();
    }),
    emitter.addListener("onSsdpSearchComplete", (e: { searchId: string }) => {
      if (e.searchId !== searchId) return;
      done = true;
      signal();
    }),
    emitter.addListener("onSsdpSearchError", (e: { searchId: string; error: string }) => {
      if (e.searchId !== searchId) return;
      searchError = new Error(e.error);
      done = true;
      signal();
    }),
  ];

  const cleanup = () => {
    subs.forEach((s) => s.remove());
    NativeSsdp?.stopSearch(searchId);
  };

  try {
    NativeSsdp.startSearch(searchId, normalized);

    while (true) {
      // Drain any queued devices
      while (queue.length > 0) yield queue.shift()!;
      if (done) break;
      // Wait for the next event
      await new Promise<void>((resolve) => {
        wakeUp = resolve;
      });
      if (searchError) throw searchError;
    }
    // Drain remaining devices after completion
    while (queue.length > 0) yield queue.shift()!;
  } finally {
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// Public API — Passive NOTIFY listener (P2)
// ---------------------------------------------------------------------------

/**
 * Opens a persistent socket that listens for unsolicited SSDP `NOTIFY`
 * packets sent by devices on the local network.
 *
 * Devices broadcast `ssdp:alive` when they join or refresh their presence,
 * and `ssdp:byebye` when they leave. This allows maintaining a live,
 * accurate device list without polling.
 *
 * @returns A subscription object with a `remove()` method to stop listening.
 *
 * @throws {SsdpUnavailableError} If the native module is not installed.
 *
 * @example
 * const sub = listenForNotifications({
 *   onAlive: (event) => console.log('Device online:', event.usn),
 *   onByeBye: (event) => console.log('Device offline:', event.usn),
 * });
 * // Later:
 * sub.remove();
 */
export function listenForNotifications(callbacks: {
  onAlive?: (event: SsdpNotifyEvent) => void;
  onByeBye?: (event: SsdpNotifyEvent) => void;
  onUpdate?: (event: SsdpNotifyEvent) => void;
  onError?: (error: Error) => void;
}): { remove: () => void } {
  if (!NativeSsdp || !emitter) throw new SsdpUnavailableError();

  const listenerId = generateId();

  const subs: Subscription[] = [
    emitter.addListener(
      "onSsdpNotify",
      (event: SsdpNotifyEvent & { listenerId: string }) => {
        if (event.listenerId !== listenerId) return;
        if (event.nts === "ssdp:alive") callbacks.onAlive?.(event);
        else if (event.nts === "ssdp:byebye") callbacks.onByeBye?.(event);
        else if (event.nts === "ssdp:update") callbacks.onUpdate?.(event);
      }
    ),
    emitter.addListener(
      "onSsdpNotifyError",
      (event: { listenerId: string; error: string }) => {
        if (event.listenerId !== listenerId) return;
        callbacks.onError?.(new Error(event.error));
      }
    ),
  ];

  NativeSsdp.startNotifyListener(listenerId);

  return {
    remove: () => {
      subs.forEach((s) => s.remove());
      NativeSsdp?.stopNotifyListener(listenerId);
    },
  };
}

// ---------------------------------------------------------------------------
// Public API — Utilities
// ---------------------------------------------------------------------------

/**
 * Returns a list of active IPv4 network interface names on the device.
 * Useful for debugging multicast binding issues.
 *
 * @throws {SsdpUnavailableError} If the native module is not installed.
 */
export async function getNetworkInterfaces(): Promise<string[]> {
  if (!NativeSsdp) throw new SsdpUnavailableError();
  return NativeSsdp.getNetworkInterfaces();
}
