# Changelog

All notable changes to `expo-ssdp` will be documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [0.0.2] — 2026-05-27

### Added
- Added `multicastEnabled` and `broadcastEnabled` options to `SearchOptions` (default `true`). Setting these to `false` allows physical iOS devices to safely bypass Apple's strict Multicast Entitlement socket blocks by relying purely on `unicastTargets` fallback.
- Added comprehensive unit testing suite with Jest (TypeScript API) and JUnit (Android utilities).
- Added `exports` field to `package.json` for better modern bundler compatibility.

### Changed
- Fixed NPM package bloating by explicitly including only `android/src` and `android/build.gradle` in `package.json`, preventing 1.8MB of cached native binaries from being published.

### Fixed
- **Native Stability:** Fixed thread-safety data races in iOS streaming and `stop()` logic. Fixed Android resource leaks by moving socket `leaveGroup` calls to coroutine `finally` blocks.
- **Performance:** Reused regex compilation for `max-age` parsing on both iOS (`NSRegularExpression`) and Android (`Regex`), heavily reducing overhead per `NOTIFY` packet.
- **API Correctness:** Ensure iOS `onSsdpSearchComplete` arrives strictly after all devices. Corrected validation for the `mx` argument to not warn on exact boundaries. Handled iOS network socket drops correctly by emitting `onSsdpNotifyError`.
- **Application Logic:** Prevented async generator resource leaks by demonstrating and fixing the `stream.return(undefined)` abort behavior in the example app and documentation.
- **Documentation:** Fixed README.md link paths, added missing `unicastTargets` to table, and corrected cross-platform notes regarding Android interface binding.

---

## [0.0.1] — 2026-05-27

### Added
- Initial release.
- `search(options?)` — batch M-SEARCH returning `SsdpDevice[]` after full timeout.
- `searchStream(options?)` — streaming `AsyncGenerator` yielding devices as they arrive.
- `listenForNotifications(callbacks)` — passive SSDP NOTIFY listener with `ssdp:alive`, `ssdp:byebye`, and `ssdp:update` callbacks.
- `getNetworkInterfaces()` — returns active IPv4 interface names for debugging.
- `isAvailable` — boolean indicating whether the native module loaded.
- `SearchTargets` constants: `ALL`, `ROOT_DEVICE`, `MEDIA_RENDERER`, `MEDIA_SERVER`, `DIAL`, `SAMSUNG_TV`, `SAMSUNG_REMOTE`, `ROKU`, `SONOS`, `HUE_BRIDGE`, `INTERNET_GATEWAY`.
- `unicastTargets` option for direct unicast M-SEARCH probes.
- `repeatProbe` option to send a second probe burst at the halfway point.
- iOS: `CocoaAsyncSocket`-backed UDP socket with multicast group join on every active interface.
- Android: `MulticastSocket` with `MulticastLock` acquisition for reliable Wi-Fi multicast.
- Full TypeScript types and JSDoc for every public symbol.
- Expo New Architecture (Turbo Module / JSI) compatible via Expo Modules Core.
