# Changelog

All notable changes to `expo-ssdp` will be documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/). Versioning: [Semantic Versioning](https://semver.org/).

---

## [0.0.1] — 2026-05-27

### Added
- **Streaming search (`searchStream`)**: Real-time `AsyncGenerator` yielding devices as they arrive.
- **Passive listener (`listenForNotifications`)**: Unsolicited packet tracking (`ssdp:alive`, `ssdp:byebye`, `ssdp:update`).
- **Unicast Target list (`unicastTargets`)**: Directly target specific hosts to bypass multicast-blocking networks.
- Full TypeScript verification and clean bundling.

### Fixed
- **iOS NOTIFY socket setup**: Resolved memory leak where Success Tasks never resumed their checked continuation.
- **iOS activeSearchers thread safety**: Protected concurrent Swift Dictionary mutations via a dedicated serial dispatch queue to prevent crashes.
- **Multi-listener support**: Both Android and iOS now support multiple simultaneous notify subscriptions without silently killing previous ones.
- **Instant search cancellation**: Android search and notification sockets close immediately on cancel, dropping latency from up to 1s to instant.
- **Robust parse of max-age**: Swift NOTIFY listener parses `max-age` with highly accurate regular expressions matching spaces.
- **Fast Refresh ID safety**: Replaced module-level sequence counter with random-prefix IDs in JS to avoid collisions during dev reloads.
- **Entitlement docs**: Documented critical local network usage description and multicast entitlements for physical iOS 14+ devices.

