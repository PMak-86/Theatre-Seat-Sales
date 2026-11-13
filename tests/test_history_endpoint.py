"""Regression checks for the opt-in dashboard history representation."""
import unittest
from unittest.mock import patch
from urllib.parse import urlparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import Handler


class HistoryEndpointTests(unittest.TestCase):
    def call(self, query):
        handler = Handler.__new__(Handler)
        replies = []
        handler.send_json = lambda status, body: replies.append((status, body))
        payload = {
            "event": {"event_id": 123},
            "snapshots": [{"actual_sold": 37, "effective_sold": 42}],
            "performances": [{"breakdown": [{"code": "H", "count": 5}]}],
            "uplift": {"day": {"actualSoldChange": -2}},
        }
        with patch("server.event_history", return_value=payload) as history:
            handler.handle_history(urlparse("/api/history?" + query))
        return replies[0], payload, history

    def test_existing_callers_keep_full_history(self):
        (status, body), original, call = self.call("eventId=123")
        self.assertEqual(status, 200)
        self.assertEqual(body, original)
        self.assertIn("performances", body)
        call.assert_called_once_with(123, None)

    def test_summary_keeps_corrected_sales_and_uplift(self):
        (status, body), original, _ = self.call("eventId=123&view=summary")
        self.assertEqual(status, 200)
        self.assertNotIn("performances", body)
        for key in ("event", "snapshots", "uplift"):
            self.assertEqual(body[key], original[key])
        self.assertIn("performances", original)

    def test_url_lookup_works_with_summary(self):
        (_, body), _, call = self.call("eventUrl=https%3A%2F%2Fbooking.example%2F123&view=summary")
        call.assert_called_once_with(None, "https://booking.example/123")
        self.assertNotIn("performances", body)

    def test_invalid_event_still_returns_error(self):
        (status, body), _, call = self.call("eventId=invalid&view=summary")
        self.assertEqual(status, 400)
        self.assertIn("error", body)
        call.assert_not_called()


if __name__ == "__main__":
    unittest.main()
