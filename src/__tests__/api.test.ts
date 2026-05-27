/**
 * Unit tests for the expo-ssdp public TypeScript API.
 *
 * Each test uses a fresh module instance (resetModules: true in jest.config.js)
 * so module-level singletons (NativeSsdp, emitter) are re-initialised from the
 * mock on every `require('../index')` call.
 *
 * The 'expo' import is redirected to __mocks__/expo.ts via moduleNameMapper.
 */

// Type-only imports so we can cast dynamic require() results.
import type * as ExpoMock from '../../__mocks__/expo';
import type * as Api from '../index';

// Tell Jest to use __mocks__/expo.ts for every require('expo') in this file.
jest.mock('expo');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Load a fresh copy of expo mock + the ssdp module. */
function loadModules() {
  // jest.config.js has resetModules: true, so the registry is already clean.
  const expo = require('expo') as typeof ExpoMock;
  // Requiring the index triggers: requireNativeModule → mockNative, new EventEmitter → lastEmitter set.
  const api = require('../index') as typeof Api;
  return { expo, api };
}

const mockDevice: Api.SsdpDevice = {
  address: '192.168.1.42',
  headers: { location: 'http://192.168.1.42/desc.xml', usn: 'uuid:abc' },
  location: 'http://192.168.1.42/desc.xml',
  usn: 'uuid:abc::upnp:rootdevice',
  st: 'upnp:rootdevice',
  server: 'Linux UPnP/1.1',
  raw: 'HTTP/1.1 200 OK\r\n...',
};

// ---------------------------------------------------------------------------
// isAvailable
// ---------------------------------------------------------------------------

describe('isAvailable', () => {
  it('is true when requireNativeModule succeeds', () => {
    const { api } = loadModules();
    expect(api.isAvailable).toBe(true);
  });

  it('is false when requireNativeModule throws', () => {
    const expo = require('expo') as typeof ExpoMock;
    expo.requireNativeModule.mockImplementation(() => { throw new Error('not found'); });
    const api = require('../index') as typeof Api;
    expect(api.isAvailable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SearchTargets
// ---------------------------------------------------------------------------

describe('SearchTargets', () => {
  it('exposes the correct well-known URNs', () => {
    const { api } = loadModules();
    expect(api.SearchTargets.ALL).toBe('ssdp:all');
    expect(api.SearchTargets.ROOT_DEVICE).toBe('upnp:rootdevice');
    expect(api.SearchTargets.DIAL).toBe('urn:dial-multiscreen-org:service:dial:1');
    expect(api.SearchTargets.ROKU).toBe('urn:roku-com:service:ecp:1');
    expect(api.SearchTargets.SONOS).toBe('urn:schemas-upnp-org:device:ZonePlayer:1');
    expect(api.SearchTargets.MEDIA_SERVER).toBe('urn:schemas-upnp-org:device:MediaServer:1');
    expect(api.SearchTargets.MEDIA_RENDERER).toBe('urn:schemas-upnp-org:device:MediaRenderer:1');
  });
});

// ---------------------------------------------------------------------------
// SsdpUnavailableError
// ---------------------------------------------------------------------------

describe('SsdpUnavailableError', () => {
  it('has name SsdpUnavailableError', () => {
    const { api } = loadModules();
    const err = new api.SsdpUnavailableError();
    expect(err.name).toBe('SsdpUnavailableError');
  });

  it('is an instance of Error', () => {
    const { api } = loadModules();
    expect(new api.SsdpUnavailableError()).toBeInstanceOf(Error);
  });

  it('message mentions the native module', () => {
    const { api } = loadModules();
    expect(new api.SsdpUnavailableError().message).toContain('expo-ssdp');
  });
});

// ---------------------------------------------------------------------------
// search()
// ---------------------------------------------------------------------------

describe('search()', () => {
  it('throws SsdpUnavailableError when native module is absent', async () => {
    const expo = require('expo') as typeof ExpoMock;
    expo.requireNativeModule.mockImplementation(() => { throw new Error(); });
    const { search, SsdpUnavailableError } = require('../index') as typeof Api;
    await expect(search()).rejects.toBeInstanceOf(SsdpUnavailableError);
  });

  it('delegates to native with normalised default options', async () => {
    const { expo, api } = loadModules();
    expo.mockNative.search.mockResolvedValue([]);
    await api.search();
    expect(expo.mockNative.search).toHaveBeenCalledWith({
      searchTargets: ['ssdp:all'],
      timeoutMs: 5000,
      mx: 3,
      repeatProbe: true,
      unicastTargets: [],
    });
  });

  it('passes through custom options', async () => {
    const { expo, api } = loadModules();
    expo.mockNative.search.mockResolvedValue([]);
    await api.search({ searchTargets: ['upnp:rootdevice'], timeoutMs: 8000, mx: 2, repeatProbe: false, unicastTargets: ['10.0.0.5'] });
    expect(expo.mockNative.search).toHaveBeenCalledWith({
      searchTargets: ['upnp:rootdevice'],
      timeoutMs: 8000,
      mx: 2,
      repeatProbe: false,
      unicastTargets: ['10.0.0.5'],
    });
  });

  it('returns the array resolved by native', async () => {
    const { expo, api } = loadModules();
    expo.mockNative.search.mockResolvedValue([mockDevice]);
    const result = await api.search();
    expect(result).toEqual([mockDevice]);
  });

  it('warns when mx > timeoutMs / 1000', async () => {
    const { expo, api } = loadModules();
    expo.mockNative.search.mockResolvedValue([]);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await api.search({ mx: 6, timeoutMs: 5000 }); // mx (6s) > timeoutMs (5000ms / 1000)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('expo-ssdp'));
    warn.mockRestore();
  });

  it('does NOT warn when mx <= timeoutMs / 1000', async () => {
    const { expo, api } = loadModules();
    expo.mockNative.search.mockResolvedValue([]);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await api.search({ mx: 5, timeoutMs: 5000 }); // exact match is technically valid
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('warns when searchTargets is an empty array', async () => {
    const { expo, api } = loadModules();
    expo.mockNative.search.mockResolvedValue([]);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await api.search({ searchTargets: [] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('expo-ssdp'));
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// searchStream()
// ---------------------------------------------------------------------------

describe('searchStream()', () => {
  it('throws SsdpUnavailableError when native module is absent', async () => {
    const expo = require('expo') as typeof ExpoMock;
    expo.requireNativeModule.mockImplementation(() => { throw new Error(); });
    const { searchStream, SsdpUnavailableError } = require('../index') as typeof Api;
    const gen = searchStream();
    await expect(gen.next()).rejects.toBeInstanceOf(SsdpUnavailableError);
  });

  it('calls startSearch with a generated ID and normalised options', async () => {
    const { expo, api } = loadModules();
    let capturedId = '';
    expo.mockNative.startSearch.mockImplementation((id: string) => {
      capturedId = id;
      // Immediately complete the search so the generator doesn't hang.
      setImmediate(() => expo.lastEmitter!.emit('onSsdpSearchComplete', { searchId: id }));
    });
    for await (const _ of api.searchStream()) { /* drain */ }
    expect(capturedId).toMatch(/^ssdp-\d+-\w+$/);
    expect(expo.mockNative.startSearch).toHaveBeenCalledWith(
      capturedId,
      expect.objectContaining({ searchTargets: ['ssdp:all'], mx: 3 }),
    );
  });

  it('yields devices as onSsdpDeviceFound events arrive', async () => {
    const { expo, api } = loadModules();
    expo.mockNative.startSearch.mockImplementation((id: string) => {
      setImmediate(() => {
        expo.lastEmitter!.emit('onSsdpDeviceFound', { searchId: id, device: mockDevice });
        expo.lastEmitter!.emit('onSsdpSearchComplete', { searchId: id });
      });
    });
    const results: Api.SsdpDevice[] = [];
    for await (const d of api.searchStream()) results.push(d);
    expect(results).toEqual([mockDevice]);
  });

  it('ignores events for a different searchId', async () => {
    const { expo, api } = loadModules();
    expo.mockNative.startSearch.mockImplementation((id: string) => {
      setImmediate(() => {
        expo.lastEmitter!.emit('onSsdpDeviceFound', { searchId: 'WRONG_ID', device: mockDevice });
        expo.lastEmitter!.emit('onSsdpSearchComplete', { searchId: id });
      });
    });
    const results: Api.SsdpDevice[] = [];
    for await (const d of api.searchStream()) results.push(d);
    expect(results).toHaveLength(0);
  });

  it('throws when onSsdpSearchError fires', async () => {
    const { expo, api } = loadModules();
    expo.mockNative.startSearch.mockImplementation((id: string) => {
      setImmediate(() => expo.lastEmitter!.emit('onSsdpSearchError', { searchId: id, error: 'socket bind failed' }));
    });
    await expect(async () => {
      for await (const _ of api.searchStream()) { /* drain */ }
    }).rejects.toThrow('socket bind failed');
  });

  it('calls stopSearch and removes listeners on completion', async () => {
    const { expo, api } = loadModules();
    let capturedId = '';
    expo.mockNative.startSearch.mockImplementation((id: string) => {
      capturedId = id;
      setImmediate(() => expo.lastEmitter!.emit('onSsdpSearchComplete', { searchId: id }));
    });
    for await (const _ of api.searchStream()) { /* drain */ }
    expect(expo.mockNative.stopSearch).toHaveBeenCalledWith(capturedId);
  });

  it('calls stopSearch when the for-await loop is exited early (break)', async () => {
    // Verifies the finally block / cleanup() path — the same path triggered by
    // stream.return() in the example app's AbortController abort listener.
    const { expo, api } = loadModules();
    let capturedId = '';
    expo.mockNative.startSearch.mockImplementation((id: string) => {
      capturedId = id;
      setImmediate(() => {
        expo.lastEmitter!.emit('onSsdpDeviceFound', { searchId: id, device: mockDevice });
        expo.lastEmitter!.emit('onSsdpDeviceFound', { searchId: id, device: { ...mockDevice, address: '10.0.0.2' } });
        expo.lastEmitter!.emit('onSsdpSearchComplete', { searchId: id });
      });
    });

    const results: Api.SsdpDevice[] = [];
    for await (const device of api.searchStream()) {
      results.push(device);
      break; // JS engine calls gen.return() → finally block → cleanup() → stopSearch()
    }

    expect(results).toHaveLength(1);
    expect(expo.mockNative.stopSearch).toHaveBeenCalledWith(capturedId);
  });
});

// ---------------------------------------------------------------------------
// listenForNotifications()
// ---------------------------------------------------------------------------

describe('listenForNotifications()', () => {
  it('throws SsdpUnavailableError when native module is absent', () => {
    const expo = require('expo') as typeof ExpoMock;
    expo.requireNativeModule.mockImplementation(() => { throw new Error(); });
    const { listenForNotifications, SsdpUnavailableError } = require('../index') as typeof Api;
    expect(() => listenForNotifications({})).toThrow(SsdpUnavailableError);
  });

  it('calls startNotifyListener with a generated ID', () => {
    const { expo, api } = loadModules();
    api.listenForNotifications({});
    expect(expo.mockNative.startNotifyListener).toHaveBeenCalledWith(expect.stringMatching(/^ssdp-\d+-\w+$/));
  });

  it('routes ssdp:alive events to onAlive callback', () => {
    const { expo, api } = loadModules();
    const onAlive = jest.fn();
    api.listenForNotifications({ onAlive });
    const [listenerId] = expo.mockNative.startNotifyListener.mock.calls[0] as [string];
    const event = { listenerId, nts: 'ssdp:alive' as const, address: '10.0.0.1', headers: {} };
    expo.lastEmitter!.emit('onSsdpNotify', event);
    expect(onAlive).toHaveBeenCalledWith(event);
  });

  it('routes ssdp:byebye events to onByeBye callback', () => {
    const { expo, api } = loadModules();
    const onByeBye = jest.fn();
    api.listenForNotifications({ onByeBye });
    const [listenerId] = expo.mockNative.startNotifyListener.mock.calls[0] as [string];
    const event = { listenerId, nts: 'ssdp:byebye' as const, address: '10.0.0.1', headers: {} };
    expo.lastEmitter!.emit('onSsdpNotify', event);
    expect(onByeBye).toHaveBeenCalledWith(event);
  });

  it('routes ssdp:update events to onUpdate callback', () => {
    const { expo, api } = loadModules();
    const onUpdate = jest.fn();
    api.listenForNotifications({ onUpdate });
    const [listenerId] = expo.mockNative.startNotifyListener.mock.calls[0] as [string];
    const event = { listenerId, nts: 'ssdp:update' as const, address: '10.0.0.1', headers: {} };
    expo.lastEmitter!.emit('onSsdpNotify', event);
    expect(onUpdate).toHaveBeenCalledWith(event);
  });

  it('ignores events with a different listenerId', () => {
    const { expo, api } = loadModules();
    const onAlive = jest.fn();
    api.listenForNotifications({ onAlive });
    const event = { listenerId: 'WRONG_ID', nts: 'ssdp:alive' as const, address: '10.0.0.1', headers: {} };
    expo.lastEmitter!.emit('onSsdpNotify', event);
    expect(onAlive).not.toHaveBeenCalled();
  });

  it('routes errors to onError callback', () => {
    const { expo, api } = loadModules();
    const onError = jest.fn();
    api.listenForNotifications({ onError });
    const [listenerId] = expo.mockNative.startNotifyListener.mock.calls[0] as [string];
    expo.lastEmitter!.emit('onSsdpNotifyError', { listenerId, error: 'port in use' });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'port in use' }));
  });

  it('remove() calls stopNotifyListener and removes event listeners', () => {
    const { expo, api } = loadModules();
    const onAlive = jest.fn();
    const sub = api.listenForNotifications({ onAlive });
    const [listenerId] = expo.mockNative.startNotifyListener.mock.calls[0] as [string];
    sub.remove();
    expect(expo.mockNative.stopNotifyListener).toHaveBeenCalledWith(listenerId);
    // After remove, events should no longer reach callbacks.
    expo.lastEmitter!.emit('onSsdpNotify', { listenerId, nts: 'ssdp:alive', address: '10.0.0.1', headers: {} });
    expect(onAlive).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getNetworkInterfaces()
// ---------------------------------------------------------------------------

describe('getNetworkInterfaces()', () => {
  it('throws SsdpUnavailableError when native module is absent', async () => {
    const expo = require('expo') as typeof ExpoMock;
    expo.requireNativeModule.mockImplementation(() => { throw new Error(); });
    const { getNetworkInterfaces, SsdpUnavailableError } = require('../index') as typeof Api;
    await expect(getNetworkInterfaces()).rejects.toBeInstanceOf(SsdpUnavailableError);
  });

  it('returns the array from the native module', async () => {
    const { expo, api } = loadModules();
    expo.mockNative.getNetworkInterfaces.mockResolvedValue(['en0', 'pdp_ip0']);
    const ifaces = await api.getNetworkInterfaces();
    expect(ifaces).toEqual(['en0', 'pdp_ip0']);
  });
});
