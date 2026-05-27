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
export declare class NativeModule {
}
declare class MockEmitter {
    private listeners;
    addListener(event: string, cb: (d: unknown) => void): {
        remove: () => void;
    };
    /** Fire an event into any registered listeners — called from tests. */
    emit(event: string, data: unknown): void;
}
/** The EventEmitter instance created by src/index.ts — set after require('../src/index'). */
export declare let lastEmitter: MockEmitter | null;
export declare const EventEmitter: jest.Mock<any, any, any>;
/** Preconfigured mock for NativeSsdp — override per-test as needed. */
export declare const mockNative: {
    search: jest.Mock<any, any, any>;
    startSearch: jest.Mock<any, any, any>;
    stopSearch: jest.Mock<any, any, any>;
    startNotifyListener: jest.Mock<any, any, any>;
    stopNotifyListener: jest.Mock<any, any, any>;
    getNetworkInterfaces: jest.Mock<any, any, any>;
};
export declare const requireNativeModule: jest.Mock<any, any, any>;
export {};
