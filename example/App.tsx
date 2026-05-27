import React, { useState, useEffect, useRef } from "react";
import {
  StyleSheet,
  Text,
  View,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Switch,
  ActivityIndicator,
  SafeAreaView,
  StatusBar,
  Share,
  Alert,
} from "react-native";
import {
  searchStream,
  listenForNotifications,
  getNetworkInterfaces,
  isAvailable,
  SearchTargets,
  SsdpDevice,
  SsdpNotifyEvent,
} from "expo-ssdp";

export default function App() {
  const [activeTab, setActiveTab] = useState<"search" | "notify">("search");
  const [interfaces, setInterfaces] = useState<string[]>([]);
  const [isModuleAvailable, setIsModuleAvailable] = useState(isAvailable);

  // Search State
  const [searchTarget, setSearchTarget] = useState<string>(SearchTargets.ALL);
  const [timeoutMs, setTimeoutMs] = useState("5000");
  const [mx, setMx] = useState("3");
  const [repeatProbe, setRepeatProbe] = useState(true);
  const [unicastTargets, setUnicastTargets] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [discoveredDevices, setDiscoveredDevices] = useState<SsdpDevice[]>([]);

  // Notify State
  const [isListening, setIsListening] = useState(false);
  const [notifyEvents, setNotifyEvents] = useState<(SsdpNotifyEvent & { id: string; time: string })[]>([]);

  // Refs for cancellation
  const searchControllerRef = useRef<any>(null);
  const notifySubRef = useRef<any>(null);

  // Collapsed state for card details
  const [expandedCardId, setExpandedCardId] = useState<string | null>(null);

  useEffect(() => {
    // Load interfaces
    if (isModuleAvailable) {
      getNetworkInterfaces()
        .then(setInterfaces)
        .catch((err) => console.warn("Failed to get interfaces:", err));
    }
  }, [isModuleAvailable]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      searchControllerRef.current?.abort();
      notifySubRef.current?.remove();
    };
  }, []);

  // --- Active SSDP M-SEARCH ---
  const startActiveSearch = async () => {
    if (isSearching) {
      // Abort
      searchControllerRef.current?.abort();
      setIsSearching(false);
      return;
    }

    setDiscoveredDevices([]);
    setIsSearching(true);

    const controller = new AbortController();
    searchControllerRef.current = controller;

    const parsedTimeout = parseInt(timeoutMs, 10) || 5000;
    const parsedMx = parseInt(mx, 10) || 3;
    const parsedUnicast = unicastTargets
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    try {
      const stream = searchStream({
        searchTargets: [searchTarget],
        timeoutMs: parsedTimeout,
        mx: parsedMx,
        repeatProbe,
        unicastTargets: parsedUnicast,
      });

      // Handle abort control
      controller.signal.addEventListener("abort", () => {
        // Stream will be terminated via throw on loop iteration if cancelled native-side
      });

      for await (const device of stream) {
        if (controller.signal.aborted) break;
        setDiscoveredDevices((prev) => {
          // Deduplicate
          const exists = prev.some((d) => (d.usn && d.usn === device.usn) || d.address === device.address);
          if (exists) return prev;
          return [...prev, device];
        });
      }
    } catch (err: any) {
      if (err.name !== "AbortError" && err.message !== "CancellationError") {
        Alert.alert("Search Error", err.message || "SSDP Search failed.");
      }
    } finally {
      if (searchControllerRef.current === controller) {
        setIsSearching(false);
      }
    }
  };

  // --- Passive NOTIFY Listener ---
  const toggleNotifyListener = () => {
    if (isListening) {
      notifySubRef.current?.remove();
      notifySubRef.current = null;
      setIsListening(false);
      return;
    }

    setNotifyEvents([]);
    setIsListening(true);

    try {
      const sub = listenForNotifications({
        onAlive: (event) => addNotifyEvent(event),
        onByeBye: (event) => addNotifyEvent(event),
        onUpdate: (event) => addNotifyEvent(event),
        onError: (err) => {
          Alert.alert("Notification Error", err.message);
          setIsListening(false);
        },
      });
      notifySubRef.current = sub;
    } catch (err: any) {
      Alert.alert("Listener Error", err.message);
      setIsListening(false);
    }
  };

  const addNotifyEvent = (event: SsdpNotifyEvent) => {
    const timeStr = new Date().toLocaleTimeString();
    const eventId = `${event.usn || event.address}-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    setNotifyEvents((prev) => [
      { ...event, id: eventId, time: timeStr },
      ...prev.slice(0, 49), // cap at 50 events
    ]);
  };

  const shareDeviceDetails = (device: any) => {
    Share.share({
      message: JSON.stringify(device, null, 2),
      title: "SSDP Device Details",
    });
  };

  const toggleExpand = (id: string) => {
    setExpandedCardId((prev) => (prev === id ? null : id));
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0F172A" />

      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>SSDP Explorer</Text>
          <Text style={styles.headerSubtitle}>Real-time network device discovery</Text>
        </View>
        <View
          style={[
            styles.statusIndicator,
            { backgroundColor: isModuleAvailable ? "#10B981" : "#EF4444" },
          ]}
        >
          <Text style={styles.statusText}>{isModuleAvailable ? "Ready" : "Offline"}</Text>
        </View>
      </View>

      {/* Tabs */}
      <View style={styles.tabsContainer}>
        <TouchableOpacity
          style={[styles.tab, activeTab === "search" && styles.activeTab]}
          onPress={() => setActiveTab("search")}
        >
          <Text style={[styles.tabText, activeTab === "search" && styles.activeTabText]}>
            Active Search
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, activeTab === "notify" && styles.activeTab]}
          onPress={() => setActiveTab("notify")}
        >
          <Text style={[styles.tabText, activeTab === "notify" && styles.activeTabText]}>
            Passive Listener
          </Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        {/* Network Interfaces Tag */}
        <View style={styles.interfacesCard}>
          <Text style={styles.interfacesTitle}>Active Network Interfaces:</Text>
          <Text style={styles.interfacesList}>
            {interfaces.length > 0 ? interfaces.join(", ") : "None detected"}
          </Text>
        </View>

        {activeTab === "search" ? (
          /* =========================================================================
             ACTIVE SEARCH PANEL
             ========================================================================= */
          <View>
            {/* Options Card */}
            <View style={styles.card}>
              <Text style={styles.cardTitle}>M-SEARCH Options</Text>

              <Text style={styles.label}>Search Target (ST)</Text>
              <View style={styles.pickerContainer}>
                {[
                  { label: "All Services (ssdp:all)", value: SearchTargets.ALL },
                  { label: "Root Devices (upnp:rootdevice)", value: SearchTargets.ROOT_DEVICE },
                  { label: "Sonos Players", value: SearchTargets.SONOS },
                  { label: "Roku Players", value: SearchTargets.ROKU },
                  { label: "Media Servers", value: SearchTargets.MEDIA_SERVER },
                  { label: "Philips Hue Bridges", value: SearchTargets.HUE_BRIDGE },
                ].map((target) => (
                  <TouchableOpacity
                    key={target.value}
                    style={[
                      styles.targetBadge,
                      searchTarget === target.value && styles.activeTargetBadge,
                    ]}
                    onPress={() => setSearchTarget(target.value)}
                  >
                    <Text
                      style={[
                        styles.targetBadgeText,
                        searchTarget === target.value && styles.activeTargetBadgeText,
                      ]}
                    >
                      {target.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <View style={styles.row}>
                <View style={[styles.column, { marginRight: 12 }]}>
                  <Text style={styles.label}>Timeout (ms)</Text>
                  <TextInput
                    style={styles.input}
                    value={timeoutMs}
                    onChangeText={setTimeoutMs}
                    keyboardType="numeric"
                    placeholder="5000"
                    placeholderTextColor="#64748B"
                  />
                </View>
                <View style={styles.column}>
                  <Text style={styles.label}>MX (sec)</Text>
                  <TextInput
                    style={styles.input}
                    value={mx}
                    onChangeText={setMx}
                    keyboardType="numeric"
                    placeholder="3"
                    placeholderTextColor="#64748B"
                  />
                </View>
              </View>

              <View style={[styles.row, styles.switchRow]}>
                <Text style={styles.switchLabel}>Repeat Probe half-way</Text>
                <Switch
                  value={repeatProbe}
                  onValueChange={setRepeatProbe}
                  trackColor={{ false: "#334155", true: "#6366F1" }}
                  thumbColor="#FFFFFF"
                />
              </View>

              <Text style={styles.label}>Unicast Target IPs (comma separated)</Text>
              <TextInput
                style={styles.input}
                value={unicastTargets}
                onChangeText={setUnicastTargets}
                placeholder="e.g. 192.168.1.50, 192.168.1.100"
                placeholderTextColor="#64748B"
              />

              <TouchableOpacity
                style={[styles.button, isSearching ? styles.buttonStop : styles.buttonStart]}
                onPress={startActiveSearch}
              >
                {isSearching ? (
                  <View style={styles.buttonInner}>
                    <ActivityIndicator size="small" color="#FFFFFF" style={{ marginRight: 8 }} />
                    <Text style={styles.buttonText}>Stop Discovery</Text>
                  </View>
                ) : (
                  <Text style={styles.buttonText}>Start SSDP Streaming Search</Text>
                )}
              </TouchableOpacity>
            </View>

            {/* Results Title */}
            <View style={styles.resultsHeader}>
              <Text style={styles.resultsTitle}>Discovered Devices ({discoveredDevices.length})</Text>
              {discoveredDevices.length > 0 && (
                <TouchableOpacity onPress={() => setDiscoveredDevices([])}>
                  <Text style={styles.clearText}>Clear</Text>
                </TouchableOpacity>
              )}
            </View>

            {/* Empty view */}
            {discoveredDevices.length === 0 && !isSearching && (
              <View style={styles.emptyView}>
                <Text style={styles.emptyText}>No devices discovered yet.</Text>
                <Text style={styles.emptySubtext}>Tap "Start SSDP Streaming Search" to scan your network.</Text>
              </View>
            )}

            {/* Streaming indicator */}
            {discoveredDevices.length === 0 && isSearching && (
              <View style={styles.emptyView}>
                <ActivityIndicator size="large" color="#6366F1" />
                <Text style={[styles.emptyText, { marginTop: 12 }]}>Scanning local network...</Text>
              </View>
            )}

            {/* Discovered Cards */}
            {discoveredDevices.map((device, index) => {
              const cardId = device.usn || `${device.address}-${index}`;
              const isExpanded = expandedCardId === cardId;
              const title = device.headers["FRIENDLYNAME"] || device.headers["friendlyName"] || device.server || "UPnP Device";

              return (
                <View key={cardId} style={styles.deviceCard}>
                  <TouchableOpacity style={styles.cardHeader} onPress={() => toggleExpand(cardId)}>
                    <View style={styles.cardHeaderLeft}>
                      <Text style={styles.deviceTitle} numberOfLines={1}>{title}</Text>
                      <Text style={styles.deviceAddress}>{device.address}</Text>
                    </View>
                    <Text style={styles.expandLabel}>{isExpanded ? "Collapse" : "Inspect"}</Text>
                  </TouchableOpacity>

                  {isExpanded && (
                    <View style={styles.cardDetails}>
                      <Text style={styles.detailLabel}>USN</Text>
                      <Text style={styles.detailValue}>{device.usn || "None"}</Text>

                      <Text style={styles.detailLabel}>ST (Search Target)</Text>
                      <Text style={styles.detailValue}>{device.st || "None"}</Text>

                      {device.location && (
                        <>
                          <Text style={styles.detailLabel}>XML Location Descriptor</Text>
                          <Text style={[styles.detailValue, styles.linkText]}>{device.location}</Text>
                        </>
                      )}

                      <Text style={styles.detailLabel}>Server info</Text>
                      <Text style={styles.detailValue}>{device.server || "None"}</Text>

                      <Text style={[styles.detailLabel, { marginTop: 12 }]}>All HTTP Headers</Text>
                      <View style={styles.headersBlock}>
                        {Object.entries(device.headers)
                          .filter(([k]) => k === k.toLowerCase()) // show only normalized lowercase for readability
                          .map(([key, val]) => (
                            <Text key={key} style={styles.headerLine}>
                              <Text style={styles.headerKey}>{key}:</Text> {val}
                            </Text>
                          ))}
                      </View>

                      <TouchableOpacity
                        style={styles.shareButton}
                        onPress={() => shareDeviceDetails(device)}
                      >
                        <Text style={styles.shareButtonText}>Share JSON Details</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </View>
              );
            })}
          </View>
        ) : (
          /* =========================================================================
             PASSIVE NOTIFY LISTENER PANEL
             ========================================================================= */
          <View>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>SSDP Passive Monitor</Text>
              <Text style={styles.cardDescription}>
                Listen continuously on port 1900 for unsolicited SSDP presence events (NOTIFY) generated by devices when they join, leave, or update.
              </Text>

              <TouchableOpacity
                style={[styles.button, isListening ? styles.buttonStop : styles.buttonStart]}
                onPress={toggleNotifyListener}
              >
                {isListening ? (
                  <View style={styles.buttonInner}>
                    <ActivityIndicator size="small" color="#FFFFFF" style={{ marginRight: 8 }} />
                    <Text style={styles.buttonText}>Stop Listener</Text>
                  </View>
                ) : (
                  <Text style={styles.buttonText}>Start Passive Listener</Text>
                )}
              </TouchableOpacity>
            </View>

            {/* Results Title */}
            <View style={styles.resultsHeader}>
              <Text style={styles.resultsTitle}>Unsolicited Events ({notifyEvents.length})</Text>
              {notifyEvents.length > 0 && (
                <TouchableOpacity onPress={() => setNotifyEvents([])}>
                  <Text style={styles.clearText}>Clear</Text>
                </TouchableOpacity>
              )}
            </View>

            {/* Empty view */}
            {notifyEvents.length === 0 && !isListening && (
              <View style={styles.emptyView}>
                <Text style={styles.emptyText}>Not listening.</Text>
                <Text style={styles.emptySubtext}>Tap "Start Passive Listener" to capture presence packets in real-time.</Text>
              </View>
            )}

            {/* Listening indicator */}
            {notifyEvents.length === 0 && isListening && (
              <View style={styles.emptyView}>
                <ActivityIndicator size="large" color="#6366F1" />
                <Text style={[styles.emptyText, { marginTop: 12 }]}>Waiting for SSDP NOTIFY packets...</Text>
                <Text style={styles.emptySubtext}>Plug/unplug a smart device or TV to trigger announcements immediately.</Text>
              </View>
            )}

            {/* Events List */}
            {notifyEvents.map((evt) => {
              const isExpanded = expandedCardId === evt.id;
              let badgeColor = "#64748B"; // grey (update)
              if (evt.nts === "ssdp:alive") badgeColor = "#10B981"; // green
              if (evt.nts === "ssdp:byebye") badgeColor = "#EF4444"; // red

              return (
                <View key={evt.id} style={styles.deviceCard}>
                  <TouchableOpacity style={styles.cardHeader} onPress={() => toggleExpand(evt.id)}>
                    <View style={styles.cardHeaderLeft}>
                      <View style={styles.row}>
                        <View style={[styles.eventBadge, { backgroundColor: badgeColor }]}>
                          <Text style={styles.eventBadgeText}>{evt.nts.replace("ssdp:", "")}</Text>
                        </View>
                        <Text style={styles.eventTime}>{evt.time}</Text>
                      </View>
                      <Text style={styles.deviceAddress} numberOfLines={1}>{evt.usn || evt.address}</Text>
                    </View>
                    <Text style={styles.expandLabel}>{isExpanded ? "Hide" : "Headers"}</Text>
                  </TouchableOpacity>

                  {isExpanded && (
                    <View style={styles.cardDetails}>
                      <Text style={styles.detailLabel}>Originating IP Address</Text>
                      <Text style={styles.detailValue}>{evt.address}</Text>

                      <Text style={styles.detailLabel}>Notification Type (NT)</Text>
                      <Text style={styles.detailValue}>{evt.nt || "None"}</Text>

                      {evt.location && (
                        <>
                          <Text style={styles.detailLabel}>Location Descriptor XML</Text>
                          <Text style={[styles.detailValue, styles.linkText]}>{evt.location}</Text>
                        </>
                      )}

                      {evt.maxAge !== undefined && (
                        <>
                          <Text style={styles.detailLabel}>Cache-Control Max Age</Text>
                          <Text style={styles.detailValue}>{evt.maxAge} seconds</Text>
                        </>
                      )}

                      <Text style={[styles.detailLabel, { marginTop: 12 }]}>All HTTP Headers</Text>
                      <View style={styles.headersBlock}>
                        {Object.entries(evt.headers)
                          .filter(([k]) => k === k.toLowerCase())
                          .map(([key, val]) => (
                            <Text key={key} style={styles.headerLine}>
                              <Text style={styles.headerKey}>{key}:</Text> {val}
                            </Text>
                          ))}
                      </View>
                    </View>
                  )}
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0F172A",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#1E293B",
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: "bold",
    color: "#F8FAFC",
  },
  headerSubtitle: {
    fontSize: 12,
    color: "#64748B",
    marginTop: 2,
  },
  statusIndicator: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  statusText: {
    fontSize: 11,
    fontWeight: "bold",
    color: "#FFFFFF",
  },
  tabsContainer: {
    flexDirection: "row",
    paddingHorizontal: 16,
    marginTop: 12,
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    alignItems: "center",
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  activeTab: {
    borderBottomColor: "#6366F1",
  },
  tabText: {
    fontSize: 14,
    fontWeight: "600",
    color: "#64748B",
  },
  activeTabText: {
    color: "#6366F1",
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 40,
  },
  interfacesCard: {
    backgroundColor: "#1E293B",
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: "#334155",
  },
  interfacesTitle: {
    fontSize: 12,
    fontWeight: "bold",
    color: "#94A3B8",
    textTransform: "uppercase",
  },
  interfacesList: {
    fontSize: 14,
    color: "#38BDF8",
    marginTop: 4,
    fontWeight: "500",
  },
  card: {
    backgroundColor: "#1E293B",
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: "#334155",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 4,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: "bold",
    color: "#F8FAFC",
    marginBottom: 12,
  },
  cardDescription: {
    fontSize: 13,
    color: "#94A3B8",
    lineHeight: 18,
    marginBottom: 20,
  },
  label: {
    fontSize: 12,
    fontWeight: "600",
    color: "#94A3B8",
    marginTop: 12,
    marginBottom: 6,
  },
  pickerContainer: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 8,
  },
  targetBadge: {
    backgroundColor: "#334155",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
  },
  activeTargetBadge: {
    backgroundColor: "#6366F1",
  },
  targetBadgeText: {
    fontSize: 12,
    color: "#94A3B8",
  },
  activeTargetBadgeText: {
    color: "#FFFFFF",
    fontWeight: "500",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
  },
  column: {
    flex: 1,
  },
  switchRow: {
    justifyContent: "space-between",
    marginVertical: 12,
  },
  input: {
    backgroundColor: "#0F172A",
    borderWidth: 1,
    borderColor: "#334155",
    borderRadius: 8,
    color: "#F8FAFC",
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
  },
  switchLabel: {
    fontSize: 14,
    color: "#94A3B8",
  },
  button: {
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 16,
  },
  buttonStart: {
    backgroundColor: "#6366F1",
  },
  buttonStop: {
    backgroundColor: "#EF4444",
  },
  buttonInner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "bold",
  },
  resultsHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 24,
    marginBottom: 12,
    paddingHorizontal: 4,
  },
  resultsTitle: {
    fontSize: 15,
    fontWeight: "bold",
    color: "#F8FAFC",
  },
  clearText: {
    color: "#EF4444",
    fontSize: 13,
  },
  emptyView: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 40,
    backgroundColor: "#1E293B",
    borderRadius: 12,
    borderStyle: "dashed",
    borderWidth: 1,
    borderColor: "#475569",
  },
  emptyText: {
    fontSize: 14,
    fontWeight: "600",
    color: "#94A3B8",
  },
  emptySubtext: {
    fontSize: 12,
    color: "#64748B",
    textAlign: "center",
    marginTop: 4,
    paddingHorizontal: 24,
  },
  deviceCard: {
    backgroundColor: "#1E293B",
    borderRadius: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#334155",
    overflow: "hidden",
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 14,
  },
  cardHeaderLeft: {
    flex: 1,
    marginRight: 12,
  },
  deviceTitle: {
    fontSize: 15,
    fontWeight: "bold",
    color: "#F8FAFC",
  },
  deviceAddress: {
    fontSize: 12,
    color: "#38BDF8",
    marginTop: 2,
    fontWeight: "500",
  },
  expandLabel: {
    fontSize: 12,
    color: "#6366F1",
    fontWeight: "500",
  },
  cardDetails: {
    borderTopWidth: 1,
    borderTopColor: "#334155",
    padding: 14,
    backgroundColor: "#0F172A",
  },
  detailLabel: {
    fontSize: 11,
    fontWeight: "bold",
    color: "#64748B",
    textTransform: "uppercase",
    marginTop: 8,
  },
  detailValue: {
    fontSize: 13,
    color: "#E2E8F0",
    marginTop: 2,
  },
  linkText: {
    color: "#38BDF8",
  },
  headersBlock: {
    backgroundColor: "#1E293B",
    borderRadius: 6,
    padding: 10,
    marginTop: 6,
    borderWidth: 1,
    borderColor: "#334155",
  },
  headerLine: {
    fontSize: 11,
    color: "#E2E8F0",
    fontFamily: "monospace",
    marginVertical: 1,
  },
  headerKey: {
    color: "#F59E0B",
    fontWeight: "bold",
  },
  shareButton: {
    backgroundColor: "#334155",
    borderRadius: 6,
    paddingVertical: 8,
    alignItems: "center",
    marginTop: 14,
  },
  shareButtonText: {
    fontSize: 12,
    color: "#F8FAFC",
    fontWeight: "bold",
  },
  eventBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    marginRight: 8,
  },
  eventBadgeText: {
    color: "#FFFFFF",
    fontSize: 10,
    fontWeight: "bold",
    textTransform: "uppercase",
  },
  eventTime: {
    fontSize: 11,
    color: "#64748B",
  },
});
