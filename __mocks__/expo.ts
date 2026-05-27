/**
 * Manual Jest mock for the 'expo' package.
 *
 * src/index.ts initialises NativeSsdp and emitter at module load time, so
 * this mock must be in place before that module is first required. With
 * resetModules: true in jest.config.js every test gets a fresh instance.
 *
 * Usage in tests:
 *   const expo = require('expo') as typeof import('../__mocks__/expo');
 *   const api  = require('../src/index') as typeof import('../src/index');
 *   // api load triggered new EventEmitter(NativeSsdp) → lastEmitter is set
 *   expo.lastEmitter!.emit('onSsdpDeviceFound', { searchId: '…', device: … });
 */

// ── NativeModule stub ────────────────────────────────────────────────────────
export class NativeModule {}

// ── EventEmitter mock ────────────────────────────────────────────────────────

class MockEmitter {
  private listeners = new Map<string, Array<(d: unknown) => void>>();

  addListener(event: string, cb: (d: unknown) => void) {
    const list = this.listeners.get(event) ?? [];
    list.push(cb);
    this.listeners.set(event, list);
    return {
      remove: () => {
        const arr = this.listeners.get(event);
        if (arr) {
          const i = arr.indexOf(cb);
          if (i !== -1) arr.splice(i, 1);
        }
      },
    };
  }

  /** Fire an event into any registered listeners — called from tests. */
  emit(event: string, data: unknown) {
    this.listeners.get(event)?.forEach((cb) => cb(data));
  }
}

/** The EventEmitter instance created by src/index.ts — set after require('../src/index'). */
export let lastEmitter: MockEmitter | null = null;

export const EventEmitter = jest.fn().mockImplementation((_native: unknown) => {
  lastEmitter = new MockEmitter();
  return lastEmitter;
});

// ── Mock native module ───────────────────────────────────────────────────────

/** Preconfigured mock for NativeSsdp — override per-test as needed. */
export const mockNative = {
  search: jest.fn().mockResolvedValue([]),
  startSearch: jest.fn(),
  stopSearch: jest.fn(),
  startNotifyListener: jest.fn(),
  stopNotifyListener: jest.fn(),
  getNetworkInterfaces: jest.fn().mockResolvedValue(['en0']),
};

export const requireNativeModule = jest.fn().mockReturnValue(mockNative);
