import io
import json
import unittest
from datetime import date, datetime, timedelta, timezone
from unittest.mock import Mock, patch

from campaign import CampaignError, CampaignStore, capture_cadence, post_url
from campaign_providers import allow_request, tiktok_metrics, visible_metrics
from server import Handler, sydney_local_day


class CampaignTests(unittest.TestCase):
    def test_post_notes_are_optional_and_trimmed(self):
        request = Mock(return_value=[{"id": "post"}])
        store = CampaignStore(request, Mock(), sydney_local_day)
        body = {"platform": "facebook", "postType": "reel", "url": "https://www.facebook.com/reel/123",
                "publishedOn": "2026-01-01"}
        store.add_post({"id": "show"}, body)
        self.assertEqual(request.call_args.args[2]["notes"], "")
        store.add_post({"id": "show"}, {**body, "notes": "  Ticket offer\nBehind the scenes  "})
        self.assertEqual(request.call_args.args[2]["notes"], "Ticket offer\nBehind the scenes")

    def test_notes_updates_are_scoped_to_the_show_and_can_clear_the_field(self):
        post_id = "10000000-0000-0000-0000-000000000001"
        request = Mock(return_value=[{"id": post_id, "notes": ""}])
        store = CampaignStore(request, Mock(), sydney_local_day)
        self.assertEqual(store.save_notes({"id": "show"}, post_id, " "), {"id": post_id, "notes": ""})
        request.assert_called_once_with(
            f"campaign_posts?id=eq.{post_id}&tracked_event_id=eq.show&removed_at=is.null&select=id,notes",
            "PATCH", {"notes": ""}, "return=representation",
        )
        request.return_value = []
        with self.assertRaises(CampaignError) as error:
            store.save_notes({"id": "different-show"}, post_id, "Offer")
        self.assertEqual(error.exception.status, 404)
        for notes in (None, 12, "x" * 1001, "bad\x00note"):
            with self.subTest(notes=notes), self.assertRaises(CampaignError):
                store.save_notes({"id": "show"}, post_id, notes)

    def test_edit_corrects_date_type_and_notes_without_replacing_history(self):
        post_id = "10000000-0000-0000-0000-000000000001"
        request = Mock(side_effect=[
            [{"platform": "facebook", "url": "https://www.facebook.com/reel/123"}],
            [{"id": post_id, "published_on": "2026-01-02"}],
        ])
        store = CampaignStore(request, Mock(), sydney_local_day)
        edited = store.edit_post({"id": "show"}, post_id, {
            "publishedOn": "2026-01-02", "postType": "video", "notes": "Ticket offer",
        })
        self.assertEqual(edited["published_on"], "2026-01-02")
        call = request.call_args
        self.assertIn("tracked_event_id=eq.show&removed_at=is.null", call.args[0])
        self.assertEqual(call.args[2], {"published_on": "2026-01-02", "post_type": "video", "notes": "Ticket offer"})
        self.assertNotIn("preview", call.args[2])

    def test_remove_is_reversible_and_stops_worker_selection(self):
        post_id = "10000000-0000-0000-0000-000000000001"
        request = Mock(return_value=[{"id": post_id}])
        select = Mock(return_value=[])
        store = CampaignStore(request, select, sydney_local_day)
        store.remove_post({"id": "show"}, post_id)
        self.assertIsNotNone(request.call_args.args[2]["removed_at"])
        store.remove_post({"id": "show"}, post_id, restore=True)
        self.assertIsNone(request.call_args.args[2]["removed_at"])
        store.worker_queue()
        self.assertIn("removed_at=is.null", select.call_args.args[0])

    def test_deduplicates_instagram_account_and_tracking_variants(self):
        a = post_url("https://www.instagram.com/gosfordmusicalsociety/reel/Db4dXtzoPQe/?igsh=tracking", "instagram")
        b = post_url("https://instagram.com/reel/Db4dXtzoPQe/", "instagram")
        self.assertEqual(a, b)

    def test_rejects_untrusted_urls_and_profile_pages(self):
        for url in ("https://www.facebook.com.evil.test/reel/123", "https://www.facebook.com@evil.test/reel/123",
                    "http://www.facebook.com/reel/123", "https://www.facebook.com:443/reel/123",
                    "https://www.facebook.com/facade", "https://www.facebook.com\\@127.0.0.1/reel/123"):
            with self.subTest(url=url), self.assertRaises(CampaignError):
                post_url(url, "facebook")
        self.assertFalse(allow_request("facebook", "https://facebook.com.evil.test/image", False))
        self.assertFalse(allow_request("instagram", "https://127.0.0.1/image", False))
        self.assertTrue(allow_request("instagram", "https://scontent.example.cdninstagram.com/image", False))
        self.assertFalse(allow_request("instagram", "https://scontent.example.cdninstagram.com/image", True))

    def test_weekly_switches_to_daily_in_sydney_without_waiting_a_full_week(self):
        opening = datetime.fromisoformat("2026-12-01T19:30:00+11:00")
        finish = opening + timedelta(days=4, hours=3)
        published = date(2026, 11, 1)
        first = datetime.fromisoformat("2026-11-12T08:00:00+11:00")

        def due(now, previous=first):
            return capture_cadence(datetime.fromisoformat(now), opening, finish, published, previous, sydney_local_day)

        self.assertIsNone(due("2026-11-12T08:00:00+11:00", None))
        self.assertEqual(due("2026-11-16T08:00:00+11:00"), "weekly")
        self.assertIsNone(due("2026-11-17T08:00:00+11:00"))
        self.assertIsNone(due("2026-11-18T21:30:00+11:00"))
        self.assertIsNone(due("2026-11-19T05:30:00+11:00"))
        self.assertEqual(due("2026-11-23T13:00:00+00:00", first + timedelta(days=11)), "daily")
        self.assertIsNone(due("2026-11-24T21:30:00+11:00", datetime.fromisoformat("2026-11-24T09:00:00+11:00")))
        self.assertEqual(due("2026-12-05T22:29:00+11:00"), "daily")
        self.assertIsNone(due("2026-12-05T22:30:00+11:00"))

    def test_public_counts_do_not_confuse_unknown_with_zero(self):
        self.assertEqual(visible_metrics(["0 views", "13 likes", "2 comments"]),
                         {"views": 0, "likes": 13, "comments": 2})
        self.assertEqual(visible_metrics(["12 link clicks", "1.2K reactions", "2 comments", "4 shares"]),
                         {"clicks": 12, "likes": 1200, "comments": 2, "shares": 4, "engagements": 1206})
        self.assertEqual(visible_metrics(["5 views", "9 views", "4 comments", "5 replies"]), {"comments": 4})
        self.assertEqual(visible_metrics(["Like, 39 reactions", "Comment, 1 comment", "Share, 18 shares"])["engagements"], 58)

    def test_tiktok_counts_are_scoped_to_requested_post(self):
        fixture = json.dumps({"__DEFAULT_SCOPE__": {"webapp.video-detail": {
            "itemInfo": {"itemStruct": {"id": "123", "stats": {
                "playCount": 382, "diggCount": "18", "commentCount": 2, "shareCount": 0}}}}}})
        self.assertEqual(tiktok_metrics(fixture, "https://www.tiktok.com/@show/video/123"),
                         {"views": 382, "likes": 18, "comments": 2, "shares": 0, "engagements": 20})
        self.assertEqual(tiktok_metrics(fixture, "https://www.tiktok.com/@show/video/999"), {})

    def test_worker_claim_and_record_accept_active_post_and_exclude_ended_show(self):
        now = datetime.now(timezone.utc)
        active_id = "10000000-0000-0000-0000-000000000001"
        ended_id = "10000000-0000-0000-0000-000000000002"
        common = {"platform": "facebook", "url": "https://www.facebook.com/reel/123",
                  "published_on": (now - timedelta(days=1)).date().isoformat(), "preview": None,
                  "last_attempt_at": now.isoformat(), "campaign_captures": []}
        active = {**common, "id": active_id, "tracked_events": {
            "date_start": (now + timedelta(days=4)).isoformat(), "date_end": (now + timedelta(days=7)).isoformat()}}
        ended = {**common, "id": ended_id, "tracked_events": {
            "date_start": (now - timedelta(days=5)).isoformat(), "date_end": (now - timedelta(hours=4)).isoformat()}}
        request = Mock(return_value=[{"post_id": active_id, "attempt_at": now.isoformat()}])
        store = CampaignStore(request, Mock(return_value=[active, ended]), sydney_local_day)
        self.assertEqual(store.worker_queue(), [active_id])
        self.assertEqual(store.claim_capture(active_id)["id"], active_id)
        self.assertTrue(store.record_capture(
            {"postId": active_id, "attemptAt": now.isoformat(), "status": "Captured", "metrics": {"views": 0}, "image": "data:image/jpeg;base64,YQ=="}))
        self.assertEqual(request.call_args_list[1].args[2]["preview_image"], "data:image/jpeg;base64,YQ==")
        self.assertEqual(request.call_args_list[2].args[2]["cadence"], "daily")
        self.assertEqual(request.call_args_list[2].args[2]["views"], 0)

    def test_legacy_facebook_preview_is_replaced_by_a_clear_capture(self):
        now = datetime.now(timezone.utc)
        post_id = "10000000-0000-0000-0000-000000000001"
        post = {"id": post_id, "platform": "facebook", "url": "https://www.facebook.com/reel/123",
                "published_on": now.date().isoformat(), "preview": {"kind": "screenshot"},
                "last_attempt_at": now.isoformat(), "campaign_captures": [],
                "tracked_events": {"date_start": (now+timedelta(days=3)).isoformat(),
                                   "date_end": (now+timedelta(days=4)).isoformat()}}
        request = Mock()
        store = CampaignStore(request, Mock(return_value=[post]), sydney_local_day)
        self.assertTrue(store.record_capture({
            "postId": post_id, "attemptAt": now.isoformat(), "metrics": {},
            "status": "Public preview captured", "image": "data:image/jpeg;base64,YQ=="}))
        self.assertEqual(request.call_args_list[0].args[2]["preview"]["version"], 2)
        self.assertEqual(request.call_args_list[0].args[2]["preview_image"], "data:image/jpeg;base64,YQ==")

    def test_manual_request_bypasses_same_day_schedule_and_record_rejects_stale_claim(self):
        now = datetime.now(timezone.utc)
        post_id = "10000000-0000-0000-0000-000000000001"
        post = {"id": post_id, "platform": "facebook", "url": "https://www.facebook.com/reel/123",
                "published_on": now.date().isoformat(), "preview": None,
                "last_attempt_at": now.isoformat(), "refresh_requested_at": now.isoformat(),
                "campaign_captures": [{"captured_at": (now - timedelta(minutes=1)).isoformat()}],
                "tracked_events": {"date_start": (now + timedelta(days=60)).isoformat(),
                                   "date_end": (now + timedelta(days=61)).isoformat()}}
        request = Mock(return_value=[{"post_id": post_id}])
        store = CampaignStore(request, Mock(return_value=[post]), sydney_local_day)
        self.assertEqual(store.worker_queue(), [post_id])
        self.assertFalse(store.record_capture({"postId": post_id, "attemptAt": (now-timedelta(minutes=5)).isoformat()}))
        request.assert_not_called()
        store.request_refresh({"id": "show", "date_end": (now+timedelta(days=3)).isoformat()})
        request.assert_called_once_with("rpc/request_campaign_refresh", "POST", {"show_id": "show"})
        with self.assertRaises(CampaignError):
            store.request_refresh({"id": "ended", "date_end": (now-timedelta(days=1)).isoformat()})

    def test_campaign_data_requires_key_and_snapshots_fail_closed(self):
        handler = Handler.__new__(Handler)
        handler.headers = {}
        handler.send_json = Mock()
        with patch("server.CAMPAIGN_ACCESS_KEY", "test-key"), patch("server.SNAPSHOT_SECRET", ""):
            handler.handle_campaign("GET")
            handler.send_json.assert_called_once_with(401, {"error": "Enter the campaign access key."}, private=True)
            handler.send_json.reset_mock()
            handler.handle_campaign_snapshots()
            handler.send_json.assert_called_once_with(403, {"error": "Invalid snapshot secret."}, private=True)

    def test_campaign_post_uses_validated_event_and_payload(self):
        handler = Handler.__new__(Handler)
        handler.send_json = Mock()
        payload = json.dumps({"action": "post", "eventUrl": "example", "platform": "instagram"}).encode()
        handler.rfile = io.BytesIO(payload)
        handler.headers = Mock()
        handler.headers.get.side_effect = {"Authorization": "Bearer test-key", "Content-Length": str(len(payload))}.get
        handler.headers.get_content_type.return_value = "application/json"
        with patch("server.CAMPAIGN_ACCESS_KEY", "test-key"), patch("server.CampaignStore") as factory:
            store = factory.return_value
            store.event.return_value = {"id": "id"}
            store.add_post.return_value = {"id": "post"}
            handler.handle_campaign("POST")
            store.event.assert_called_once_with("example")
            store.add_post.assert_called_once_with({"id": "id"}, json.loads(payload))
            handler.send_json.assert_called_once_with(201, {"post": {"id": "post"}}, private=True)
