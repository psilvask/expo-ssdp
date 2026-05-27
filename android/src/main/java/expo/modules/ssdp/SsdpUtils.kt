package expo.modules.ssdp

import java.net.NetworkInterface
import java.util.Collections

// ---------------------------------------------------------------------------
// Shared constants — internal so tests can access them without reflection
// ---------------------------------------------------------------------------

internal const val LIBRARY_VERSION = "0.0.2"
internal const val MULTICAST_ADDRESS = "239.255.255.250"
internal const val BROADCAST_ADDRESS = "255.255.255.255"
internal const val MULTICAST_PORT = 1900
internal const val SOCKET_READ_TIMEOUT_MS = 1000
internal const val BUFFER_SIZE = 16_384

/** Compiled once and reused for every incoming NOTIFY packet. */
internal val MAX_AGE_REGEX = Regex("max-age=(\\d+)")

// ---------------------------------------------------------------------------
// Pure utility functions — internal visibility enables unit testing
// ---------------------------------------------------------------------------

/**
 * Builds a UPnP M-SEARCH request string for the given search target and MX.
 */
internal fun buildRequest(searchTarget: String, mx: Int): String = buildString {
    append("M-SEARCH * HTTP/1.1\r\n")
    append("HOST: $MULTICAST_ADDRESS:$MULTICAST_PORT\r\n")
    append("MAN: \"ssdp:discover\"\r\n")
    append("MX: $mx\r\n")
    append("ST: $searchTarget\r\n")
    append("USER-AGENT: ExpoSsdp/$LIBRARY_VERSION UPnP/1.1\r\n")
    append("\r\n")
}

/**
 * Parses HTTP-like SSDP headers from a raw response string. Each header is
 * stored twice — once with its original casing and once uppercased — for
 * case-insensitive lookup without repeated `.uppercase()` calls at use sites.
 */
internal fun parseHeaders(raw: String): Map<String, String> {
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

/**
 * Builds the typed result map from a raw SSDP response. Optional fields
 * (location, usn, st, server) are only included when present in the headers.
 */
internal fun buildResult(
    address: String,
    headers: Map<String, String>,
    raw: String,
): Map<String, Any> {
    val result = mutableMapOf<String, Any>("address" to address, "headers" to headers, "raw" to raw)
    (headers["LOCATION"] ?: headers["Location"])?.let { result["location"] = it }
    (headers["USN"] ?: headers["usn"])?.let { result["usn"] = it }
    (headers["ST"] ?: headers["st"])?.let { result["st"] = it }
    (headers["SERVER"] ?: headers["Server"])?.let { result["server"] = it }
    return result
}

/**
 * Returns all active, non-loopback IPv4 network interfaces on the device.
 * Used to join multicast groups on every interface, maximising discovery
 * reliability on multi-homed devices.
 */
internal fun getActiveIpv4Interfaces(): List<NetworkInterface> = try {
    Collections.list(NetworkInterface.getNetworkInterfaces()).filter { iface ->
        iface.isUp && !iface.isLoopback &&
            iface.inetAddresses.asSequence().any { addr ->
                !addr.isLoopbackAddress && addr.hostAddress?.contains(':') == false
            }
    }
} catch (_: Exception) { emptyList() }
