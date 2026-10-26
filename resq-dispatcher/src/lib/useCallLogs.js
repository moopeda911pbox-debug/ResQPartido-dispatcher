import { useCallback, useEffect, useState } from "react";
import { getCallLogs, subscribeToCallLogs } from "../services/callLogs";

// Call history (public.call_logs), fetched once and kept live. Shared by the
// Call History page and the Dispatcher Response Times tab (which uses it for
// calls-per-dispatcher).
export function useCallLogs() {
  const [callLogs, setCallLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setCallLogs(await getCallLogs());
      setError("");
    } catch (err) {
      // Most likely the table doesn't exist yet (migration not run).
      setError(err?.message || "couldn't load call logs");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    return subscribeToCallLogs(load);
  }, [load]);

  return { callLogs, loading, error };
}
