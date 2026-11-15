import unittest
from unittest.mock import patch
from urllib.parse import urlparse
import server


class DailySnapshotTests(unittest.TestCase):
    def setUp(self):
        self.events = [{"id": "one", "event_url": "event-one", "event_name": "One"},
                       {"id": "two", "event_url": "event-two", "event_name": "Two"}]
        self.calls = []
        self.coverage = []
        def request(path, method="GET", payload=None, *args):
            self.calls.append((path, method, payload))
            return self.coverage if path.startswith("rpc/") else None
        self.request = patch.object(server, "supabase_request", side_effect=request).start()
        patch.object(server, "tracked_events", return_value=self.events).start()
        self.analyse = patch.object(server, "analyse_any_event", return_value={}).start()
        patch.object(server, "attach_finalized_sessions").start()
        self.store = patch.object(server, "store_snapshot", return_value={"snapshotId": "saved"}).start()
        self.sleep = patch.object(server.time, "sleep").start()
        self.addCleanup(patch.stopall)

    def test_retries_transient_failure_and_preserves_attempt_log(self):
        self.analyse.side_effect = [server.TicketSearchError("unavailable"), {}, {}]
        result = server.run_daily_snapshots()
        self.assertTrue(result["ok"])
        self.assertEqual(result["results"][0]["attempts"], 2)
        statuses = [p["status"] for _, m, p in self.calls if m == "PATCH"]
        self.assertEqual(statuses, ["failed", "succeeded", "succeeded"])
        self.assertEqual(self.sleep.call_count, 1)

    def test_exhausted_event_does_not_prevent_other_captures(self):
        self.analyse.side_effect = [RuntimeError("down")] * 3 + [{}]
        result = server.run_daily_snapshots()
        self.assertFalse(result["ok"])
        self.assertEqual(result["failedEvents"], 1)
        self.assertTrue(result["results"][1]["ok"])

    def test_skips_completed_events(self):
        self.coverage = [{"tracked_event_id": "one"}, {"tracked_event_id": "two"}]
        result = server.run_daily_snapshots()
        self.assertTrue(result["ok"])
        self.analyse.assert_not_called()
        self.store.assert_not_called()

    def test_storage_failure_is_retried_and_none_is_not_success(self):
        self.store.side_effect = [None, server.StorageError("write failed"), {"snapshotId": "saved"}, {"snapshotId": "saved"}]
        result = server.run_daily_snapshots()
        self.assertTrue(result["ok"])
        self.assertEqual(result["results"][0]["attempts"], 3)

    def test_log_failure_aborts_and_releases_lock(self):
        self.request.side_effect = server.StorageError("log unavailable")
        with self.assertRaises(server.StorageError):
            server.run_daily_snapshots()
        self.assertFalse(server.DAILY_SNAPSHOT_LOCK.locked())
        self.analyse.assert_not_called()

    def test_overlapping_run_is_not_reported_successful(self):
        with server.DAILY_SNAPSHOT_LOCK:
            self.assertFalse(server.run_daily_snapshots()["ok"])
        self.analyse.assert_not_called()

    def test_partial_run_returns_http_503(self):
        handler = server.Handler.__new__(server.Handler)
        handler.headers = {}
        replies = []
        handler.send_json = lambda status, body: replies.append(status)
        with patch.object(server, "SNAPSHOT_SECRET", ""), patch.object(server, "run_daily_snapshots", return_value={"ok": False}):
            handler.handle_daily_snapshot(urlparse("/api/snapshot/daily"))
        self.assertEqual(replies, [503])

    def test_error_log_redacts_configured_secrets(self):
        with patch.object(server, "SNAPSHOT_SECRET", "secret-value"):
            self.analyse.side_effect = RuntimeError("secret-value <html>upstream body</html>")
            server.run_daily_snapshots()
        errors = [p["error"] for _, m, p in self.calls if m == "PATCH"]
        self.assertTrue(all("secret-value" not in e and "upstream body" not in e for e in errors))


if __name__ == "__main__":
    unittest.main()
