import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "../lib/supabase";
import { createPeerConnection, getMicStream } from "../lib/webrtc";
import { startCitizenRingtone } from "../lib/alerts";
import { useAuth } from "./AuthContext";
import { inMyJurisdiction, jurisdictionAt } from "../lib/jurisdiction";
import {
  logOutboundCallStart,
  updateCallLog,
  logInboundRing,
  markInboundMissed,
  logInboundAnswered,
  finishInboundCall,
} from "../services/callLogs";

const CallCtx = createContext(null);

// Channel naming must match the citizen app exactly: resq-partido/src/context/CallContext.jsx
const channelName = (userId) => `call-${userId}`;

// --- Citizen-initiated calls ------------------------------------------------
// Any citizen can tap "Call Dispatcher" without knowing which dispatcher will
// pick up, so there's no single userId to address like the outbound flow
// above. Instead:
//   1. The citizen broadcasts on the shared DISPATCHER_INBOX channel, which
//      every signed-in dispatcher subscribes to for as long as the console is
//      open — this is the "ring" that shows up as a map marker + banner.
//   2. Whichever dispatcher answers first joins a call-specific channel
//      (citizenCallChannelName) and broadcasts "claimed" on the shared inbox
//      so it disappears from every other dispatcher's queue.
//   3. The citizen (still listening on that call-specific channel) gets the
//      dispatcher's "dispatcher-ready" and only then creates the SDP offer —
//      the citizen is the caller, so it plays the offerer role, mirroring who
//      actually placed the call.
// Naming must match resq-partido/src/context/CallContext.jsx exactly.
const DISPATCHER_INBOX = "dispatcher-inbox";
const citizenCallChannelName = (callId) => `citizen-call-${callId}`;

// How long an unanswered citizen call stays in the queue before this
// dispatcher's own view drops it — a client-side safety net in case the
// citizen's own "cancelled" broadcast never arrives (tab closed, connection
// dropped, etc). The citizen side gives up and shows "no dispatcher
// available" slightly before this, so in the normal case this never fires.
const RING_TIMEOUT_MS = 45000;

export function CallProvider({ children }) {
  const { profile } = useAuth();

  // --- outbound: dispatcher calls a specific citizen (unchanged) ---
  const [callState, setCallState] = useState("idle"); // idle | calling | active | ended | rejected | failed
  const [callee, setCallee] = useState(null); // { userId, name, incidentType }
  const [muted, setMuted] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  const channelRef = useRef(null);
  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const pendingIceRef = useRef([]); // citizen's ICE candidates that arrive before "answer" has set our remote description

  // Call history (see services/callLogs.js). The promise resolves to this
  // call's call_logs row id; every later update chains onto it so an update
  // can never overtake the insert it depends on.
  const outLogPromiseRef = useRef(null);
  const outAnsweredAtRef = useRef(null); // Date the citizen picked up (audio connected)

  const markOutboundConnected = useCallback(() => {
    const pending = outLogPromiseRef.current;
    if (!pending || outAnsweredAtRef.current) return;
    const at = new Date();
    outAnsweredAtRef.current = at;
    outLogPromiseRef.current = pending.then(async (id) => {
      if (id) await updateCallLog(id, { answered_at: at.toISOString(), outcome: "connected" });
      return id;
    });
  }, []);

  const finalizeOutboundLog = useCallback((state) => {
    const pending = outLogPromiseRef.current;
    if (!pending) return; // already finalized, or this call was never logged
    outLogPromiseRef.current = null;
    const answeredAt = outAnsweredAtRef.current;
    outAnsweredAtRef.current = null;
    const endedAt = new Date();

    let outcome;
    if (state === "failed") outcome = "failed";
    else if (answeredAt) outcome = "completed";
    else if (state === "rejected") outcome = "declined"; // citizen tapped decline
    else outcome = "no_answer"; // hung up (or the citizen left) before anyone picked up

    pending.then((id) => {
      if (!id) return;
      updateCallLog(id, {
        ended_at: endedAt.toISOString(),
        duration_seconds: answeredAt ? Math.max(0, Math.round((endedAt - answeredAt) / 1000)) : null,
        outcome,
      });
    });
  }, []);

  const cleanup = useCallback(() => {
    pcRef.current?.close();
    pcRef.current = null;
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    pendingIceRef.current = [];
    if (channelRef.current) {
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    }
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
  }, []);

  const endCall = useCallback(
    (state = "ended", notifyRemote = true) => {
      if (notifyRemote && channelRef.current) {
        channelRef.current.send({ type: "broadcast", event: "hangup", payload: {} });
      }
      finalizeOutboundLog(state);
      cleanup();
      setCallState(state);
      setMuted(false);
      setTimeout(() => setCallState((s) => (s === state ? "idle" : s)), 1800);
    },
    [cleanup, finalizeOutboundLog]
  );

  const startCall = useCallback(
    // meta = { incidentId, municipality } — which report this call is about,
    // so the call shows up against that report in Analytics & Report.
    async (userId, name, incidentType, meta = {}) => {
      if (!userId) return;
      setErrorMsg("");
      setCallee({ userId, name, incidentType });
      setCallState("calling");

      try {
        const stream = await getMicStream();
        localStreamRef.current = stream;

        // Logged only once the mic is granted, i.e. once a call is really
        // being placed — a permission error isn't a call.
        outAnsweredAtRef.current = null;
        outLogPromiseRef.current = logOutboundCallStart({
          dispatcherId: profile?.id,
          dispatcherName: profile?.first_name
            ? `${profile.first_name} ${profile.last_name ?? ""}`.trim()
            : "Dispatcher",
          citizenId: userId,
          citizenName: name,
          incidentId: meta.incidentId,
          incidentType,
          municipality: meta.municipality,
          // The report's jurisdiction (null = unplaced, visible to all); if the
          // caller didn't pass one, it's the dispatcher's own municipality.
          jurisdiction: meta.jurisdiction !== undefined ? meta.jurisdiction : profile?.municipality ?? null,
        });

        const channel = supabase.channel(channelName(userId));
        channelRef.current = channel;

        const pc = createPeerConnection({
          onIceCandidate: (candidate) => {
            channel.send({ type: "broadcast", event: "ice-dispatcher", payload: { candidate } });
          },
          onTrack: (remoteStream) => {
            if (remoteAudioRef.current) remoteAudioRef.current.srcObject = remoteStream;
          },
          onConnectionStateChange: (state) => {
            if (state === "connected") {
              setCallState("active");
              markOutboundConnected();
            }
            if (state === "failed") {
              setErrorMsg("Call connection failed — the citizen's device may have no internet.");
              endCall("failed", false);
            }
          },
        });
        pcRef.current = pc;
        stream.getTracks().forEach((track) => pc.addTrack(track, stream));

        channel
          .on("broadcast", { event: "answer" }, async ({ payload }) => {
            if (!pcRef.current) return;
            await pcRef.current.setRemoteDescription(payload.sdp);
            // Flush any citizen ICE candidates that arrived before we had a
            // remote description to attach them to — see the note below.
            pendingIceRef.current.splice(0).forEach((candidate) => {
              pcRef.current.addIceCandidate(candidate).catch(() => {});
            });
          })
          .on("broadcast", { event: "ice-citizen" }, ({ payload }) => {
            if (!payload.candidate) return;
            // Candidates can arrive interleaved with (or even slightly ahead
            // of) the "answer" broadcast above; queue instead of dropping if
            // our remote description isn't set yet, or the call can end up
            // one-sided and hang at "Connecting…" forever.
            if (pcRef.current && pcRef.current.remoteDescription) {
              pcRef.current.addIceCandidate(payload.candidate).catch(() => {});
            } else {
              pendingIceRef.current.push(payload.candidate);
            }
          })
          .on("broadcast", { event: "reject" }, () => endCall("rejected", false))
          .on("broadcast", { event: "hangup" }, () => endCall("ended", false))
          .subscribe(async (status) => {
            if (status !== "SUBSCRIBED") return;
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            channel.send({
              type: "broadcast",
              event: "offer",
              payload: {
                sdp: offer,
                dispatcherName: profile?.first_name
                  ? `${profile.first_name} ${profile.last_name ?? ""}`.trim()
                  : "Dispatcher",
                incidentType,
              },
            });
          });
      } catch (err) {
        setErrorMsg(
          err?.name === "NotAllowedError" ? "Microphone permission is needed to place the call." : "Couldn't start the call."
        );
        finalizeOutboundLog("failed"); // no-op if the call was never logged (e.g. mic denied)
        cleanup();
        setCallState("idle");
        setCallee(null);
      }
    },
    [profile, endCall, cleanup, markOutboundConnected, finalizeOutboundLog]
  );

  const toggleMute = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !muted;
    stream.getAudioTracks().forEach((t) => (t.enabled = !next));
    setMuted(next);
  }, [muted]);

  // --- inbound: a citizen calls in, any dispatcher can answer ---
  const [incomingCitizenCalls, setIncomingCitizenCalls] = useState([]); // [{ callId, citizenId, name, phone, incidentType, location, municipality, receivedAt }]
  const [citizenCallState, setCitizenCallState] = useState("idle"); // idle | connecting | active | ended | failed
  const [activeCitizenCall, setActiveCitizenCall] = useState(null);
  const [citizenMuted, setCitizenMuted] = useState(false);
  const [citizenErrorMsg, setCitizenErrorMsg] = useState("");

  const inboxChannelRef = useRef(null);
  const inboundChannelRef = useRef(null);
  const inboundPcRef = useRef(null);
  const inboundStreamRef = useRef(null);
  const inboundAudioRef = useRef(null);
  const ringToneRef = useRef(null);
  const ringTimeoutsRef = useRef({}); // callId -> timeout id
  const inboundPendingIceRef = useRef([]); // citizen's ICE candidates arriving before setRemoteDescription completes
  const inboundCallIdRef = useRef(null); // callId of the citizen call this tab answered, for the call history
  const inboundConnectedAtRef = useRef(null); // ms timestamp the audio connected, for talk time

  const dispatcherDisplayName = profile?.first_name
    ? `${profile.first_name} ${profile.last_name ?? ""}`.trim()
    : "Dispatcher";

  const clearRingTimeout = (callId) => {
    if (ringTimeoutsRef.current[callId]) {
      clearTimeout(ringTimeoutsRef.current[callId]);
      delete ringTimeoutsRef.current[callId];
    }
  };

  const removeIncomingCall = useCallback((callId) => {
    clearRingTimeout(callId);
    setIncomingCitizenCalls((calls) => calls.filter((c) => c.callId !== callId));
  }, []);

  // The inbox subscription below lives for the whole session, so it reads the
  // dispatcher's profile (for their jurisdiction) through a ref instead of
  // re-subscribing whenever the profile object changes.
  const profileRef = useRef(profile);
  profileRef.current = profile;

  // Join the shared inbox once per mount (i.e. for as long as the dispatcher
  // console is open) so a call can ring in no matter which page is showing.
  useEffect(() => {
    const channel = supabase.channel(DISPATCHER_INBOX);
    inboxChannelRef.current = channel;

    // Calls that were cancelled / claimed while we were still working out
    // whether they're ours — they must not ring afterwards.
    const settledCallIds = new Set();

    // Citizen calls reach every dispatcher console over one shared channel,
    // so each console decides for itself whether the call is in its
    // jurisdiction: where the citizen IS (their GPS at the time of the call),
    // not the municipality on their account.
    async function handleIncomingCall(payload) {
      if (!payload?.callId) return;

      let jurisdiction = null;
      const lat = payload.location?.lat;
      const lng = payload.location?.lng;
      if (lat != null && lng != null) {
        try {
          jurisdiction = await jurisdictionAt(lat, lng);
        } catch {
          // Couldn't tell (offline, or the jurisdiction migration isn't
          // applied yet). A missed emergency call is worse than an extra
          // ring, so ring.
          jurisdiction = null;
        }
      }

      if (settledCallIds.has(payload.callId)) return;
      if (!inMyJurisdiction(profileRef.current, jurisdiction)) return;

      logInboundRing({ ...payload, jurisdiction }); // every in-jurisdiction console tries; call_ref is unique so one row results
      setIncomingCitizenCalls((calls) => {
        if (calls.some((c) => c.callId === payload.callId)) return calls;
        return [...calls, { ...payload, jurisdiction, receivedAt: Date.now() }];
      });
      ringTimeoutsRef.current[payload.callId] = setTimeout(() => {
        removeIncomingCall(payload.callId);
        markInboundMissed(payload.callId); // no-op if someone answered meanwhile
      }, RING_TIMEOUT_MS);
    }

    channel
      .on("broadcast", { event: "incoming-citizen-call" }, ({ payload }) => {
        handleIncomingCall(payload);
      })
      .on("broadcast", { event: "cancelled" }, ({ payload }) => {
        settledCallIds.add(payload.callId);
        removeIncomingCall(payload.callId);
        markInboundMissed(payload.callId); // citizen gave up before anyone answered
      })
      .on("broadcast", { event: "claimed" }, ({ payload }) => {
        settledCallIds.add(payload.callId);
        removeIncomingCall(payload.callId);
      })
      .subscribe();

    return () => {
      Object.keys(ringTimeoutsRef.current).forEach(clearTimeout);
      ringTimeoutsRef.current = {};
      supabase.removeChannel(channel);
      inboxChannelRef.current = null;
    };
  }, [removeIncomingCall]);

  // Ring for as long as at least one citizen call is waiting to be answered.
  useEffect(() => {
    if (incomingCitizenCalls.length > 0 && !ringToneRef.current) {
      ringToneRef.current = startCitizenRingtone();
    } else if (incomingCitizenCalls.length === 0 && ringToneRef.current) {
      ringToneRef.current.stop();
      ringToneRef.current = null;
    }
    return () => {
      if (incomingCitizenCalls.length === 0 && ringToneRef.current) {
        ringToneRef.current.stop();
        ringToneRef.current = null;
      }
    };
  }, [incomingCitizenCalls.length]);

  const cleanupInbound = useCallback(() => {
    inboundPcRef.current?.close();
    inboundPcRef.current = null;
    inboundStreamRef.current?.getTracks().forEach((t) => t.stop());
    inboundStreamRef.current = null;
    if (inboundChannelRef.current) {
      supabase.removeChannel(inboundChannelRef.current);
      inboundChannelRef.current = null;
    }
    if (inboundAudioRef.current) inboundAudioRef.current.srcObject = null;
    inboundPendingIceRef.current = [];
  }, []);

  const endCitizenCall = useCallback(
    (state = "ended", notifyRemote = true) => {
      if (notifyRemote && inboundChannelRef.current) {
        inboundChannelRef.current.send({ type: "broadcast", event: "hangup", payload: {} });
      }

      const loggedCallId = inboundCallIdRef.current;
      if (loggedCallId) {
        const now = Date.now();
        const connectedAt = inboundConnectedAtRef.current;
        inboundCallIdRef.current = null;
        inboundConnectedAtRef.current = null;
        finishInboundCall(loggedCallId, {
          endedAt: new Date(now),
          durationSeconds: connectedAt ? Math.max(0, Math.round((now - connectedAt) / 1000)) : null,
          // Never got audio flowing (or the connection dropped) = failed;
          // otherwise a normal completed call.
          outcome: state === "failed" || !connectedAt ? "failed" : "completed",
        });
      }

      cleanupInbound();
      setCitizenCallState(state);
      setCitizenMuted(false);
      setTimeout(() => {
        setCitizenCallState((s) => (s === state ? "idle" : s));
        setActiveCitizenCall((c) => (c && state !== "idle" ? null : c));
      }, 1800);
    },
    [cleanupInbound]
  );

  // Stop ringing on this device for a call without ending it for anyone else
  // — another dispatcher elsewhere may still pick it up. Purely local.
  const dismissCitizenCall = useCallback(
    (callId) => {
      removeIncomingCall(callId);
    },
    [removeIncomingCall]
  );

  const answerCitizenCall = useCallback(
    async (call) => {
      if (!call?.callId) return;
      if (citizenCallState === "connecting" || citizenCallState === "active") return; // already on a call in this tab

      removeIncomingCall(call.callId);
      setCitizenErrorMsg("");
      setActiveCitizenCall(call);
      setCitizenCallState("connecting");

      // Tell every other dispatcher's queue this one's taken.
      inboxChannelRef.current?.send({
        type: "broadcast",
        event: "claimed",
        payload: { callId: call.callId, dispatcherName: dispatcherDisplayName },
      });

      // Call history: this dispatcher picked up. answered_at here is the
      // moment of pickup, so (answered_at - started_at) is how long the
      // citizen waited for a dispatcher.
      inboundCallIdRef.current = call.callId;
      inboundConnectedAtRef.current = null;
      logInboundAnswered(call, { id: profile?.id, name: dispatcherDisplayName });

      try {
        const stream = await getMicStream();
        inboundStreamRef.current = stream;

        const channel = supabase.channel(citizenCallChannelName(call.callId));
        inboundChannelRef.current = channel;

        const pc = createPeerConnection({
          onIceCandidate: (candidate) => {
            channel.send({ type: "broadcast", event: "ice-dispatcher", payload: { candidate } });
          },
          onTrack: (remoteStream) => {
            if (inboundAudioRef.current) inboundAudioRef.current.srcObject = remoteStream;
          },
          onConnectionStateChange: (state) => {
            if (state === "connected") {
              setCitizenCallState("active");
              if (!inboundConnectedAtRef.current) inboundConnectedAtRef.current = Date.now();
            }
            if (state === "failed") {
              setCitizenErrorMsg("Call connection failed — the citizen's device may have no internet.");
              endCitizenCall("failed", false);
            }
          },
        });
        inboundPcRef.current = pc;
        stream.getTracks().forEach((track) => pc.addTrack(track, stream));

        channel
          .on("broadcast", { event: "offer" }, async ({ payload }) => {
            if (!inboundPcRef.current) return;
            await inboundPcRef.current.setRemoteDescription(payload.sdp);
            // Flush any citizen ICE candidates that beat the offer here.
            inboundPendingIceRef.current.splice(0).forEach((candidate) => {
              inboundPcRef.current.addIceCandidate(candidate).catch(() => {});
            });
            const answer = await inboundPcRef.current.createAnswer();
            await inboundPcRef.current.setLocalDescription(answer);
            channel.send({ type: "broadcast", event: "answer", payload: { sdp: answer } });
          })
          .on("broadcast", { event: "ice-citizen" }, ({ payload }) => {
            if (!payload.candidate) return;
            if (inboundPcRef.current && inboundPcRef.current.remoteDescription) {
              inboundPcRef.current.addIceCandidate(payload.candidate).catch(() => {});
            } else {
              inboundPendingIceRef.current.push(payload.candidate);
            }
          })
          .on("broadcast", { event: "hangup" }, () => endCitizenCall("ended", false))
          .subscribe((status) => {
            if (status !== "SUBSCRIBED") return;
            channel.send({
              type: "broadcast",
              event: "dispatcher-ready",
              payload: { dispatcherName: dispatcherDisplayName },
            });
          });
      } catch (err) {
        setCitizenErrorMsg(
          err?.name === "NotAllowedError" ? "Microphone permission is needed to answer the call." : "Couldn't answer the call."
        );
        if (inboundCallIdRef.current) {
          finishInboundCall(inboundCallIdRef.current, { endedAt: new Date(), durationSeconds: null, outcome: "failed" });
          inboundCallIdRef.current = null;
          inboundConnectedAtRef.current = null;
        }
        cleanupInbound();
        setCitizenCallState("idle");
        setActiveCitizenCall(null);
      }
    },
    [citizenCallState, dispatcherDisplayName, profile, removeIncomingCall, endCitizenCall, cleanupInbound]
  );

  const toggleCitizenMute = useCallback(() => {
    const stream = inboundStreamRef.current;
    if (!stream) return;
    const next = !citizenMuted;
    stream.getAudioTracks().forEach((t) => (t.enabled = !next));
    setCitizenMuted(next);
  }, [citizenMuted]);

  return (
    <CallCtx.Provider
      value={{
        callState,
        callee,
        muted,
        errorMsg,
        startCall,
        hangUp: () => endCall("ended", true),
        toggleMute,

        incomingCitizenCalls,
        citizenCallState,
        activeCitizenCall,
        citizenMuted,
        citizenErrorMsg,
        answerCitizenCall,
        dismissCitizenCall,
        hangUpCitizenCall: () => endCitizenCall("ended", true),
        toggleCitizenMute,
      }}
    >
      {children}
      <audio ref={remoteAudioRef} autoPlay />
      <audio ref={inboundAudioRef} autoPlay />
    </CallCtx.Provider>
  );
}

export function useCall() {
  const ctx = useContext(CallCtx);
  if (!ctx) throw new Error("useCall must be used inside CallProvider");
  return ctx;
}
