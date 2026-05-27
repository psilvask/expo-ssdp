package expo.modules.ssdp

import android.content.Context
import android.net.wifi.WifiManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.Promise
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.DisposableHandle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.DatagramPacket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.MulticastSocket
import java.net.NetworkInterface
import java.net.SocketTimeoutException
import java.util.concurrent.ConcurrentHashMap

// ---------------------------------------------------------------------------
// Options Record
// ---------------------------------------------------------------------------

private class SearchOptions : Record {
  @Field var searchTargets: List<String> = listOf("ssdp:all")
  @Field var timeoutMs: Double = 5_000.0
  @Field var mx: Int = 3
  @Field var repeatProbe: Boolean = true
  @Field var unicastTargets: List<String> = emptyList()
  @Field var multicastEnabled: Boolean = true
  @Field var broadcastEnabled: Boolean = true
}

// ---------------------------------------------------------------------------
// Expo Module Definition
// ---------------------------------------------------------------------------

class ExpoSsdpModule : Module() {
  private val moduleScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val activeSearches = ConcurrentHashMap<String, Job>()
  private val activeNotifyListeners = ConcurrentHashMap<String, Job>()

  private fun emit(name: String, body: Map<String, Any?>) = sendEvent(name, body)

  override fun definition() = ModuleDefinition {
    Name("ExpoSsdp")
    Events(
      "onSsdpDeviceFound",
      "onSsdpSearchComplete",
      "onSsdpSearchError",
      "onSsdpNotify",
      "onSsdpNotifyError"
    )

    AsyncFunction("search") { options: SearchOptions, promise: Promise ->
      moduleScope.launch {
        try {
          val results = SsdpSearcher(appContext).search(options)
          promise.resolve(results)
        } catch (e: Exception) {
          promise.reject("ERR_SSDP_SEARCH", e.message, e)
        }
      }
    }

    // ----- Streaming search -----
    Function("startSearch") { searchId: String, options: SearchOptions ->
      val job = moduleScope.launch {
        try {
          SsdpSearcher(appContext) { name, body -> emit(name, body) }
            .startSearch(searchId, options)
        } catch (e: Exception) {
          emit("onSsdpSearchError", mapOf("searchId" to searchId, "error" to (e.message ?: "Unknown error")))
        }
      }
      activeSearches[searchId] = job
    }

    Function("stopSearch") { searchId: String ->
      activeSearches.remove(searchId)?.cancel()
    }

    // ----- Passive NOTIFY listener -----
    Function("startNotifyListener") { listenerId: String ->
      val job = moduleScope.launch {
        try {
          SsdpNotifyListener(appContext) { name, body -> emit(name, body) }
            .listen(listenerId)
        } catch (e: Exception) {
          emit("onSsdpNotifyError", mapOf("listenerId" to listenerId, "error" to (e.message ?: "Unknown error")))
        }
      }
      activeNotifyListeners[listenerId] = job
    }

    Function("stopNotifyListener") { listenerId: String ->
      activeNotifyListeners.remove(listenerId)?.cancel()
    }

    // ----- Utility -----
    AsyncFunction("getNetworkInterfaces") { ->
      getActiveIpv4Interfaces().map { it.name }
    }

    OnDestroy {
      moduleScope.cancel()
    }
  }
}

// ---------------------------------------------------------------------------
// Core search logic — shared by batch and streaming APIs
// ---------------------------------------------------------------------------

private class SsdpSearcher(
  private val appContext: expo.modules.kotlin.AppContext,
  private val emitEvent: ((name: String, body: Map<String, Any?>) -> Unit)? = null
) {
  /** Batch: run search, return full result list. */
  suspend fun search(options: SearchOptions): List<Map<String, Any>> =
    withContext(Dispatchers.IO) {
      val results = mutableListOf<Map<String, Any>>()
      val lock = acquireMulticastLock()
      try {
        doSearch(options) { results.add(it) }
      } finally {
        if (lock?.isHeld == true) lock.release()
      }
      results
    }

  /** Streaming: run search, emit onSsdpDeviceFound per device, then onSsdpSearchComplete. */
  suspend fun startSearch(searchId: String, options: SearchOptions) =
    withContext(Dispatchers.IO) {
      val lock = acquireMulticastLock()
      try {
        doSearch(options) { device ->
          emitEvent?.invoke("onSsdpDeviceFound", mapOf("searchId" to searchId, "device" to device))
        }
        emitEvent?.invoke("onSsdpSearchComplete", mapOf("searchId" to searchId))
      } finally {
        if (lock?.isHeld == true) lock.release()
      }
    }

  private fun acquireMulticastLock(): WifiManager.MulticastLock? {
    val context = appContext.reactContext
    val wm = context?.applicationContext?.getSystemService(Context.WIFI_SERVICE) as? WifiManager
    return wm?.createMulticastLock("expo-ssdp")?.also { it.setReferenceCounted(false); it.acquire() }
  }

  private suspend fun doSearch(options: SearchOptions, onDevice: (Map<String, Any>) -> Unit) {
    val timeoutMs = options.timeoutMs.toLong().coerceAtLeast(500L)
    val effectiveMx = options.mx.coerceAtLeast(1)
    val multicastAddr = InetAddress.getByName(MULTICAST_ADDRESS)
    val broadcastAddr = InetAddress.getByName(BROADCAST_ADDRESS)
    val unicastAddrs = options.unicastTargets.mapNotNull {
      runCatching { InetAddress.getByName(it) }.getOrNull()
    }
    val responses = LinkedHashMap<String, Map<String, Any>>()
    val payloads = options.searchTargets.map { buildRequest(it, effectiveMx).toByteArray(Charsets.UTF_8) }
    val activeInterfaces = getActiveIpv4Interfaces()
    val groupAddress = InetSocketAddress(multicastAddr, MULTICAST_PORT)

    MulticastSocket(0).use { socket ->
      val job = currentCoroutineContext()[Job]
      val registration = job?.invokeOnCompletion {
        runCatching { socket.close() }
      }
      try {
        socket.reuseAddress = true
        socket.soTimeout = SOCKET_READ_TIMEOUT_MS
        socket.broadcast = true
        for (iface in activeInterfaces) runCatching { socket.joinGroup(groupAddress, iface) }

        fun sendProbes() {
          payloads.forEach { payload ->
            if (options.multicastEnabled) {
              runCatching { socket.send(DatagramPacket(payload, payload.size, multicastAddr, MULTICAST_PORT)) }
            }
            if (options.broadcastEnabled) {
              runCatching { socket.send(DatagramPacket(payload, payload.size, broadcastAddr, MULTICAST_PORT)) }
            }
            // Unicast probes (P4)
            for (addr in unicastAddrs) {
              runCatching { socket.send(DatagramPacket(payload, payload.size, addr, MULTICAST_PORT)) }
            }
          }
        }

        sendProbes()
        val now = System.currentTimeMillis()
        val deadline = now + timeoutMs
        val secondProbeAt = now + (timeoutMs / 2)
        var secondProbeSent = !options.repeatProbe
        val buffer = ByteArray(BUFFER_SIZE)

        while (System.currentTimeMillis() < deadline) {
          currentCoroutineContext().ensureActive()
          if (!secondProbeSent && System.currentTimeMillis() >= secondProbeAt) {
            sendProbes(); secondProbeSent = true
          }
          val pkt = DatagramPacket(buffer, buffer.size)
          try { socket.receive(pkt) } catch (_: SocketTimeoutException) { continue }
          val length = pkt.length
          if (length <= 0) continue
          val raw = String(buffer, 0, length, Charsets.UTF_8)
          val headers = parseHeaders(raw)
          val address = pkt.address?.hostAddress ?: continue
          val usn = headers["USN"] ?: headers["usn"]
          val dedupeKey = usn ?: address
          if (responses.containsKey(dedupeKey)) continue
          val result = buildResult(address, headers, raw)
          responses[dedupeKey] = result
          onDevice(result)
        }
      } finally {
        // Leave multicast groups and dispose the cancellation hook on every exit path —
        // including coroutine cancellation from stopSearch() — so port 1900 is freed promptly.
        for (iface in activeInterfaces) runCatching { socket.leaveGroup(groupAddress, iface) }
        registration?.dispose()
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Passive NOTIFY listener (P2)
// ---------------------------------------------------------------------------

private class SsdpNotifyListener(
  private val appContext: expo.modules.kotlin.AppContext,
  private val emitEvent: (name: String, body: Map<String, Any?>) -> Unit
) {
  suspend fun listen(listenerId: String) = withContext(Dispatchers.IO) {
    val context = appContext.reactContext
    val wm = context?.applicationContext?.getSystemService(Context.WIFI_SERVICE) as? WifiManager
    val lock = wm?.createMulticastLock("expo-ssdp-notify-$listenerId")?.also { it.setReferenceCounted(false); it.acquire() }
    val multicastAddr = InetAddress.getByName(MULTICAST_ADDRESS)
    val activeInterfaces = getActiveIpv4Interfaces()
    val groupAddress = InetSocketAddress(multicastAddr, MULTICAST_PORT)
    val buffer = ByteArray(BUFFER_SIZE)

    try {
      MulticastSocket(MULTICAST_PORT).use { socket ->
        val job = currentCoroutineContext()[Job]
        val registration = job?.invokeOnCompletion {
          runCatching { socket.close() }
        }
        try {
          socket.reuseAddress = true
          socket.soTimeout = SOCKET_READ_TIMEOUT_MS
          for (iface in activeInterfaces) runCatching { socket.joinGroup(groupAddress, iface) }

          while (true) {
            currentCoroutineContext().ensureActive()
            val pkt = DatagramPacket(buffer, buffer.size)
            try { socket.receive(pkt) } catch (_: SocketTimeoutException) { continue }
            val length = pkt.length
            if (length <= 0) continue
            val raw = String(buffer, 0, length, Charsets.UTF_8)
            // Only process NOTIFY packets
            if (!raw.startsWith("NOTIFY")) continue
            val headers = parseHeaders(raw)
            val nts = headers["NTS"] ?: headers["nts"] ?: continue
            val address = pkt.address?.hostAddress ?: continue
            val event = mutableMapOf<String, Any?>(
              "listenerId" to listenerId,
              "nts" to nts,
              "address" to address,
              "headers" to headers,
            )
            (headers["USN"] ?: headers["usn"])?.let { event["usn"] = it }
            (headers["NT"] ?: headers["nt"])?.let { event["nt"] = it }
            (headers["LOCATION"] ?: headers["Location"])?.let { event["location"] = it }
            // Parse max-age from CACHE-CONTROL: max-age=1800
            (headers["CACHE-CONTROL"] ?: headers["Cache-Control"])
              ?.let { cc -> MAX_AGE_REGEX.find(cc)?.groupValues?.get(1)?.toIntOrNull() }
              ?.let { event["maxAge"] = it }
            emitEvent("onSsdpNotify", event)
          }
        } finally {
          // Leave multicast groups before the socket closes so the OS can
          // promptly free port 1900 for subsequent listener restarts.
          for (iface in activeInterfaces) runCatching { socket.leaveGroup(groupAddress, iface) }
          registration?.dispose()
        }
      }
    } finally {
      if (lock?.isHeld == true) lock.release()
    }
  }
}
