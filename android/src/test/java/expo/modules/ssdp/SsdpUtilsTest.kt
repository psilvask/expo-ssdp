package expo.modules.ssdp

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SsdpUtilsTest {

    // ── parseHeaders ─────────────────────────────────────────────────────────

    @Test
    fun `parseHeaders stores header with both original and uppercase keys`() {
        val raw = "HTTP/1.1 200 OK\r\nServer: Linux/5.4 UPnP/1.1\r\n"
        val h = parseHeaders(raw)
        assertEquals("Linux/5.4 UPnP/1.1", h["Server"])   // original casing
        assertEquals("Linux/5.4 UPnP/1.1", h["SERVER"])   // uppercased
    }

    @Test
    fun `parseHeaders extracts all standard SSDP response fields`() {
        val raw = """
            HTTP/1.1 200 OK
            LOCATION: http://192.168.1.1:1900/desc.xml
            USN: uuid:abc::upnp:rootdevice
            ST: upnp:rootdevice
            SERVER: Linux UPnP/1.1
            CACHE-CONTROL: max-age=1800
        """.trimIndent()
        val h = parseHeaders(raw)
        assertEquals("http://192.168.1.1:1900/desc.xml", h["LOCATION"])
        assertEquals("uuid:abc::upnp:rootdevice", h["USN"])
        assertEquals("upnp:rootdevice", h["ST"])
        assertEquals("Linux UPnP/1.1", h["SERVER"])
        assertEquals("max-age=1800", h["CACHE-CONTROL"])
    }

    @Test
    fun `parseHeaders skips the HTTP status line`() {
        val raw = "HTTP/1.1 200 OK\r\nVALID: yes\r\n"
        val h = parseHeaders(raw)
        assertNull(h["HTTP/1.1 200 OK"])
        assertEquals("yes", h["VALID"])
    }

    @Test
    fun `parseHeaders ignores malformed lines without a colon`() {
        val raw = "HTTP/1.1 200 OK\r\nmalformed\r\nVALID: value\r\n"
        val h = parseHeaders(raw)
        assertNull(h["malformed"])
        assertEquals("value", h["VALID"])
    }

    @Test
    fun `parseHeaders handles headers with colon in value`() {
        val raw = "HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.1:1900/desc.xml\r\n"
        val h = parseHeaders(raw)
        // Only split on first colon — full URL preserved
        assertEquals("http://192.168.1.1:1900/desc.xml", h["LOCATION"])
    }

    @Test
    fun `parseHeaders handles empty value (EXT header)`() {
        val raw = "HTTP/1.1 200 OK\r\nEXT:\r\n"
        val h = parseHeaders(raw)
        assertEquals("", h["EXT"])
    }

    @Test
    fun `parseHeaders trims whitespace from names and values`() {
        val raw = "HTTP/1.1 200 OK\r\n  KEY  :  padded value  \r\n"
        val h = parseHeaders(raw)
        assertEquals("padded value", h["KEY"])
    }

    // ── buildRequest ─────────────────────────────────────────────────────────

    @Test
    fun `buildRequest starts with M-SEARCH status line`() {
        val req = buildRequest("ssdp:all", 3)
        assertTrue(req.startsWith("M-SEARCH * HTTP/1.1\r\n"))
    }

    @Test
    fun `buildRequest includes required SSDP headers`() {
        val req = buildRequest("ssdp:all", 3)
        assertTrue(req.contains("HOST: $MULTICAST_ADDRESS:$MULTICAST_PORT\r\n"))
        assertTrue(req.contains("MAN: \"ssdp:discover\"\r\n"))
        assertTrue(req.contains("MX: 3\r\n"))
        assertTrue(req.contains("ST: ssdp:all\r\n"))
    }

    @Test
    fun `buildRequest ends with blank line terminator`() {
        val req = buildRequest("ssdp:all", 3)
        assertTrue(req.endsWith("\r\n\r\n"))
    }

    @Test
    fun `buildRequest uses the provided search target`() {
        val req = buildRequest("urn:schemas-upnp-org:device:MediaServer:1", 5)
        assertTrue(req.contains("ST: urn:schemas-upnp-org:device:MediaServer:1\r\n"))
        assertTrue(req.contains("MX: 5\r\n"))
    }

    @Test
    fun `buildRequest includes USER-AGENT header`() {
        val req = buildRequest("ssdp:all", 1)
        assertTrue(req.contains("USER-AGENT: ExpoSsdp/$LIBRARY_VERSION UPnP/1.1\r\n"))
    }

    // ── buildResult ──────────────────────────────────────────────────────────

    @Test
    fun `buildResult always includes address, headers, and raw`() {
        val headers = mapOf<String, String>()
        val result = buildResult("10.0.0.1", headers, "raw string")
        assertEquals("10.0.0.1", result["address"])
        assertEquals("raw string", result["raw"])
        assertTrue(result.containsKey("headers"))
    }

    @Test
    fun `buildResult maps optional fields from uppercase header keys`() {
        val headers = mapOf(
            "LOCATION" to "http://10.0.0.1/desc.xml",
            "USN" to "uuid:abc::rootdevice",
            "ST" to "upnp:rootdevice",
            "SERVER" to "Linux UPnP/1.1",
        )
        val result = buildResult("10.0.0.1", headers, "raw")
        assertEquals("http://10.0.0.1/desc.xml", result["location"])
        assertEquals("uuid:abc::rootdevice", result["usn"])
        assertEquals("upnp:rootdevice", result["st"])
        assertEquals("Linux UPnP/1.1", result["server"])
    }

    @Test
    fun `buildResult falls back to mixed-case keys for optional fields`() {
        val headers = mapOf(
            "Location" to "http://10.0.0.1/desc.xml",
            "Server" to "MyServer",
        )
        val result = buildResult("10.0.0.1", headers, "raw")
        assertEquals("http://10.0.0.1/desc.xml", result["location"])
        assertEquals("MyServer", result["server"])
    }

    @Test
    fun `buildResult omits optional fields when not present in headers`() {
        val result = buildResult("10.0.0.1", emptyMap(), "raw")
        assertFalse(result.containsKey("location"))
        assertFalse(result.containsKey("usn"))
        assertFalse(result.containsKey("st"))
        assertFalse(result.containsKey("server"))
    }
}
