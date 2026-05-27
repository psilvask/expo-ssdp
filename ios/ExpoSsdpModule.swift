import ExpoModulesCore
import CocoaAsyncSocket
import Network
import os

private let libraryVersion = "0.0.3"
private let multicastAddress = "239.255.255.250"
private let broadcastAddress = "255.255.255.255"
private let multicastPort: UInt16 = 1900

// ---------------------------------------------------------------------------
// Expo Module Definition
// ---------------------------------------------------------------------------

public class ExpoSsdpModule: Module {
  private let stateQueue = DispatchQueue(label: "expo.modules.ssdp.state")
  private var activeSearchers = [String: SsdpSearcher]()
  private var activeNotifyListeners = [String: SsdpNotifyListener]()

  public func definition() -> ModuleDefinition {
    Name("ExpoSsdp")
    Events("onSsdpDeviceFound", "onSsdpSearchComplete", "onSsdpSearchError", "onSsdpNotify", "onSsdpNotifyError")

    // ----- Batch search (backward-compatible) -----
    AsyncFunction("search") { (options: SearchOptions) -> [[String: Any]] in
      try await SsdpSearcher().search(options: options)
    }

    // ----- Streaming search -----
    Function("startSearch") { (searchId: String, options: SearchOptions) in
      let searcher = SsdpSearcher()
      self.stateQueue.sync {
        self.activeSearchers[searchId] = searcher
      }
      Task {
        do {
          try await searcher.startSearch(searchId: searchId, options: options) { [weak self] name, body in
            self?.sendEvent(name, body)
          }
        } catch {
          self.sendEvent("onSsdpSearchError", ["searchId": searchId, "error": error.localizedDescription])
        }
        self.stateQueue.sync {
          _ = self.activeSearchers.removeValue(forKey: searchId)
        }
      }
    }

    Function("stopSearch") { (searchId: String) in
      self.stateQueue.sync {
        self.activeSearchers[searchId]?.cancel()
        _ = self.activeSearchers.removeValue(forKey: searchId)
      }
    }

    // ----- Passive NOTIFY listener -----
    Function("startNotifyListener") { (listenerId: String) in
      let listener = SsdpNotifyListener()
      self.stateQueue.sync {
        self.activeNotifyListeners[listenerId]?.stop()
        self.activeNotifyListeners[listenerId] = listener
      }
      Task {
        await listener.listen(listenerId: listenerId) { [weak self] name, body in
          self?.sendEvent(name, body)
        }
      }
    }

    Function("stopNotifyListener") { (listenerId: String) in
      self.stateQueue.sync {
        self.activeNotifyListeners[listenerId]?.stop()
        _ = self.activeNotifyListeners.removeValue(forKey: listenerId)
      }
    }

    // ----- Utility -----
    AsyncFunction("getNetworkInterfaces") { () -> [String] in
      activeIPv4InterfaceNames()
    }
  }
}

// ---------------------------------------------------------------------------
// Options Record
// ---------------------------------------------------------------------------

private struct SearchOptions: Record {
  @Field var searchTargets: [String] = ["ssdp:all"]
  @Field var timeoutMs: Double = 5_000
  @Field var mx: Int = 3
  @Field var repeatProbe: Bool = true
  @Field var unicastTargets: [String] = []
  @Field var multicastEnabled: Bool = true
  @Field var broadcastEnabled: Bool = true
}

// ---------------------------------------------------------------------------
// SSDP Searcher — M-SEARCH (active discovery)
// ---------------------------------------------------------------------------

/// All mutable state accessed exclusively on `socketQueue`.
/// `@unchecked Sendable` is safe while this invariant is maintained.
private final class SsdpSearcher: NSObject, GCDAsyncUdpSocketDelegate, @unchecked Sendable {
  private let socketQueue = DispatchQueue(label: "expo.modules.ssdp.socket")
  private var socket: GCDAsyncUdpSocket?
  private var continuation: CheckedContinuation<[[String: Any]], Error>?
  private var results = [String: [String: Any]]()
  private var timeoutWorkItem: DispatchWorkItem?
  private var secondProbeWorkItem: DispatchWorkItem?
  private var options: SearchOptions = SearchOptions()
  private var finished = false

  // For streaming mode
  private var streamSearchId: String?
  private var streamEmitter: ((String, [String: Any]) -> Void)?

  func cancel() { socketQueue.async { self.finish(error: CancellationError()) } }

  // MARK: - Batch

  func search(options: SearchOptions) async throws -> [[String: Any]] {
    try await withCheckedThrowingContinuation { continuation in
      socketQueue.async { [weak self] in
        guard let self else { continuation.resume(returning: []); return }
        do { try self.start(options: options, continuation: continuation) }
        catch { continuation.resume(throwing: error) }
      }
    }
  }

  // MARK: - Streaming

  func startSearch(
    searchId: String,
    options: SearchOptions,
    emit: @escaping (String, [String: Any]) -> Void
  ) async throws {
    // NOTE: streamSearchId and streamEmitter are intentionally NOT set here.
    // They are assigned inside socketQueue.async in start() — on the same queue
    // as the delegate callbacks — to eliminate any data race.
    let _ = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<[[String: Any]], Error>) in
      socketQueue.async { [weak self] in
        guard let self else { continuation.resume(returning: []); return }
        do { try self.start(options: options, continuation: continuation, streamSearchId: searchId, streamEmitter: emit) }
        catch { continuation.resume(throwing: error) }
      }
    }
    // onSsdpSearchComplete is emitted from finish() on socketQueue — see below.
  }

  // MARK: - Private

  private func start(
    options: SearchOptions,
    continuation: CheckedContinuation<[[String: Any]], Error>,
    streamSearchId: String? = nil,
    streamEmitter: ((String, [String: Any]) -> Void)? = nil
  ) throws {
    guard socket == nil else { throw SsdpError.scanInProgress }
    finished = false
    results.removeAll()
    self.options = options
    self.options.mx = max(options.mx, 1)
    self.continuation = continuation
    // Assign stream properties here (on socketQueue) before beginReceiving() so
    // the delegate callback always sees them — no cross-thread data race.
    self.streamSearchId = streamSearchId
    self.streamEmitter = streamEmitter
    let effectiveTimeoutMs = max(options.timeoutMs, 500.0)

    let udpSocket = GCDAsyncUdpSocket(delegate: self, delegateQueue: socketQueue)
    socket = udpSocket
    try udpSocket.enableBroadcast(true)
    try udpSocket.bind(toPort: 0)

    let interfaces = activeIPv4InterfaceNames()
    if interfaces.isEmpty {
      try? udpSocket.joinMulticastGroup(multicastAddress)
    } else {
      for iface in interfaces {
        do { try udpSocket.joinMulticastGroup(multicastAddress, onInterface: iface) }
        catch { NSLog("[ExpoSsdp] multicast join failed on \(iface): \(error)") }
      }
    }

    try udpSocket.beginReceiving()
    sendProbes(socket: udpSocket)
    if options.repeatProbe { scheduleSecondProbe(socket: udpSocket, timeoutMs: effectiveTimeoutMs) }
    scheduleTimeout(after: effectiveTimeoutMs)
  }

  private func sendProbes(socket: GCDAsyncUdpSocket) {
    for target in options.searchTargets {
      guard let data = buildRequest(searchTarget: target, mx: options.mx).data(using: .utf8) else { continue }
      if options.multicastEnabled {
        socket.send(data, toHost: multicastAddress, port: multicastPort, withTimeout: -1, tag: 0)
      }
      if options.broadcastEnabled {
        socket.send(data, toHost: broadcastAddress, port: multicastPort, withTimeout: -1, tag: 1)
      }
      // Unicast probes (P4)
      for host in options.unicastTargets {
        socket.send(data, toHost: host, port: multicastPort, withTimeout: -1, tag: 2)
      }
    }
  }

  private func scheduleSecondProbe(socket: GCDAsyncUdpSocket, timeoutMs: Double) {
    let delay = (timeoutMs / 1000.0) / 2.0
    let workItem = DispatchWorkItem { [weak self] in
      guard let self, let socket = self.socket else { return }
      self.sendProbes(socket: socket)
    }
    secondProbeWorkItem = workItem
    socketQueue.asyncAfter(deadline: .now() + delay, execute: workItem)
  }

  private func scheduleTimeout(after timeoutMs: Double) {
    let workItem = DispatchWorkItem { [weak self] in self?.finish() }
    timeoutWorkItem = workItem
    socketQueue.asyncAfter(deadline: .now() + timeoutMs / 1000.0, execute: workItem)
  }

  private func finish(error: Error? = nil) {
    guard !finished else { return }
    finished = true
    timeoutWorkItem?.cancel(); secondProbeWorkItem?.cancel()
    timeoutWorkItem = nil; secondProbeWorkItem = nil
    socket?.close(); socket = nil
    // Emit the streaming complete event here (on socketQueue), BEFORE resuming
    // the continuation, so it is guaranteed to arrive after all onSsdpDeviceFound
    // events — which are also emitted on this same queue.
    if error == nil, let id = streamSearchId, let emit = streamEmitter {
      emit("onSsdpSearchComplete", ["searchId": id])
    }
    if let error, let continuation { continuation.resume(throwing: error) }
    else if let continuation { continuation.resume(returning: Array(results.values)) }
    continuation = nil
    results.removeAll()
    streamSearchId = nil
    streamEmitter = nil
  }

  private func buildRequest(searchTarget: String, mx: Int) -> String {
    "M-SEARCH * HTTP/1.1\r\n" +
    "HOST: \(multicastAddress):\(multicastPort)\r\n" +
    "MAN: \"ssdp:discover\"\r\n" +
    "MX: \(mx)\r\n" +
    "ST: \(searchTarget)\r\n" +
    "USER-AGENT: ExpoSsdp/\(libraryVersion) UPnP/1.1\r\n\r\n"
  }

  // MARK: - GCDAsyncUdpSocketDelegate

  func udpSocket(_ sock: GCDAsyncUdpSocket, didReceive data: Data, fromAddress address: Data, withFilterContext filterContext: Any?) {
    guard let response = String(data: data, encoding: .utf8),
          let host = GCDAsyncUdpSocket.host(fromAddress: address) else { return }
    let headers = parseHeaders(response)
    let usn = headers["USN"] ?? headers["usn"]
    let dedupeKey = usn ?? host
    guard results[dedupeKey] == nil else { return }
    var payload: [String: Any] = ["address": host, "headers": headers, "raw": response]
    if let v = headers["LOCATION"] ?? headers["Location"] { payload["location"] = v }
    if let v = headers["USN"] ?? headers["usn"] { payload["usn"] = v }
    if let v = headers["ST"] ?? headers["st"] { payload["st"] = v }
    if let v = headers["SERVER"] ?? headers["Server"] { payload["server"] = v }
    results[dedupeKey] = payload
    // Emit immediately for streaming mode
    if let id = streamSearchId, let emit = streamEmitter {
      emit("onSsdpDeviceFound", ["searchId": id, "device": payload])
    }
  }

  func udpSocket(_ sock: GCDAsyncUdpSocket, didNotConnect error: Error?) { if let e = error { finish(error: e) } }
  func udpSocket(_ sock: GCDAsyncUdpSocket, didNotBind error: Error?) { if let e = error { finish(error: e) } }
  func udpSocketDidClose(_ sock: GCDAsyncUdpSocket, withError error: Error?) {
    if let e = error { finish(error: e) } else { finish() }
  }
}

// ---------------------------------------------------------------------------
// SSDP Notify Listener — passive NOTIFY listener (P2)
// ---------------------------------------------------------------------------

private final class SsdpNotifyListener: NSObject, GCDAsyncUdpSocketDelegate, @unchecked Sendable {
  private let socketQueue = DispatchQueue(label: "expo.modules.ssdp.notify")
  private var socket: GCDAsyncUdpSocket?
  private var listenerId: String = ""
  private var emit: ((String, [String: Any]) -> Void)?
  private var stopped = false
  /// Cached regex — compiling NSRegularExpression is expensive; reuse across all NOTIFY packets.
  private let maxAgeRegex = try? NSRegularExpression(pattern: "max-age=\\s*(\\d+)", options: .caseInsensitive)

  func stop() {
    socketQueue.async { [weak self] in
      self?.stopped = true
      self?.socket?.close()
      self?.socket = nil
    }
  }

  func listen(
    listenerId: String,
    emit: @escaping (String, [String: Any]) -> Void
  ) async {
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      socketQueue.async { [weak self] in
        guard let self else { continuation.resume(); return }
        // Guard against stop() being called before the socket is created.
        // If already stopped, honour it and return immediately.
        guard !self.stopped else { continuation.resume(); return }
        // Assign properties on socketQueue so the delegate callbacks read
        // them on the same queue — no cross-thread race.
        self.listenerId = listenerId
        self.emit = emit
        do {
          let udpSocket = GCDAsyncUdpSocket(delegate: self, delegateQueue: self.socketQueue)
          self.socket = udpSocket
          try udpSocket.enableReusePort(true)
          try udpSocket.bind(toPort: multicastPort)
          let interfaces = activeIPv4InterfaceNames()
          for iface in interfaces {
            do { try udpSocket.joinMulticastGroup(multicastAddress, onInterface: iface) }
            catch { NSLog("[ExpoSsdp] notify join failed on \(iface): \(error)") }
          }
          try udpSocket.beginReceiving()
          continuation.resume()
        } catch {
          emit("onSsdpNotifyError", ["listenerId": listenerId, "error": error.localizedDescription])
          continuation.resume()
        }
      }
    }
  }

  func udpSocket(_ sock: GCDAsyncUdpSocket, didReceive data: Data, fromAddress address: Data, withFilterContext filterContext: Any?) {
    guard !stopped,
          let response = String(data: data, encoding: .utf8),
          response.hasPrefix("NOTIFY"),
          let host = GCDAsyncUdpSocket.host(fromAddress: address) else { return }
    let headers = parseHeaders(response)
    guard let nts = headers["NTS"] ?? headers["nts"] else { return }
    var event: [String: Any] = ["listenerId": listenerId, "nts": nts, "address": host, "headers": headers]
    if let v = headers["USN"] ?? headers["usn"] { event["usn"] = v }
    if let v = headers["NT"] ?? headers["nt"] { event["nt"] = v }
    if let v = headers["LOCATION"] ?? headers["Location"] { event["location"] = v }
    
    if let cc = headers["CACHE-CONTROL"] ?? headers["Cache-Control"],
       let regex = maxAgeRegex,
       let match = regex.firstMatch(in: cc, options: [], range: NSRange(location: 0, length: cc.utf16.count)),
       let range = Range(match.range(at: 1), in: cc),
       let age = Int(cc[range]) {
      event["maxAge"] = age
    }
    
    emit?("onSsdpNotify", event)
  }

  func udpSocketDidClose(_ sock: GCDAsyncUdpSocket, withError error: Error?) {
    // Forward socket errors to JS so callers can detect network loss and restart
    // the listener. Guard stopped so we don't emit after an intentional remove().
    guard let err = error, !stopped else { return }
    emit?("onSsdpNotifyError", ["listenerId": listenerId, "error": err.localizedDescription])
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

private enum SsdpError: Error { case scanInProgress }

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

private func parseHeaders(_ response: String) -> [String: String] {
  var headers: [String: String] = [:]
  response.split(whereSeparator: \.isNewline).dropFirst().forEach { line in
    guard let colonIndex = line.firstIndex(of: ":") else { return }
    let name = String(line.prefix(upTo: colonIndex)).trimmingCharacters(in: .whitespaces)
    let value = String(line.suffix(from: line.index(after: colonIndex))).trimmingCharacters(in: .whitespaces)
    headers[name] = value
    headers[name.uppercased()] = value
  }
  return headers
}

private func activeIPv4InterfaceNames() -> [String] {
  var ifaddrsPointer: UnsafeMutablePointer<ifaddrs>?
  guard getifaddrs(&ifaddrsPointer) == 0, let first = ifaddrsPointer else { return [] }
  defer { freeifaddrs(first) }
  var names = Set<String>()
  var pointer: UnsafeMutablePointer<ifaddrs>? = first
  while let current = pointer {
    let flags = Int32(current.pointee.ifa_flags)
    if (flags & IFF_UP) != 0, (flags & IFF_RUNNING) != 0, (flags & IFF_LOOPBACK) == 0,
       let addr = current.pointee.ifa_addr, addr.pointee.sa_family == UInt8(AF_INET),
       let name = String(validatingUTF8: current.pointee.ifa_name) { names.insert(name) }
    pointer = current.pointee.ifa_next
  }
  return Array(names)
}
