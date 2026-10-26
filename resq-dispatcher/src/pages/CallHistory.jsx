import React from "react";
import CallHistoryPanel from "../components/analytics/CallHistoryPanel";
import { useCallLogs } from "../lib/useCallLogs";

export default function CallHistory() {
  const { callLogs, loading, error } = useCallLogs();
  return <CallHistoryPanel callLogs={callLogs} error={error} loading={loading} />;
}
