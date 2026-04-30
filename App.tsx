import AsyncStorage from "@react-native-async-storage/async-storage";
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
  arrivals: ScheduledArrival[] | null;
};

type SurfaceScheduledArrival = {
  stop_id: string;
  route_id: string;
  trip_id: string;
  direction: string;
  scheduled_time: string;
  time_to_arrival_seconds: number;
  time_to_arrival_human: string;
};

type SurfaceArrivalsResponse = {
  station: string;
  source: string;
  arrivals: SurfaceScheduledArrival[];
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
const RECENT_STATIONS_KEY = "cursus:recent_stations";
const MAX_RECENT = 4;

// ─── Config ───────────────────────────────────────────────────────────────────

const LINE_CONFIG: Record<LineID, { color: string; label: string }> = {
  MA: { color: "#C94B0C", label: "A" },
  MB: { color: "#00579A", label: "B" },
  MB1: { color: "#2E7DC8", label: "B1" },
  MC: { color: "#006B3C", label: "C" },
};

// Stations where multiple metro lines meet
const STATION_LINES: Record<string, LineID[]> = {
  Termini: ["MA", "MB", "MB1"],
  "S. Giovanni": ["MA", "MC"],
  "San Giovanni": ["MA", "MC"],
  Bologna: ["MB", "MB1"],
  Colosseo: ["MB", "MB1", "MC"],
  "Colosseo/Fori Imperiali": ["MB", "MB1", "MC"],
};

function interchangeLines(stationName: string, currentLine: LineID): LineID[] {
  return (STATION_LINES[stationName] ?? []).filter((l) => l !== currentLine);
}

// ─── Palette ─────────────────────────────────────────────────────────────────

const p = {
  romanRed: "#8E1537",
  romanRedDark: "#6B0F29",
  romanGold: "#F6C445",
  travertine: "#F2EAD8",
  travertineDark: "#E8DEC8",
  ink: "#1A1816",
  dim: "#3D342F",
  muted: "#6B5E57",
  mutedLight: "#9B8D87",
  border: "#D8CCBA",
  borderLight: "#EAE2D2",
  panel: "#FDFAF4",
  white: "#FFFFFF",
  black: "#000000",
  urgentBg: "#FEF3C7",
  urgentText: "#92400E",
  goneBg: "#EFEFEF",
  goneText: "#AEAEAE",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatEta(seconds: number): string {
  if (seconds <= 30) return "ora";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
  }
  return s > 0 ? `${m}m ${s}s` : `${m} min`;
}

function formatAge(seconds: number): string {
  if (seconds < 10) return "adesso";
  if (seconds < 60) return `${Math.round(seconds)}s fa`;
  return `${Math.floor(seconds / 60)}m fa`;
}

// ─── App ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [apiUrl, setApiUrl] = useState(DEFAULT_API_URL);
  const [showSettings, setShowSettings] = useState(false);

  // ── Navigation state ─────────────────────────────────────────────────────
  const [selectedLine, setSelectedLine] = useState<LineID | null>(null);
  const [lineStations, setLineStations] = useState<string[]>([]);
  const [isLoadingStations, setIsLoadingStations] = useState(false);
  const [activeStation, setActiveStation] = useState<string | null>(null);

  // ── Data state ───────────────────────────────────────────────────────────
  const [health, setHealth] = useState<Health | null>(null);
  const [lineData, setLineData] = useState<LineData[]>([]);
  const [surfaceArrivals, setSurfaceArrivals] = useState<SurfaceScheduledArrival[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [tickNow, setTickNow] = useState(0);
  const [recentStations, setRecentStations] = useState<string[]>([]);
  const [showSurface, setShowSurface] = useState(false);

  const baseUrl = useMemo(() => apiUrl.trim().replace(/\/+$/, ""), [apiUrl]);
  const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Tick every second for live countdown ────────────────────────────────

  useEffect(() => {
    tickTimer.current = setInterval(() => setTickNow((n) => n + 1), 1000);
    return () => { tickTimer.current && clearInterval(tickTimer.current); };
  }, []);

  useEffect(() => {
    AsyncStorage.getItem(RECENT_STATIONS_KEY).then((raw) => {
      if (raw) setRecentStations(JSON.parse(raw) as string[]);
    }).catch(() => {});
  }, []);

  // ── Fetch helpers ────────────────────────────────────────────────────────

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

  // ── Navigation functions ─────────────────────────────────────────────────

  const selectLine = async (line: LineID) => {
    setSelectedLine(line);
    setLineStations([]);
    setIsLoadingStations(true);
    try {
      const data = await fetchJson<{ line: string; stations: string[] }>(
        `/api/v1/scheduled/metro/stations?line=${line}`
      );
      setLineStations(data.stations ?? []);
    } catch {
      setLineStations([]);
    } finally {
      setIsLoadingStations(false);
    }
  };

  const selectStation = (name: string) => {
    setActiveStation(name);
    setLineData([]);
    setSurfaceArrivals([]);
    setShowSurface(false);
    setRecentStations((prev) => {
      const updated = [name, ...prev.filter((s) => s !== name)].slice(0, MAX_RECENT);
      AsyncStorage.setItem(RECENT_STATIONS_KEY, JSON.stringify(updated)).catch(() => {});
      return updated;
    });
  };

  const goBack = () => {
    if (activeStation) {
      // arrivals → station list
      setActiveStation(null);
      setLineData([]);
      setSurfaceArrivals([]);
      setShowSurface(false);
      setLastUpdated(null);
    } else {
      // station list → line picker
      setSelectedLine(null);
      setLineStations([]);
    }
  };

  // ── Data fetch ───────────────────────────────────────────────────────────

  const fetchStationData = useCallback(
    async (station: string, mode: "initial" | "refresh" = "initial") => {
      if (mode === "initial") setIsLoading(true);
      else setIsRefreshing(true);

      const q = encodeURIComponent(station.trim());

      const [healthResult, surfaceResult, ...lineResults] = await Promise.allSettled([
        fetchJson<Health>("/health"),
        fetchJson<SurfaceArrivalsResponse>(`/api/v1/scheduled/surface-arrivals?station=${q}&limit=8`),
        ...LINE_IDS.map((line) =>
          fetchJson<ScheduledArrivalsResponse>(
            `/api/v1/scheduled/metro/arrivals?station=${q}&line=${line}&limit=6`,
          ),
        ),
      ]);

      if (healthResult.status === "fulfilled") setHealth(healthResult.value);

      if (surfaceResult.status === "fulfilled") {
        setSurfaceArrivals(surfaceResult.value.arrivals ?? []);
      }

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

      setLastUpdated(Date.now());
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
    return () => { refreshTimer.current && clearInterval(refreshTimer.current); };
  }, [activeStation, fetchStationData]);

  useEffect(() => {
    fetchJson<Health>("/health").then(setHealth).catch(() => {});
  }, [fetchJson]);

  // ── Derived ──────────────────────────────────────────────────────────────

  const imminentArrivals = useMemo(() => {
    void tickNow;
    const el = lastUpdated ? Math.floor((Date.now() - lastUpdated) / 1000) : 0;
    const all: (ScheduledArrival & { _remaining: number; _line: LineID })[] = [];
    for (const ld of lineData) {
      for (const a of ld.data?.arrivals ?? []) {
        const remaining = Math.max(0, a.time_to_arrival_seconds - el);
        if (remaining < 3600) all.push({ ...a, _remaining: remaining, _line: ld.line });
      }
    }
    return all.sort((a, b) => a._remaining - b._remaining).slice(0, 8);
  }, [lineData, tickNow, lastUpdated]);

  const surfaceArrivalsLive = useMemo(() => {
    void tickNow;
    const el = lastUpdated ? Math.floor((Date.now() - lastUpdated) / 1000) : 0;
    return surfaceArrivals.map((a) => ({
      ...a,
      _remaining: Math.max(0, a.time_to_arrival_seconds - el),
    }));
  }, [surfaceArrivals, tickNow, lastUpdated]);

  const ageSec = lastUpdated ? (Date.now() - lastUpdated) / 1000 : null;

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={s.screen}>
      <StatusBar barStyle="light-content" backgroundColor={p.romanRed} />

      <View style={s.header}>
        <View>
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
        {/* ── Line picker (selectedLine == null) ── */}
        {selectedLine === null && (
          <View style={s.linePickerScreen}>
            <Text style={s.linePickerTitle}>Seleziona la linea</Text>
            <View style={s.lineGrid}>
              {(["MA", "MB", "MB1", "MC"] as LineID[]).map((line) => (
                <Pressable
                  key={line}
                  onPress={() => selectLine(line)}
                  style={({ pressed }) => [s.lineCard, { backgroundColor: LINE_CONFIG[line].color }, pressed && s.pressed]}
                >
                  <Text style={s.lineCardLetter}>M{LINE_CONFIG[line].label}</Text>
                  <Text style={s.lineCardSub}>Linea {LINE_CONFIG[line].label}</Text>
                </Pressable>
              ))}
            </View>
            {recentStations.length > 0 && (
              <>
                <Text style={s.quickLabel}>RECENTI</Text>
                <View style={s.quickRow}>
                  {recentStations.map((st) => (
                    <Pressable key={st} onPress={() => selectStation(st)} style={({ pressed }) => [s.quickBtn, pressed && s.pressed]}>
                      <Text style={s.quickBtnText}>{st}</Text>
                    </Pressable>
                  ))}
                </View>
              </>
            )}
          </View>
        )}

        {/* ── Station list (selectedLine != null && activeStation == null) ── */}
        {selectedLine !== null && activeStation === null && (
          <>
            {/* breadcrumb */}
            <Pressable onPress={goBack} style={({ pressed }) => [s.breadcrumb, pressed && s.pressed]}>
              <Text style={s.breadcrumbBack}>←</Text>
              <View style={[s.breadcrumbPill, { backgroundColor: LINE_CONFIG[selectedLine].color }]}>
                <Text style={s.breadcrumbPillText}>M{LINE_CONFIG[selectedLine].label}</Text>
              </View>
              <Text style={s.breadcrumbLabel}>Linea {LINE_CONFIG[selectedLine].label}</Text>
            </Pressable>
            {isLoadingStations ? (
              <View style={s.loadingBox}>
                <ActivityIndicator color={LINE_CONFIG[selectedLine].color} size="large" />
              </View>
            ) : (
              <View style={s.metroMap}>
                {lineStations.map((st, i) => {
                  const isFirst = i === 0;
                  const isLast = i === lineStations.length - 1;
                  const isTerminus = isFirst || isLast;
                  const otherLines = interchangeLines(st, selectedLine!);
                  const isInterchange = otherLines.length > 0;
                  const lineColor = LINE_CONFIG[selectedLine!].color;
                  return (
                    <View key={st} style={s.metroRow}>
                      <View style={s.trackCol}>
                        <View style={[s.trackSeg, { backgroundColor: isFirst ? "transparent" : lineColor }]} />
                        <View style={[
                          s.trackDot,
                          (isTerminus || isInterchange)
                            ? { width: 18, height: 18, borderRadius: 9, backgroundColor: lineColor, borderWidth: 0 }
                            : { borderColor: lineColor },
                        ]} />
                        <View style={[s.trackSeg, { backgroundColor: isLast ? "transparent" : lineColor }]} />
                      </View>
                      <View style={s.metroStationArea}>
                        <Pressable
                          onPress={() => selectStation(st)}
                          style={({ pressed }) => [pressed && s.pressed]}
                        >
                          <Text style={[s.metroStationName, (isTerminus || isInterchange) && s.metroStationNameBold]}>
                            {st}
                          </Text>
                        </Pressable>
                        {isInterchange && (
                          <View style={s.metroInterchangeRow}>
                            {otherLines.map((ol) => (
                              <Pressable
                                key={ol}
                                onPress={() => selectLine(ol)}
                                style={({ pressed }) => [
                                  s.interchangePill,
                                  { backgroundColor: LINE_CONFIG[ol].color },
                                  pressed && s.pressed,
                                ]}
                              >
                                <Text style={s.interchangePillText}>M{LINE_CONFIG[ol].label}</Text>
                              </Pressable>
                            ))}
                          </View>
                        )}
                      </View>
                    </View>
                  );
                })}
              </View>
            )}
          </>
        )}

        {/* ── Arrivals (activeStation != null) ── */}
        {activeStation !== null && (
          <>
            {/* breadcrumb */}
            <Pressable onPress={goBack} style={({ pressed }) => [s.breadcrumb, pressed && s.pressed]}>
              <Text style={s.breadcrumbBack}>←</Text>
              {selectedLine && (
                <View style={[s.breadcrumbPill, { backgroundColor: LINE_CONFIG[selectedLine].color }]}>
                  <Text style={s.breadcrumbPillText}>M{LINE_CONFIG[selectedLine].label}</Text>
                </View>
              )}
              <Text style={s.breadcrumbLabel}>{selectedLine ? `Linea ${LINE_CONFIG[selectedLine].label}` : "Stazioni"}</Text>
            </Pressable>

            {/* Station header */}
            <View style={s.stationCard}>
              <View style={s.stationCardLeft}>
                <Text style={s.stationEyebrow}>STAZIONE</Text>
                <Text style={s.stationName}>{activeStation}</Text>
              </View>
              <View style={s.stationCardRight}>
                {ageSec !== null && (
                  <Text style={s.ageText}>{formatAge(ageSec)}</Text>
                )}
                <Pressable
                  onPress={() => fetchStationData(activeStation, "refresh")}
                  style={({ pressed }) => [s.refreshBtn, pressed && s.pressed]}
                  disabled={isRefreshing}
                >
                  {isRefreshing
                    ? <ActivityIndicator color={p.romanRed} size="small" />
                    : <Text style={s.refreshBtnText}>↻</Text>
                  }
                </Pressable>
              </View>
            </View>

            {/* Loading */}
            {isLoading && (
              <View style={s.loadingBox}>
                <ActivityIndicator color={p.romanRed} size="large" />
                <Text style={s.loadingText}>Carico orari…</Text>
              </View>
            )}

            {/* Metro tabs + arrivals */}
            {!isLoading && (
              <>
                {/* Prossimi arrivi — cross-line board */}
                {imminentArrivals.length > 0 && (
                  <View style={s.boardCard}>
                    <View style={s.boardCardHeader}>
                      <Text style={s.boardCardHeaderText}>PROSSIMI ARRIVI</Text>
                      <View style={s.livePill}>
                        <View style={s.liveDot} />
                        <Text style={s.livePillText}>live</Text>
                      </View>
                    </View>
                    {imminentArrivals.map((a, i) => (
                      <BoardRow
                        key={`${a.trip_id}-${a.stop_id}-${i}`}
                        arrival={a}
                        lineId={a._line}
                        remaining={a._remaining}
                        last={i === imminentArrivals.length - 1}
                      />
                    ))}
                  </View>
                )}

                {/* Surface transit scheduled departures — collapsible */}
                {surfaceArrivalsLive.length > 0 && (
                  <View style={s.surfaceCard}>
                    <Pressable
                      onPress={() => setShowSurface((v) => !v)}
                      style={({ pressed }) => [s.surfaceCardHeader, pressed && s.pressed]}
                    >
                      <Text style={s.surfaceCardHeaderText}>SUPERFICIE</Text>
                      <View style={s.surfaceCardHeaderRight}>
                        <Text style={s.surfaceCount}>{surfaceArrivalsLive.length}</Text>
                        <Text style={s.surfaceChevron}>{showSurface ? "▲" : "▼"}</Text>
                      </View>
                    </Pressable>
                    {showSurface && (
                      <>
                        {surfaceArrivalsLive.map((a, i) => (
                          <SurfaceBoardRow
                            key={`${a.trip_id}-${a.stop_id}-${i}`}
                            arrival={a}
                            remaining={a._remaining}
                            last={i === surfaceArrivalsLive.length - 1}
                          />
                        ))}
                      </>
                    )}
                  </View>
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

function BoardRow({
  arrival, lineId, remaining, last,
}: {
  arrival: ScheduledArrival;
  lineId: LineID;
  remaining: number;
  last: boolean;
}) {
  const cfg = LINE_CONFIG[lineId];
  const urgent = remaining <= 120;
  const gone = remaining === 0;
  return (
    <View style={[s.boardRow, !last && s.boardRowBorder]}>
      <View style={s.boardLeft}>
        <View style={s.boardTopLine}>
          <View style={[s.boardLineBadge, { backgroundColor: cfg.color }]}>
            <Text style={s.boardLineBadgeText}>M{cfg.label}</Text>
          </View>
          <Text style={s.boardTime}>{arrival.scheduled_time}</Text>
          <View style={s.platformBadge}>
            <Text style={s.platformBadgeText}>{arrival.stop_id}</Text>
          </View>
        </View>
        <Text style={s.boardDirection} numberOfLines={1}>{arrival.direction || "—"}</Text>
      </View>
      <View style={[s.boardEta, urgent && !gone && s.boardEtaUrgent, gone && s.boardEtaGone]}>
        <Text style={[s.boardEtaText, urgent && !gone && s.boardEtaTextUrgent, gone && s.boardEtaTextGone]}>
          {formatEta(remaining)}
        </Text>
      </View>
    </View>
  );
}

function SurfaceBoardRow({
  arrival, remaining, last,
}: {
  arrival: SurfaceScheduledArrival;
  remaining: number;
  last: boolean;
}) {
  const urgent = remaining <= 120;
  const gone = remaining === 0;
  return (
    <View style={[s.boardRow, !last && s.boardRowBorder]}>
      <View style={s.boardLeft}>
        <View style={s.boardTopLine}>
          <View style={s.surfaceRouteBadge}>
            <Text style={s.surfaceRouteBadgeText}>{arrival.route_id}</Text>
          </View>
          <Text style={s.boardTime}>{arrival.scheduled_time}</Text>
        </View>
        <Text style={s.boardDirection} numberOfLines={1}>{arrival.direction || "—"}</Text>
      </View>
      <View style={[s.boardEta, urgent && !gone && s.boardEtaUrgent, gone && s.boardEtaGone]}>
        <Text style={[s.boardEtaText, urgent && !gone && s.boardEtaTextUrgent, gone && s.boardEtaTextGone]}>
          {formatEta(remaining)}
        </Text>
      </View>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: p.travertine },

  // ── Header ──────────────────────────────────────────────────────────────────
  header: {
    alignItems: "center",
    backgroundColor: p.romanRed,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 14,
    shadowColor: p.black,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 6,
    elevation: 4,
  },
  headerRight: { alignItems: "center", flexDirection: "row", gap: 12 },
  kicker: { color: p.romanGold, fontSize: 10, fontWeight: "700", letterSpacing: 1.5, textTransform: "uppercase" },
  title: { color: p.white, fontSize: 26, fontWeight: "900", letterSpacing: -0.5, marginTop: 1 },
  statusDot: { borderRadius: 999, height: 8, width: 8 },
  dotOk: { backgroundColor: "#4ADE80" },
  dotDown: { backgroundColor: "#F87171" },
  settingsBtn: { alignItems: "center", justifyContent: "center", padding: 6 },
  settingsIcon: { color: "rgba(255,255,255,0.55)", fontSize: 18 },

  settingsPanel: { backgroundColor: p.romanRedDark, paddingHorizontal: 20, paddingVertical: 14, gap: 8 },
  settingsLabel: { color: "rgba(255,255,255,0.5)", fontSize: 10, fontWeight: "700", textTransform: "uppercase", letterSpacing: 1 },
  settingsInput: { backgroundColor: "rgba(255,255,255,0.1)", borderRadius: 8, borderWidth: 1, borderColor: "rgba(255,255,255,0.15)", color: p.white, fontSize: 14, minHeight: 42, paddingHorizontal: 12 },

  scrollView: { flex: 1 },
  content: { gap: 12, padding: 16, paddingBottom: 48 },

  // ── Line picker ─────────────────────────────────────────────────────────────
  linePickerScreen: { gap: 20, paddingTop: 8 },
  linePickerTitle: { color: p.dim, fontSize: 13, fontWeight: "700", letterSpacing: 0.5, textTransform: "uppercase" },
  lineGrid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  lineCard: {
    alignItems: "center", borderRadius: 16, flex: 1, justifyContent: "center",
    minHeight: 100, minWidth: "45%", gap: 4,
    shadowColor: p.black, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.15, shadowRadius: 8, elevation: 4,
  },
  lineCardLetter: { color: p.white, fontSize: 32, fontWeight: "900", letterSpacing: -1 },
  lineCardSub: { color: "rgba(255,255,255,0.75)", fontSize: 11, fontWeight: "700", letterSpacing: 0.5 },

  // ── Quick access (recenti) ───────────────────────────────────────────────────
  quickLabel: { color: p.mutedLight, fontSize: 10, fontWeight: "700", letterSpacing: 1.2, textTransform: "uppercase" },
  quickRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  quickBtn: {
    backgroundColor: p.white, borderColor: p.border, borderRadius: 999, borderWidth: 1,
    paddingHorizontal: 18, paddingVertical: 10,
    shadowColor: p.ink, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 3, elevation: 1,
  },
  quickBtnText: { color: p.dim, fontSize: 14, fontWeight: "600" },

  // ── Breadcrumb nav ──────────────────────────────────────────────────────────
  breadcrumb: { alignItems: "center", flexDirection: "row", gap: 8, paddingVertical: 2 },
  breadcrumbBack: { color: p.muted, fontSize: 20, fontWeight: "300" },
  breadcrumbPill: { borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3 },
  breadcrumbPillText: { color: p.white, fontSize: 11, fontWeight: "900" },
  breadcrumbLabel: { color: p.dim, fontSize: 14, fontWeight: "600" },

  // ── Metro map (station diagram) ───────────────────────────────────────────────
  metroMap: { paddingLeft: 4, paddingRight: 8 },
  metroRow: { alignItems: "stretch", flexDirection: "row", minHeight: 56 },
  trackCol: { alignItems: "center", width: 36 },
  trackSeg: { flex: 1, width: 3 },
  trackDot: { backgroundColor: p.white, borderRadius: 7, borderWidth: 2.5, height: 14, width: 14 },
  metroStationArea: { flex: 1, justifyContent: "center", paddingLeft: 8, paddingVertical: 8 },
  metroStationName: { color: p.ink, fontSize: 15, fontWeight: "500" },
  metroStationNameBold: { fontWeight: "700" },
  metroInterchangeRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 5 },
  interchangePill: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  interchangePillText: { color: p.white, fontSize: 10, fontWeight: "900", letterSpacing: 0.3 },

  // ── Station card ────────────────────────────────────────────────────────────
  stationCard: {
    alignItems: "center", backgroundColor: p.panel, borderColor: p.border,
    borderRadius: 14, borderWidth: 1, flexDirection: "row",
    justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 14,
    shadowColor: p.ink, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 4, elevation: 2,
  },
  stationCardLeft: { flex: 1 },
  stationCardRight: { alignItems: "flex-end", gap: 6 },
  stationEyebrow: { color: p.mutedLight, fontSize: 10, fontWeight: "700", letterSpacing: 1.2, textTransform: "uppercase" },
  stationName: { color: p.romanRed, fontSize: 28, fontWeight: "900", letterSpacing: -0.5, marginTop: 2 },
  ageText: { color: p.mutedLight, fontSize: 11 },
  refreshBtn: {
    alignItems: "center", backgroundColor: p.travertineDark,
    borderRadius: 999, height: 34, justifyContent: "center", width: 34,
  },
  refreshBtnText: { color: p.romanRed, fontSize: 18, fontWeight: "700" },

  // ── Loading ─────────────────────────────────────────────────────────────────
  loadingBox: { alignItems: "center", gap: 10, paddingVertical: 40 },
  loadingText: { color: p.mutedLight, fontSize: 14, letterSpacing: 0.3 },

  // ── Metro departure board ───────────────────────────────────────────────────
  boardCard: {
    backgroundColor: p.panel, borderColor: p.border,
    borderRadius: 14, borderWidth: 1, overflow: "hidden",
    shadowColor: p.ink, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8, elevation: 3,
  },
  boardCardHeader: {
    alignItems: "center", backgroundColor: p.romanRed,
    flexDirection: "row", justifyContent: "space-between",
    paddingHorizontal: 14, paddingVertical: 10,
  },
  boardCardHeaderText: { color: "rgba(255,255,255,0.9)", fontSize: 10, fontWeight: "800", letterSpacing: 1.5 },
  livePill: { alignItems: "center", backgroundColor: "rgba(255,255,255,0.15)", borderRadius: 999, flexDirection: "row", gap: 5, paddingHorizontal: 8, paddingVertical: 3 },
  liveDot: { backgroundColor: "#4ADE80", borderRadius: 999, height: 6, width: 6 },
  livePillText: { color: "rgba(255,255,255,0.9)", fontSize: 10, fontWeight: "700" },
  boardRow: {
    alignItems: "center", flexDirection: "row", gap: 12,
    paddingHorizontal: 14, paddingVertical: 14,
  },
  boardRowBorder: { borderBottomColor: p.borderLight, borderBottomWidth: 1 },
  boardLeft: { flex: 1, gap: 4 },
  boardTopLine: { alignItems: "center", flexDirection: "row", gap: 8 },
  boardLineBadge: {
    alignItems: "center", borderRadius: 6,
    paddingHorizontal: 7, paddingVertical: 3, minWidth: 32,
  },
  boardLineBadgeText: { color: p.white, fontSize: 10, fontWeight: "900", letterSpacing: 0.3 },
  boardTime: { color: p.ink, fontSize: 21, fontWeight: "900", letterSpacing: -0.5 },
  boardDirection: { color: p.dim, fontSize: 13, fontWeight: "500", letterSpacing: 0.1 },
  platformBadge: { backgroundColor: p.travertineDark, borderRadius: 5, borderWidth: 1, borderColor: p.border, paddingHorizontal: 6, paddingVertical: 2 },
  platformBadgeText: { color: p.mutedLight, fontSize: 10, fontWeight: "700", letterSpacing: 0.5 },
  boardEta: {
    alignItems: "center", backgroundColor: p.travertineDark,
    borderRadius: 10, minWidth: 64, paddingHorizontal: 10, paddingVertical: 8,
  },
  boardEtaUrgent: { backgroundColor: p.urgentBg },
  boardEtaGone: { backgroundColor: p.goneBg },
  boardEtaText: { color: p.muted, fontSize: 14, fontWeight: "800" },
  boardEtaTextUrgent: { color: p.urgentText },
  boardEtaTextGone: { color: p.goneText },

  // ── Surface departure card ──────────────────────────────────────────────────
  surfaceCard: {
    backgroundColor: p.panel, borderColor: p.border,
    borderRadius: 14, borderWidth: 1, overflow: "hidden",
    shadowColor: p.ink, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8, elevation: 3,
  },
  surfaceCardHeader: {
    alignItems: "center", backgroundColor: p.travertineDark,
    flexDirection: "row", justifyContent: "space-between",
    paddingHorizontal: 14, paddingVertical: 12,
  },
  surfaceCardHeaderText: { color: p.dim, fontSize: 10, fontWeight: "800", letterSpacing: 1.5 },
  surfaceCardHeaderRight: { alignItems: "center", flexDirection: "row", gap: 8 },
  surfaceCount: { backgroundColor: p.border, borderRadius: 999, color: p.muted, fontSize: 11, fontWeight: "700", minWidth: 22, paddingHorizontal: 6, paddingVertical: 1, textAlign: "center" },
  surfaceChevron: { color: p.mutedLight, fontSize: 10, fontWeight: "700" },

  // Surface route badge
  surfaceRouteBadge: {
    alignItems: "center", backgroundColor: p.dim,
    borderRadius: 6, minWidth: 32, paddingHorizontal: 7, paddingVertical: 3,
  },
  surfaceRouteBadgeText: { color: p.white, fontSize: 10, fontWeight: "900", letterSpacing: 0.3 },

  pressed: { opacity: 0.65 },
});
