package expo.modules.ssdp

import android.content.Context
import android.net.wifi.WifiManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
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
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap

private const val LIBRARY_VERSION = "0.0.1"
private const val MULTICAST_ADDRESS = "239.255.255.250"
private const val BROADCAST_ADDRESS = "255.255.255.255"
private const val MULTICAST_PORT = 1900
private const val SOCKET_READ_TIMEOUT_MS = 1000
private const val BUFFER_SIZE = 16_384

// ---------------------------------------------------------------------------
// Options Record
// ---------------------------------------------------------------------------

private class SearchOptions : Record {
  @Field var searchTargets: List<String> = listOf("ssdp:all")
  @Field var timeoutMs: Double = 5_000.0
  @Field var mx: Int = 3
  @Field var repeatProbe: Boolean = true
  @Field var unicastTargets: List<String> = emptyList()
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

    // ----- Batch search (backward-compatible) -----
    AsyncFunction("search") { options: SearchOptions ->
      SsdpSearcher(appContext).search(options)
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
            runCatching { socket.send(DatagramPacket(payload, payload.size, multicastAddr, MULTICAST_PORT)) }
            runCatching { socket.send(DatagramPacket(payload, payload.size, broadcastAddr, MULTICAST_PORT)) }
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
        for (iface in activeInterfaces) runCatching { socket.leaveGroup(groupAddress, iface) }
      } finally {
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
              ?.let { cc -> Regex("max-age=(\\d+)").find(cc)?.groupValues?.get(1)?.toIntOrNull() }
              ?.let { event["maxAge"] = it }
            emitEvent("onSsdpNotify", event)
          }
        } finally {
          registration?.dispose()
        }
      }
    } finally {
      if (lock?.isHeld == true) lock.release()
    }
  }
}

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

private fun buildRequest(searchTarget: String, mx: Int): String = buildString {
  append("M-SEARCH * HTTP/1.1\r\n")
  append("HOST: $MULTICAST_ADDRESS:$MULTICAST_PORT\r\n")
  append("MAN: \"ssdp:discover\"\r\n")
  append("MX: $mx\r\n")
  append("ST: $searchTarget\r\n")
  append("USER-AGENT: ExpoSsdp/$LIBRARY_VERSION UPnP/1.1\r\n")
  append("\r\n")
}

private fun parseHeaders(raw: String): Map<String, String> {
  val headers = mutableMapOf<String, String>()
  raw.lines().drop(1).forEach { line ->
    val idx = line.indexOf(':')
    if (idx <= 0) return@forEach
    val name = line.substring(0, idx).trim()
    val value = line.substring(idx + 1).trim()
    headers[name] = value
    headers[name.uppercase()] = value
  }
  return headers
}

private fun buildResult(address: String, headers: Map<String, String>, raw: String): Map<String, Any> {
  val result = mutableMapOf<String, Any>("address" to address, "headers" to headers, "raw" to raw)
  (headers["LOCATION"] ?: headers["Location"])?.let { result["location"] = it }
  (headers["USN"] ?: headers["usn"])?.let { result["usn"] = it }
  (headers["ST"] ?: headers["st"])?.let { result["st"] = it }
  (headers["SERVER"] ?: headers["Server"])?.let { result["server"] = it }
  return result
}

private fun getActiveIpv4Interfaces(): List<NetworkInterface> = try {
  Collections.list(NetworkInterface.getNetworkInterfaces()).filter { iface ->
    iface.isUp && !iface.isLoopback &&
      iface.inetAddresses.asSequence().any { addr ->
        !addr.isLoopbackAddress && addr.hostAddress?.contains(':') == false
      }
  }
} catch (_: Exception) { emptyList() }
