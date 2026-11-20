"""Browser regression checks; run with the campaign Playwright dependencies."""
import unittest
import json
from unittest.mock import patch

from campaign_providers import PublicPosts, visible_metrics


class PublicMetricBrowserTests(unittest.TestCase):
    def test_tiktok_photo_reads_counts_for_the_same_post_id(self):
        with PublicPosts() as provider:
            provider.start()
            page = provider.browser.new_page()
            payload = json.dumps({"__DEFAULT_SCOPE__": {"webapp.video-detail": {
                "itemInfo": {"itemStruct": {"id": "123", "stats": {
                    "playCount": 960, "diggCount": 77, "commentCount": 1, "shareCount": 1}}}}}})
            page.route("**/*", lambda route: route.fulfill(
                content_type="text/html", body=(
                    '<div data-e2e="video-detail">Photo post</div>'
                    '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">'
                    + payload + '</script>')))
            result = provider.read_post(page, {"platform": "tiktok",
                "url": "https://www.tiktok.com/@show/photo/123", "preview": {"version": 2}})
            self.assertEqual(page.url, "https://www.tiktok.com/@show/video/123")
            self.assertEqual(result.metrics, {
                "views": 960, "likes": 77, "comments": 1, "shares": 1, "engagements": 79})

    def test_facebook_icon_counts_with_and_without_saved_preview(self):
        with PublicPosts() as provider:
            provider.start()
            page = provider.browser.new_page()
            page.route("**/*", lambda route: route.fulfill(
                content_type="text/html", body=(
                    '<p>2026 tickets available</p>'
                    '<div title="Like"><i></i>23</div>'
                    '<div title="Comment"><i></i>3</div>'
                    '<div title="Share"><i></i>12</div>'
                    '<div title="Like">Like this post</div>'
                    if "/plugins/" in route.request.url else
                    '<article><p>A photo of Hades</p></article>')))
            with patch.object(provider, "screenshot", return_value=None):
                for preview in (None, {"version": 2}):
                    with self.subTest(preview=preview):
                        result = provider.read_post(page, {
                            "platform": "facebook", "url": "https://www.facebook.com/posts/123",
                            "preview": preview})
                        self.assertEqual(result.metrics, {
                            "likes": 23, "comments": 3, "shares": 12, "engagements": 38})
            page.set_content('<p>23</p><p>3</p><p>12</p><p>Like</p>')
            self.assertEqual(visible_metrics(provider.labels(page.locator("body"))), {})
            page.set_content('<div title="Like">0</div><div title="Comment">1.2K</div>')
            self.assertEqual(visible_metrics(provider.labels(page.locator("body"))),
                             {"likes": 0, "comments": 1200})


if __name__ == "__main__":
    unittest.main()
