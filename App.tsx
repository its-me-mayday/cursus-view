import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

// ─── Types ────────────────────────────────────────────────────────────────────

type Health = {
  status: string;
  last_fetch: string;
  feed_age_seconds: number;
};

type ScheduledArrival = {
  station: string;
  stop_id: string;
  line: LineID;
  route_id: string;
  trip_id: string;
  direction: string;
  scheduled_time: string;
  time_to_arrival_seconds: number;
  time_to_arrival_human: string;
};

type ScheduledArrivalsResponse = {
  station: string;
  line: LineID;
  source: string;
  realtime: boolean;
  arrivals: ScheduledArrival[];
};

type RealtimeRoute = {
  id: string;
  service_type: string;
  source: string;
  active_vehicles: number;
};

type LineData = {
  line: LineID;
  data: ScheduledArrivalsResponse | null;
  error: string | null;
};

type ApiError = Error & { status?: number };
type LineID = "MA" | "MB" | "MB1" | "MC";

const LINE_IDS: LineID[] = ["MA", "MB", "MB1", "MC"];
const DEFAULT_API_URL = "http://localhost:8085";
const REFRESH_INTERVAL_MS = 30_000;

// ─── Line config ─────────────────────────────────────────────────────────────

const LINE_CONFIG: Record<LineID, { color: string; label: string }> = {
  MA: { color: "#C94B0C", label: "A" },
  MB: { color: "#00579A", label: "B" },
  MB1: { color: "#2E7DC8", label: "B1" },
  MC: { color: "#006B3C", label: "C" },
};

// ─── Known stations (per autocomplete) ──────────────────────────────────────

const METRO_STATIONS = [
  "Anagnina", "Arco di Travertino", "Barberini", "Basilica San Paolo",
  "Battistini", "Bologna", "Borghesiana", "Castro Pretorio", "Cinecittà",
  "Cipro", "Circo Massimo", "Colosseo", "EUR Fermi", "EUR Laurentina",
  "EUR Palasport", "Flaminio", "Garbatella", "Grotte Celoni", "Giulio Agricola",
  "Laurentina", "Lepanto", "Lucio Sestio", "Magliana",
  "Mirti", "Monti Tiburtini", "Numidio Quadrato",
  "Ottaviano", "Pantano", "Piramide", "Policlinico", "Ponte Lungo",
  "Ponte Mammolo", "Re di Roma", "Rebibbia", "Repubblica",
  "San Basilio", "San Giovanni", "San Paolo", "Santa Maria del Soccorso",
  "Spagna", "Subaugusta", "Termini", "Tiburtina",
  "Torre Gaia", "Torrenova", "Monte Compatri",
];

// ─── Palette ─────────────────────────────────────────────────────────────────

const p = {
  romanRed: "#8E1537",
  romanGold: "#F6C445",
  travertine: "#F5EFE0",
  ink: "#1A1816",
  muted: "#6B5E57",
  mutedLight: "#9B8D87",
  border: "#DDD4C2",
  panel: "#FFFCF6",
  success: "#176B4D",
  danger: "#B42318",
  white: "#FFFFFF",
  black: "#000000",
};

// ─── App ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [apiUrl, setApiUrl] = useState(DEFAULT_API_URL);
  const [showSettings, setShowSettings] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [activeStation, setActiveStation] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [lineData, setLineData] = useState<LineData[]>([]);
  const [realtimeRoutes, setRealtimeRoutes] = useState<RealtimeRoute[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [activeLineTab, setActiveLineTab] = useState<LineID>("MA");

  const baseUrl = useMemo(() => apiUrl.trim().replace(/\/+$/, ""), [apiUrl]);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchJson = useCallback(
    async <T,>(path: string): Promise<T> => {
      const response = await fetch(`${baseUrl}${path}`);
      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
          const body = (await response.json()) as { error?: string };
          if (body.error) message = body.error;
        } catch { /* keep HTTP fallback */ }
        const err = new Error(message) as ApiError;
        err.status = response.status;
        throw err;
      }
      return response.json() as Promise<T>;
    },
    [baseUrl],
  );

  // ── Suggestions ─────────────────────────────────────────────────────────

  const handleSearchChange = (text: string) => {
    setSearchText(text);
    if (text.trim().length < 2) {
      setSuggestions([]);
      return;
    }
    const q = text.toLowerCase();
    const matches = METRO_STATIONS.filter((s) => s.toLowerCase().includes(q)).slice(0, 6);
    setSuggestions(matches);
  };

  const selectStation = (name: string) => {
    setSearchText(name);
    setActiveStation(name);
    setSuggestions([]);
    setActiveLineTab("MA");
  };

  const clearStation = () => {
    setSearchText("");
    setActiveStation(null);
    setSuggestions([]);
    setLineData([]);
  };

  // ── Data fetch ──────────────────────────────────────────────────────────

  const fetchStationData = useCallback(
    async (station: string, mode: "initial" | "refresh" = "initial") => {
      if (mode === "initial") setIsLoading(true);
      else setIsRefreshing(true);

      const q = encodeURIComponent(station.trim());

      const [healthResult, ...lineResults] = await Promise.allSettled([
        fetchJson<Health>("/health"),
        ...LINE_IDS.map((line) =>
          fetchJson<ScheduledArrivalsResponse>(
            `/api/v1/scheduled/metro/arrivals?station=${q}&line=${line}&limit=6`,
          ),
        ),
        fetchJson<RealtimeRoute[]>("/api/v1/realtime/routes"),
      ]);

      if (healthResult.status === "fulfilled") setHealth(healthResult.value);

      const newLineData: LineData[] = LINE_IDS.map((line, idx) => {
        const result = lineResults[idx];
        if (result.status === "fulfilled") {
          return { line, data: result.value as ScheduledArrivalsResponse, error: null };
        }
        const err = result.reason as ApiError;
        if (err.status === 404) return { line, data: null, error: null };
        return { line, data: null, error: err.message };
      });
      setLineData(newLineData);

      const routesResult = lineResults[LINE_IDS.length];
      if (routesResult.status === "fulfilled") {
        const routes = (routesResult.value as RealtimeRoute[])
          .filter((r) => r.active_vehicles > 0)
          .sort((a, b) => b.active_vehicles - a.active_vehicles)
          .slice(0, 12);
        setRealtimeRoutes(routes);
      }

      setIsLoading(false);
      setIsRefreshing(false);
    },
    [fetchJson],
  );

  useEffect(() => {
    if (!activeStation) return;
    fetchStationData(activeStation, "initial");

    refreshTimer.current && clearInterval(refreshTimer.current);
    refreshTimer.current = setInterval(() => {
      fetchStationData(activeStation, "refresh");
    }, REFRESH_INTERVAL_MS);

    return () => {
      refreshTimer.current && clearInterval(refreshTimer.current);
    };
  }, [activeStation, fetchStationData]);

  // Fetch health on mount
  useEffect(() => {
    fetchJson<Health>("/health")
      .then(setHealth)
      .catch(() => {});
  }, [fetchJson]);

  // ── Derived ─────────────────────────────────────────────────────────────

  const activeLineArrivals = useMemo(() => {
    return lineData.find((d) => d.line === activeLineTab)?.data?.arrivals ?? [];
  }, [lineData, activeLineTab]);

  // Note: Go nil slice → JSON null, so arrivals can be null even when data is non-null

  const linesWithArrivals = useMemo(() => {
    return lineData.filter((d) => d.data && (d.data.arrivals?.length ?? 0) > 0).map((d) => d.line);
  }, [lineData]);

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={s.screen}>
      <StatusBar barStyle="light-content" backgroundColor={p.romanRed} />

      {/* Header */}
      <View style={s.header}>
        <View style={s.headerLeft}>
          <Text style={s.kicker}>Roma trasporto</Text>
          <Text style={s.title}>Cursus</Text>
        </View>
        <View style={s.headerRight}>
          <View style={[s.statusDot, health?.status === "ok" ? s.dotOk : s.dotDown]} />
          <Pressable
            onPress={() => setShowSettings(!showSettings)}
            style={({ pressed }) => [s.settingsBtn, pressed && s.pressed]}
          >
            <Text style={s.settingsIcon}>⚙</Text>
          </Pressable>
        </View>
      </View>

      {/* Settings panel */}
      {showSettings && (
        <View style={s.settingsPanel}>
          <Text style={s.settingsLabel}>Backend URL</Text>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={setApiUrl}
            placeholder="http://localhost:8085"
            placeholderTextColor={p.mutedLight}
            style={s.settingsInput}
            value={apiUrl}
          />
        </View>
      )}

      <ScrollView
        keyboardShouldPersistTaps="handled"
        style={s.scrollView}
        contentContainerStyle={s.content}
        refreshControl={
          activeStation
            ? <RefreshControl refreshing={isRefreshing} onRefresh={() => fetchStationData(activeStation, "refresh")} tintColor={p.romanRed} />
            : undefined
        }
      >
        {/* Search section */}
        <View style={s.searchContainer}>
          <View style={s.searchRow}>
            <View style={s.searchIcon}>
              <Text style={s.searchIconText}>🔍</Text>
            </View>
            <TextInput
              autoCapitalize="words"
              autoCorrect={false}
              onChangeText={handleSearchChange}
              onSubmitEditing={() => { if (searchText.trim()) selectStation(searchText.trim()); }}
              placeholder="Cerca stazione…"
              placeholderTextColor={p.mutedLight}
              returnKeyType="search"
              style={s.searchInput}
              value={searchText}
            />
            {searchText.length > 0 && (
              <Pressable onPress={clearStation} style={s.clearBtn}>
                <Text style={s.clearBtnText}>✕</Text>
              </Pressable>
            )}
          </View>

          {/* Suggestions dropdown */}
          {suggestions.length > 0 && (
            <View style={s.suggestions}>
              {suggestions.map((sug, i) => (
                <Pressable
                  key={sug}
                  onPress={() => selectStation(sug)}
                  style={({ pressed }) => [
                    s.suggestion,
                    i < suggestions.length - 1 && s.suggestionBorder,
                    pressed && s.pressed,
                  ]}
                >
                  <Text style={s.suggestionIcon}>🚇</Text>
                  <Text style={s.suggestionText}>{sug}</Text>
                </Pressable>
              ))}
            </View>
          )}
        </View>

        {/* Empty state */}
        {!activeStation && suggestions.length === 0 && (
          <View style={[s.emptyState, { minHeight: 400 }]}>
            <Text style={s.emptyStateEmoji}>🚇</Text>
            <Text style={s.emptyStateTitle}>Roma Metro</Text>
            <Text style={s.emptyStateSub}>Cerca una stazione per vedere gli orari</Text>
            <View style={s.quickStations}>
              {["Termini", "Spagna", "San Giovanni", "Tiburtina"].map((st) => (
                <Pressable
                  key={st}
                  onPress={() => selectStation(st)}
                  style={({ pressed }) => [s.quickBtn, pressed && s.pressed]}
                >
                  <Text style={s.quickBtnText}>{st}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}

        {/* Station view */}
        {activeStation && (
          <>
            {/* Station header */}
            <View style={s.stationHeader}>
              <View>
                <Text style={s.stationEyebrow}>Stazione</Text>
                <Text style={s.stationName}>{activeStation}</Text>
              </View>
              {isRefreshing && <ActivityIndicator color={p.romanRed} size="small" />}
            </View>

            {/* Lines with arrivals badges */}
            {linesWithArrivals.length > 0 && (
              <View style={s.linesBadgeRow}>
                <Text style={s.linesBadgeLabel}>Linee metro</Text>
                <View style={s.linesBadges}>
                  {linesWithArrivals.map((line) => (
                    <View key={line} style={[s.lineBadge, { backgroundColor: LINE_CONFIG[line].color }]}>
                      <Text style={s.lineBadgeText}>M{LINE_CONFIG[line].label}</Text>
                    </View>
                  ))}
                </View>
              </View>
            )}

            {/* Loading */}
            {isLoading && (
              <View style={s.loadingBox}>
                <ActivityIndicator color={p.romanRed} size="large" />
                <Text style={s.loadingText}>Carico orari…</Text>
              </View>
            )}

            {/* Metro line tabs + arrivals */}
            {!isLoading && (
              <>
                <View style={s.lineTabs}>
                  {LINE_IDS.map((line) => {
                    const cfg = LINE_CONFIG[line];
                    const count = lineData.find((d) => d.line === line)?.data?.arrivals?.length ?? 0;
                    const isActive = activeLineTab === line;
                    return (
                      <Pressable
                        key={line}
                        onPress={() => setActiveLineTab(line)}
                        style={({ pressed }) => [
                          s.lineTab,
                          isActive && { backgroundColor: cfg.color, borderColor: cfg.color },
                          pressed && s.pressed,
                        ]}
                      >
                        <Text style={[s.lineTabLabel, isActive && s.lineTabLabelActive]}>
                          M{cfg.label}
                        </Text>
                        {count > 0 ? (
                          <Text style={[s.lineTabCount, isActive && s.lineTabCountActive]}>
                            {count}
                          </Text>
                        ) : null}
                      </Pressable>
                    );
                  })}
                </View>

                <Text style={[s.sectionTitle, { borderLeftColor: LINE_CONFIG[activeLineTab].color }]}>
                  Metro {LINE_CONFIG[activeLineTab].label} · GTFS static
                </Text>

                {activeLineArrivals.length > 0 ? (
                  activeLineArrivals.map((arrival, i) => (
                    <ArrivalCard key={`${arrival.trip_id}-${arrival.stop_id}-${i}`} arrival={arrival} lineColor={LINE_CONFIG[activeLineTab].color} />
                  ))
                ) : (
                  <View style={s.noData}>
                    <Text style={s.noDataText}>Nessun arrivo trovato per la Linea {LINE_CONFIG[activeLineTab].label} a {activeStation}</Text>
                  </View>
                )}

                {/* Realtime surface section */}
                {realtimeRoutes.length > 0 && (
                  <>
                    <Text style={[s.sectionTitle, { borderLeftColor: p.muted, marginTop: 8 }]}>
                      Veicoli in circolazione (realtime)
                    </Text>
                    <Text style={s.sectionSub}>
                      Autobus e tram attivi su rete superficiale ATAC
                    </Text>
                    <View style={s.routeGrid}>
                      {realtimeRoutes.map((route) => (
                        <RouteChip key={route.id} route={route} />
                      ))}
                    </View>
                  </>
                )}
              </>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ArrivalCard({ arrival, lineColor }: { arrival: ScheduledArrival; lineColor: string }) {
  const mins = Math.round(arrival.time_to_arrival_seconds / 60);
  const urgent = mins <= 2;

  return (
    <View style={s.arrivalCard}>
      <View style={[s.arrivalAccent, { backgroundColor: lineColor }]} />
      <View style={s.arrivalLeft}>
        <Text style={s.arrivalTime}>{arrival.scheduled_time}</Text>
        <Text style={s.arrivalStop}>Stop {arrival.stop_id}</Text>
      </View>
      <View style={s.arrivalCenter}>
        <Text style={s.arrivalDirection} numberOfLines={1}>{arrival.direction || "—"}</Text>
        <Text style={s.arrivalTripId} numberOfLines={1}>Trip {arrival.trip_id}</Text>
      </View>
      <View style={[s.arrivalEta, urgent && s.arrivalEtaUrgent]}>
        <Text style={[s.arrivalEtaText, urgent && s.arrivalEtaTextUrgent]}>
          {arrival.time_to_arrival_human}
        </Text>
      </View>
    </View>
  );
}

function RouteChip({ route }: { route: RealtimeRoute }) {
  return (
    <View style={s.routeChip}>
      <Text style={s.routeChipId}>{route.id}</Text>
      <Text style={s.routeChipCount}>{route.active_vehicles} 🚌</Text>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: p.travertine,
  },

  // Header
  header: {
    alignItems: "center",
    backgroundColor: p.romanRed,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 16,
    paddingTop: 16,
  },
  headerLeft: {},
  headerRight: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
  },
  kicker: {
    color: p.romanGold,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  title: {
    color: p.white,
    fontSize: 28,
    fontWeight: "800",
    marginTop: 1,
  },
  statusDot: {
    borderRadius: 999,
    height: 10,
    width: 10,
  },
  dotOk: { backgroundColor: "#4ADE80" },
  dotDown: { backgroundColor: "#F87171" },
  settingsBtn: {
    padding: 4,
  },
  settingsIcon: { color: p.romanGold, fontSize: 20 },

  // Settings
  settingsPanel: {
    backgroundColor: "#7A1030",
    paddingHorizontal: 20,
    paddingVertical: 12,
    gap: 6,
  },
  settingsLabel: {
    color: "rgba(255,255,255,0.6)",
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  settingsInput: {
    backgroundColor: "rgba(255,255,255,0.12)",
    borderRadius: 8,
    color: p.white,
    fontSize: 14,
    minHeight: 40,
    paddingHorizontal: 12,
  },

  scrollView: {
    flex: 1,
  },

  // Content
  content: {
    gap: 14,
    padding: 16,
    paddingBottom: 40,
  },

  // Search
  searchContainer: {
    zIndex: 10,
  },
  searchRow: {
    alignItems: "center",
    backgroundColor: p.white,
    borderColor: p.border,
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: "row",
    gap: 8,
    minHeight: 52,
    paddingHorizontal: 12,
    shadowColor: p.black,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  searchIcon: {
    width: 24,
  },
  searchIconText: { fontSize: 16 },
  searchInput: {
    color: p.ink,
    flex: 1,
    fontSize: 17,
    fontWeight: "500",
    minHeight: 52,
  },
  clearBtn: {
    alignItems: "center",
    justifyContent: "center",
    padding: 4,
    width: 28,
  },
  clearBtnText: {
    color: p.muted,
    fontSize: 16,
    fontWeight: "700",
  },
  suggestions: {
    backgroundColor: p.white,
    borderColor: p.border,
    borderRadius: 12,
    borderWidth: 1,
    marginTop: 4,
    overflow: "hidden",
    shadowColor: p.black,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 4,
  },
  suggestion: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  suggestionBorder: {
    borderBottomColor: p.border,
    borderBottomWidth: 1,
  },
  suggestionIcon: { fontSize: 16 },
  suggestionText: {
    color: p.ink,
    fontSize: 16,
    fontWeight: "500",
  },

  // Empty state
  emptyState: {
    alignItems: "center",
    gap: 8,
    justifyContent: "center",
    paddingTop: 60,
    paddingBottom: 60,
  },
  emptyStateEmoji: { fontSize: 56 },
  emptyStateTitle: {
    color: p.ink,
    fontSize: 22,
    fontWeight: "800",
    marginTop: 8,
  },
  emptyStateSub: {
    color: p.muted,
    fontSize: 15,
    textAlign: "center",
  },
  quickStations: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    justifyContent: "center",
    marginTop: 16,
  },
  quickBtn: {
    backgroundColor: p.white,
    borderColor: p.border,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  quickBtnText: {
    color: p.ink,
    fontSize: 14,
    fontWeight: "600",
  },

  // Station view
  stationHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 2,
  },
  stationEyebrow: {
    color: p.muted,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  stationName: {
    color: p.romanRed,
    fontSize: 30,
    fontWeight: "900",
    letterSpacing: -0.5,
    marginTop: 2,
  },
  linesBadgeRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
  },
  linesBadgeLabel: {
    color: p.muted,
    fontSize: 12,
    fontWeight: "700",
  },
  linesBadges: {
    flexDirection: "row",
    gap: 6,
  },
  lineBadge: {
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  lineBadgeText: {
    color: p.white,
    fontSize: 12,
    fontWeight: "800",
  },

  // Loading
  loadingBox: {
    alignItems: "center",
    backgroundColor: p.panel,
    borderColor: p.border,
    borderRadius: 12,
    borderWidth: 1,
    gap: 12,
    padding: 32,
  },
  loadingText: {
    color: p.muted,
    fontSize: 15,
  },

  // Line tabs
  lineTabs: {
    flexDirection: "row",
    gap: 8,
  },
  lineTab: {
    alignItems: "center",
    backgroundColor: p.white,
    borderColor: p.border,
    borderRadius: 10,
    borderWidth: 1.5,
    flex: 1,
    gap: 4,
    minHeight: 48,
    justifyContent: "center",
  },
  lineTabLabel: {
    color: p.ink,
    fontSize: 13,
    fontWeight: "800",
  },
  lineTabLabelActive: {
    color: p.white,
  },
  lineTabCount: {
    color: p.muted,
    fontSize: 11,
    fontWeight: "700",
  },
  lineTabCountActive: {
    color: "rgba(255,255,255,0.75)",
  },

  // Section titles
  sectionTitle: {
    borderLeftWidth: 3,
    color: p.ink,
    fontSize: 15,
    fontWeight: "800",
    paddingLeft: 10,
  },
  sectionSub: {
    color: p.muted,
    fontSize: 13,
    marginTop: -8,
    paddingLeft: 13,
  },

  // Arrival cards
  arrivalCard: {
    alignItems: "center",
    backgroundColor: p.panel,
    borderColor: p.border,
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: "row",
    gap: 0,
    overflow: "hidden",
    paddingRight: 12,
  },
  arrivalAccent: {
    alignSelf: "stretch",
    marginRight: 12,
    width: 4,
  },
  arrivalLeft: {
    gap: 3,
    paddingVertical: 12,
    width: 54,
  },
  arrivalTime: {
    color: p.ink,
    fontSize: 17,
    fontWeight: "900",
  },
  arrivalStop: {
    color: p.mutedLight,
    fontSize: 11,
    fontWeight: "600",
  },
  arrivalCenter: {
    flex: 1,
    gap: 3,
    paddingVertical: 12,
  },
  arrivalDirection: {
    color: p.ink,
    fontSize: 14,
    fontWeight: "700",
  },
  arrivalTripId: {
    color: p.mutedLight,
    fontSize: 11,
  },
  arrivalEta: {
    backgroundColor: "#F0F0F0",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  arrivalEtaUrgent: {
    backgroundColor: "#FEF3C7",
  },
  arrivalEtaText: {
    color: p.muted,
    fontSize: 13,
    fontWeight: "800",
  },
  arrivalEtaTextUrgent: {
    color: "#92400E",
  },

  // No data
  noData: {
    backgroundColor: p.panel,
    borderColor: p.border,
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
  },
  noDataText: {
    color: p.muted,
    fontSize: 14,
    lineHeight: 20,
  },

  // Route chips
  routeGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  routeChip: {
    alignItems: "center",
    backgroundColor: p.white,
    borderColor: p.border,
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  routeChipId: {
    color: p.ink,
    fontSize: 14,
    fontWeight: "800",
    minWidth: 24,
  },
  routeChipCount: {
    color: p.muted,
    fontSize: 12,
  },

  // Shared
  pressed: {
    opacity: 0.7,
  },
});
