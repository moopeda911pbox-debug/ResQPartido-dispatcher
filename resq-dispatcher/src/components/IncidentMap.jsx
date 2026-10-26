import React, { useEffect, useRef, useState } from "react";
import L from "leaflet";
import { reverseGeocode } from "../lib/geocode";
import { useCall } from "../context/CallContext";
import { fetchRoute } from "../lib/routing";
import { STATUS } from "../services/incidents";
import { svgIcon, incidentIcon } from "../lib/popupIcons";
import { visitingFrom } from "../lib/jurisdiction";

// Goa, Camarines Sur — center the map on the jurisdiction the citizen app serves.
const DEFAULT_CENTER = [13.6435, 123.4989];
const DEFAULT_ZOOM = 12;
const MAP_LAYER_KEY = "resq_map_layer"; // remembers the dispatcher's street/satellite choice across sessions

const STATUS_COLOR = { pending: "#f0a93a", acknowledged: "#2f7cf6", resolved: "#20c96b" };
const SELECTED_COLOR = "#ff3b3b";
const EMERGENCY_COLOR = "#ff3b3b";
const CALLING_COLOR = "#8b5cf6"; // distinct from the SOS red so a live call stands out from a report pin
const CALLING_ACTIVE_COLOR = "#20c96b"; // the citizen call currently answered in this tab

// The citizen app sends SOS alerts with incident_type = "SOS: <type>" (e.g.
// "SOS: Fire") since it now lets the reporter pick the kind of emergency.
// Anything with that prefix is an SOS, regardless of which type follows.
function isEmergency(inc) {
  return inc.status === "pending" && typeof inc.incident_type === "string" && inc.incident_type.startsWith("SOS:");
}

function markerIcon(color, selected, pulsing) {
  const size = selected ? 26 : pulsing ? 20 : 16;
  const extra =
    selected || pulsing
      ? `box-shadow:0 0 0 6px ${color}40, 0 0 0 2px #fff; animation: marker-pulse 1.4s ease-in-out infinite;`
      : `box-shadow:0 0 0 2px ${color}55;`;
  return L.divIcon({
    className: "",
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid #fff;${extra}"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

// A citizen currently ringing in (or being talked to) — a phone badge so it
// reads as "someone is calling", not just another report pin. Always pulses
// while ringing so it can't be missed on a busy map.
function callMarkerIcon(color) {
  const size = 30;
  return L.divIcon({
    className: "",
    html:
      `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:3px solid #fff;` +
      `box-shadow:0 0 0 7px ${color}45, 0 0 0 2px #fff; animation: marker-pulse 1s ease-in-out infinite;` +
      `display:flex;align-items:center;justify-content:center;font-size:14px;">📞</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function reporterName(inc) {
  const p = inc.profiles;
  const name = [p?.first_name, p?.last_name].filter(Boolean).join(" ").trim();
  return name || "Unknown citizen";
}

function locationLabel(inc, resolvedAddress) {
  if (inc.address) return inc.address;
  if (resolvedAddress) return resolvedAddress;
  if (inc.latitude != null && inc.longitude != null) {
    return `${inc.latitude.toFixed(6)}, ${inc.longitude.toFixed(6)}`;
  }
  return "Location unavailable";
}

// Basic HTML-escape since phone numbers/names get interpolated into raw
// popup markup (Leaflet's bindPopup takes an HTML string, not React).
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Popup layout (styles live in index.css under "map popups"):
//   [type icon] Title (SOS)                      close
//               reporter · municipality
//               phone
//   • STATUS | date · time
//   ---------------------------------------------
//   (pin)  Location
//   (doc)  Emergency details
//   [ Call ] [ Navigate ]   side by side
// Everything interpolated here comes from citizens (name, address,
// description), so it is all HTML-escaped — Leaflet's bindPopup takes a raw
// HTML string, not React.

const POPUP_OPTIONS = { minWidth: 330, maxWidth: 340 };

// Nominatim's display_name ends with ", Bicol Region, 4422, Philippines" —
// noise for a dispatcher who already knows what country they're in.
function shortAddress(label) {
  return String(label)
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part && !/^\d{4,5}$/.test(part) && !/^philippines$/i.test(part) && !/\bregion\b/i.test(part))
    .join(", ");
}

// The citizen app writes SOS descriptions as "Emergency SOS — immediate
// assistance requested…". The popup already says it's an SOS, so drop the
// prefix and capitalise what's left.
function cleanDescription(text) {
  const t = String(text ?? "").replace(/^\s*Emergency SOS\s*[—–-]\s*/i, "").trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : "";
}

// Oct 9, 2026 · 3:35 PM
function formatWhen(value) {
  const d = new Date(value);
  const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${date} · ${time}`;
}

function sectionHtml(iconName, label, value) {
  return (
    `<div class="pop-sec"><div class="pop-sec-icon">${svgIcon(iconName, 15)}</div>` +
    `<div><div class="pop-sec-label">${escapeHtml(label)}</div>` +
    `<div class="pop-sec-value" title="${escapeHtml(value)}">${escapeHtml(value)}</div></div></div>`
  );
}

// Calls go over the in-app VoIP channel (WebRTC over WiFi/data — see
// src/context/CallContext.jsx) instead of a tel: link, so they don't depend
// on either side having cellular signal or a phone plan.
function callBtnHtml(inc) {
  if (!inc.user_id) return "";
  return `<button type="button" class="pop-btn primary voip-call-btn" data-incident-id="${escapeHtml(String(inc.id))}">${svgIcon("phone", 16)} Call</button>`;
}

// Draws turn-by-turn driving directions right on this map, from the
// dispatcher's current location to the reporter/caller's pin — no external
// app or new tab. See handleNavigate() below.
function navigateBtnHtml(lat, lng) {
  return `<button type="button" class="pop-btn primary navigate-btn" data-lat="${Number(lat)}" data-lng="${Number(lng)}">${svgIcon("navigation", 16)} Navigate</button>`;
}

function popupHtml(inc, where) {
  const rawType = String(inc.incident_type || "Report");
  const isSOS = /^SOS:/i.test(rawType);
  const baseType = rawType.replace(/^SOS:\s*/i, "");
  const { icon, tone } = incidentIcon(baseType);
  const phone = inc.profiles?.phone?.trim();
  // The reporter's HOME municipality, shown as "from X" when the emergency is
  // in a different one (a San Jose resident reporting from Goa).
  const visiting = visitingFrom(inc);
  const municipality = visiting ? `from ${visiting}` : inc.profiles?.municipality;
  const hasCoords = inc.latitude != null && inc.longitude != null;
  const details = cleanDescription(inc.description);
  const statusLabel = STATUS[inc.status]?.label ?? inc.status;
  const actions = callBtnHtml(inc) + (hasCoords ? navigateBtnHtml(inc.latitude, inc.longitude) : "");

  return (
    `<div class="pop">` +
    `<div class="pop-head">` +
    `<div class="pop-icon ${tone}">${svgIcon(icon, 20)}</div>` +
    `<div class="pop-head-text">` +
    `<div class="pop-title">${escapeHtml(isSOS ? `${baseType} (SOS)` : baseType)}</div>` +
    `<div class="pop-who"><strong>${escapeHtml(reporterName(inc))}</strong>${municipality ? ` · ${escapeHtml(municipality)}` : ""}</div>` +
    (phone ? `<div class="pop-phone">${escapeHtml(phone)}</div>` : "") +
    `</div></div>` +
    `<div class="pop-statusrow">` +
    `<span class="pop-status ${escapeHtml(inc.status)}">${escapeHtml(statusLabel)}</span>` +
    `<span class="pop-sep"></span>` +
    `<span class="pop-when">${escapeHtml(formatWhen(inc.created_at))}</span>` +
    `</div>` +
    sectionHtml("map-pin", "Location", shortAddress(where)) +
    (details ? sectionHtml("file-text", isSOS ? "Emergency details" : "Report details", details) : "") +
    (actions ? `<div class="pop-actions">${actions}</div>` : "") +
    `</div>`
  );
}

function callPopupHtml(call, where) {
  const name = call.name || "Citizen";
  return (
    `<div class="pop">` +
    `<div class="pop-head">` +
    `<div class="pop-icon call">${svgIcon("phone-incoming", 20)}</div>` +
    `<div class="pop-head-text">` +
    `<div class="pop-title">Citizen calling</div>` +
    `<div class="pop-who"><strong>${escapeHtml(name)}</strong>${call.incidentType ? ` · ${escapeHtml(call.incidentType)}` : ""}</div>` +
    `</div></div>` +
    `<div class="pop-statusrow"></div>` +
    sectionHtml("map-pin", "Location", shortAddress(where)) +
    `<div class="pop-actions">` +
    `<button type="button" class="pop-btn answer citizen-call-answer-btn" data-call-id="${escapeHtml(String(call.callId))}">${svgIcon("phone", 16)} Answer</button>` +
    navigateBtnHtml(call.location.lat, call.location.lng) +
    `</div>` +
    `</div>`
  );
}

export default function IncidentMap({ incidents, selectedId, onSelect, height = 420, incomingCalls = [], onAnswerCitizenCall, activeCallId }) {
  const { startCall } = useCall();
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef({});
  const callMarkersRef = useRef({});
  const addressCacheRef = useRef({}); // incident id -> resolved address string | null (still loading) | undefined (not started)
  const callAddressCacheRef = useRef({}); // callId -> resolved address string | null
  const routeLayerRef = useRef(null); // the drawn polyline for the active in-app route
  const originMarkerRef = useRef(null); // the dispatcher's own live position while navigating
  const [route, setRoute] = useState(null); // { distanceKm, durationMin, steps, error }
  const [routing, setRouting] = useState(false); // true while a route is being calculated
  const incidentsRef = useRef(incidents);
  incidentsRef.current = incidents; // kept fresh so the popup's call button always has current data
  const incomingCallsRef = useRef(incomingCalls);
  incomingCallsRef.current = incomingCalls; // kept fresh so the popup's answer button always has current data
  const onAnswerCitizenCallRef = useRef(onAnswerCitizenCall);
  onAnswerCitizenCallRef.current = onAnswerCitizenCall;
  const handleNavigateRef = useRef(null); // set below, referenced by the delegated map click listener
  const unlocated = incidents.filter((i) => i.latitude == null || i.longitude == null);

  // Removes the drawn route/origin marker from the map and clears the
  // turn-by-turn panel. Safe to call whether or not a route is active.
  function clearRoute() {
    const map = mapRef.current;
    if (map && routeLayerRef.current) map.removeLayer(routeLayerRef.current);
    if (map && originMarkerRef.current) map.removeLayer(originMarkerRef.current);
    routeLayerRef.current = null;
    originMarkerRef.current = null;
    setRoute(null);
  }

  // Draws a driving route on this map from the dispatcher's current browser
  // location to (destLat, destLng), and populates the turn-by-turn panel.
  // Everything happens in-app — no external maps app, no new tab.
  async function handleNavigate(destLat, destLng) {
    const map = mapRef.current;
    if (!map) return;
    setRouting(true);
    setRoute(null);

    if (!navigator.geolocation) {
      setRouting(false);
      setRoute({ error: "This browser can't share your location, so a route can't be drawn." });
      return;
    }

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const origin = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        try {
          const result = await fetchRoute(origin, { lat: destLat, lng: destLng });

          if (routeLayerRef.current) map.removeLayer(routeLayerRef.current);
          routeLayerRef.current = L.polyline(result.coordinates, {
            color: "#2f7cf6",
            weight: 5,
            opacity: 0.85,
          }).addTo(map);

          if (originMarkerRef.current) map.removeLayer(originMarkerRef.current);
          originMarkerRef.current = L.marker([origin.lat, origin.lng], {
            icon: L.divIcon({
              className: "",
              html:
                `<div style="width:16px;height:16px;border-radius:50%;background:#2f7cf6;` +
                `border:3px solid #fff;box-shadow:0 0 0 5px #2f7cf640;"></div>`,
              iconSize: [16, 16],
              iconAnchor: [8, 8],
            }),
            zIndexOffset: 1500,
          }).addTo(map);

          map.fitBounds(routeLayerRef.current.getBounds().pad(0.15));
          setRoute({ ...result, error: null });
        } catch (err) {
          setRoute({ error: "Couldn't calculate a route right now. Check the connection and try again." });
        } finally {
          setRouting(false);
        }
      },
      () => {
        setRouting(false);
        setRoute({ error: "Location access is off, so a route can't be drawn from your position. Enable location and try again." });
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
    );
  }
  handleNavigateRef.current = handleNavigate; // kept fresh, though handleNavigate itself never actually changes shape

  useEffect(() => {
    if (mapRef.current || !containerRef.current) return;
    const map = L.map(containerRef.current, { zoomControl: true }).setView(DEFAULT_CENTER, DEFAULT_ZOOM);

    // Two base layers the dispatcher can flip between. Satellite imagery is
    // Esri's free World Imagery layer (no API key, no billing account
    // needed) rather than actual Google tiles — Google's satellite tiles
    // aren't available outside their paid JS SDK/ToS, whereas Esri's World
    // Imagery is explicitly free to use like this with attribution.
    const streetLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    });
    const satelliteLayer = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { attribution: "Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics", maxZoom: 19 }
    );

    const savedLayer = localStorage.getItem(MAP_LAYER_KEY);
    let currentLayer = savedLayer === "satellite" ? "satellite" : "street";
    (currentLayer === "satellite" ? satelliteLayer : streetLayer).addTo(map);

    const LayerToggle = L.Control.extend({
      options: { position: "topright" },
      onAdd() {
        const btn = L.DomUtil.create("button", "map-layer-toggle");
        btn.type = "button";
        const render = () => {
          btn.innerHTML = currentLayer === "satellite" ? "🗺️ Street" : "🛰️ Satellite";
          btn.title = currentLayer === "satellite" ? "Switch to street map" : "Switch to satellite view";
        };
        render();
        Object.assign(btn.style, {
          background: "#fff", border: "2px solid rgba(0,0,0,0.15)", borderRadius: 6,
          padding: "6px 10px", fontSize: 12, fontWeight: 600, cursor: "pointer", boxShadow: "0 1px 4px rgba(0,0,0,0.2)",
        });
        L.DomEvent.disableClickPropagation(btn);
        L.DomEvent.on(btn, "click", () => {
          if (currentLayer === "satellite") {
            map.removeLayer(satelliteLayer);
            streetLayer.addTo(map);
            currentLayer = "street";
          } else {
            map.removeLayer(streetLayer);
            satelliteLayer.addTo(map);
            currentLayer = "satellite";
          }
          localStorage.setItem(MAP_LAYER_KEY, currentLayer);
          render();
        });
        return btn;
      },
    });
    map.addControl(new LayerToggle());

    mapRef.current = map;

    // Delegated click listener for the popup's call button, attached once to
    // the map container rather than to each button element. Popups get their
    // HTML replaced in place (bindPopup/setPopupContent below) every time
    // incidents refresh — which happens continuously via the live Realtime
    // subscription — so a handler bound directly to "the button that exists
    // right now" goes stale the next time that content re-renders under it.
    // Delegation avoids that: it just asks "was the click inside a
    // .voip-call-btn, whichever one is live right now."
    const onMapClick = (event) => {
      const voipBtn = event.target.closest?.(".voip-call-btn");
      if (voipBtn) {
        const incId = voipBtn.getAttribute("data-incident-id");
        const current = incidentsRef.current.find((i) => String(i.id) === incId);
        if (current?.user_id) {
          startCall(current.user_id, reporterName(current), current.incident_type, {
            incidentId: current.id,
            municipality: current.profiles?.municipality,
            jurisdiction: current.jurisdiction,
          });
        }
        return;
      }
      const answerBtn = event.target.closest?.(".citizen-call-answer-btn");
      if (answerBtn) {
        const callId = answerBtn.getAttribute("data-call-id");
        const call = incomingCallsRef.current.find((c) => String(c.callId) === callId);
        if (call) onAnswerCitizenCallRef.current?.(call);
        return;
      }
      const navBtn = event.target.closest?.(".navigate-btn");
      if (navBtn) {
        const destLat = parseFloat(navBtn.getAttribute("data-lat"));
        const destLng = parseFloat(navBtn.getAttribute("data-lng"));
        handleNavigateRef.current(destLat, destLng);
      }
    };
    map.getContainer().addEventListener("click", onMapClick);

    return () => {
      map.getContainer().removeEventListener("click", onMapClick);
      map.remove();
      mapRef.current = null;
      markersRef.current = {}; // the destroyed map's markers are gone with it — don't let stale refs survive a remount
      callMarkersRef.current = {};
      routeLayerRef.current = null;
      originMarkerRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const seen = new Set();
    const located = incidents.filter((i) => i.latitude != null && i.longitude != null);

    for (const inc of located) {
      seen.add(inc.id);
      const statusColor = STATUS_COLOR[inc.status] ?? "#8a929c";
      const isSelected = inc.id === selectedId;
      const isEmergency_ = isEmergency(inc);
      const pinColor = isSelected ? SELECTED_COLOR : isEmergency_ ? EMERGENCY_COLOR : statusColor;
      const existing = markersRef.current[inc.id];
      const latlng = [inc.latitude, inc.longitude];

      if (existing && map.hasLayer(existing)) {
        existing.setLatLng(latlng);
        existing.setIcon(markerIcon(pinColor, isSelected, isEmergency_));
        existing.setZIndexOffset(isSelected || isEmergency_ ? 1000 : 0);
      } else {
        const marker = L.marker(latlng, {
          icon: markerIcon(pinColor, isSelected, isEmergency_),
          zIndexOffset: isSelected || isEmergency_ ? 1000 : 0,
        }).addTo(map);
        marker.on("click", () => onSelect?.(inc.id));
        markersRef.current[inc.id] = marker;
      }

      const resolved = addressCacheRef.current[inc.id];
      const where = locationLabel(inc, resolved);
      markersRef.current[inc.id].bindPopup(popupHtml(inc, where), POPUP_OPTIONS);

      // No stored address yet, and we haven't already kicked off a lookup
      // for this incident — reverse-geocode its coordinates and refresh the
      // popup text in place once we get a result back.
      if (!inc.address && resolved === undefined && inc.latitude != null && inc.longitude != null) {
        addressCacheRef.current[inc.id] = null; // mark "in progress" so we don't fetch twice
        reverseGeocode(inc.latitude, inc.longitude).then((label) => {
          addressCacheRef.current[inc.id] = label;
          const marker = markersRef.current[inc.id];
          if (!marker) return;
          const newWhere = locationLabel(inc, label);
          marker.setPopupContent(popupHtml(inc, newWhere));
        });
      }
    }

    // remove markers for incidents no longer in the list
    for (const id of Object.keys(markersRef.current)) {
      if (!seen.has(id) && !seen.has(Number(id))) {
        map.removeLayer(markersRef.current[id]);
        delete markersRef.current[id];
      }
    }

    if (located.length && !selectedId) {
      const bounds = L.latLngBounds(located.map((i) => [i.latitude, i.longitude]));
      map.fitBounds(bounds.pad(0.25), { maxZoom: 15 });
    }
  }, [incidents, selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Citizen calls ringing in (or being answered) — kept in a separate marker
  // set from incident pins so a live call is never confused with a report.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const seen = new Set();
    const located = incomingCalls.filter((c) => c.location?.lat != null && c.location?.lng != null);

    for (const call of located) {
      seen.add(call.callId);
      const color = call.callId === activeCallId ? CALLING_ACTIVE_COLOR : CALLING_COLOR;
      const latlng = [call.location.lat, call.location.lng];
      const existing = callMarkersRef.current[call.callId];

      if (existing && map.hasLayer(existing)) {
        existing.setLatLng(latlng);
        existing.setIcon(callMarkerIcon(color));
        existing.setZIndexOffset(2000);
      } else {
        const marker = L.marker(latlng, { icon: callMarkerIcon(color), zIndexOffset: 2000 }).addTo(map);
        callMarkersRef.current[call.callId] = marker;
      }

      const resolved = callAddressCacheRef.current[call.callId];
      const where = call.municipality || resolved || `${call.location.lat.toFixed(5)}, ${call.location.lng.toFixed(5)}`;
      callMarkersRef.current[call.callId].bindPopup(callPopupHtml(call, where), POPUP_OPTIONS);

      if (!call.municipality && resolved === undefined) {
        callAddressCacheRef.current[call.callId] = null;
        reverseGeocode(call.location.lat, call.location.lng).then((label) => {
          callAddressCacheRef.current[call.callId] = label;
          const marker = callMarkersRef.current[call.callId];
          if (!marker) return;
          marker.setPopupContent(callPopupHtml(call, call.municipality || label || where));
        });
      }
    }

    for (const callId of Object.keys(callMarkersRef.current)) {
      if (!seen.has(callId)) {
        map.removeLayer(callMarkersRef.current[callId]);
        delete callMarkersRef.current[callId];
      }
    }

    // Newly-ringing calls deserve to be seen immediately — nudge the view to
    // include them without fighting a dispatcher who has a pin selected.
    if (located.length && !selectedId) {
      const target = located[located.length - 1];
      const marker = callMarkersRef.current[target.callId];
      if (marker && !map.getBounds().contains(marker.getLatLng())) {
        map.flyTo(marker.getLatLng(), Math.max(map.getZoom(), 14), { duration: 0.6 });
      }
    }
  }, [incomingCalls, activeCallId, selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const map = mapRef.current;
    const marker = selectedId != null ? markersRef.current[selectedId] : null;
    if (map && marker) {
      map.flyTo(marker.getLatLng(), 16, { duration: 0.6 });
      marker.openPopup();
    }
  }, [selectedId]);

  return (
    <div>
      <div ref={containerRef} className="map-wrap" style={{ height }} />

      {routing && (
        <div className="route-panel route-panel-loading">Finding your location and calculating the route…</div>
      )}

      {route?.error && (
        <div className="route-panel route-panel-error">
          <span>⚠️ {route.error}</span>
          <button type="button" className="btn-mini" onClick={clearRoute}>Dismiss</button>
        </div>
      )}

      {route && !route.error && (
        <div className="route-panel">
          <div className="route-panel-header">
            <div>
              <strong>🧭 {route.distanceKm} km</strong>
              <span className="route-eta"> · about {route.durationMin} min</span>
            </div>
            <button type="button" className="btn-mini" onClick={clearRoute}>End navigation</button>
          </div>
          {route.steps?.length > 0 && (
            <ol className="route-steps">
              {route.steps.map((step, i) => (
                <li key={i}>
                  <span>{step.instruction}</span>
                  {step.distanceText && <span className="route-step-dist">{step.distanceText}</span>}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      {unlocated.length > 0 && (
        <div
          style={{
            marginTop: 8, padding: "8px 12px", borderRadius: 8, background: "#fdeaea",
            color: "#b3261e", fontSize: 12, fontWeight: 600, display: "flex",
            alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 6,
          }}
        >
          <span>
            ⚠️ {unlocated.length} {unlocated.length === 1 ? "report has" : "reports have"} no GPS location and
            {unlocated.length === 1 ? " isn't" : " aren't"} shown on the map — check the list for details.
          </span>
        </div>
      )}
    </div>
  );
}
