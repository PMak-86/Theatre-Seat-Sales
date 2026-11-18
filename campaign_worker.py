"""Run scheduled public campaign captures on the GitHub Actions browser worker."""
import json
import os
import sys
from datetime import datetime, timezone
from time import monotonic
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from campaign import instant
from campaign_providers import PublicPosts


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def worker_request(base, secret, action, **payload):
    request = Request(
        base + "/api/snapshot/campaigns",
        data=json.dumps({"action": action, **payload}).encode(),
        headers={"Content-Type": "application/json", "X-Snapshot-Secret": secret},
    )
    try:
        with build_opener(NoRedirect()).open(request, timeout=35) as response:
            return json.load(response)
    except HTTPError as exc:
        raise RuntimeError(f"Campaign worker {action} request returned HTTP {exc.code}.") from None


def run():
    base = os.environ["RENDER_APP_URL"].rstrip("/")
    secret = os.environ["SNAPSHOT_SECRET"]
    target = urlsplit(base)
    if not secret or target.scheme != "https" or target.netloc != "theatre-seat-sales.onrender.com" or target.path or target.query or target.fragment:
        raise RuntimeError("The campaign worker must use the Theatre Seat Sales HTTPS service and its snapshot secret.")
    queued = worker_request(base, secret, "queue")["postIds"]
    if "--check" in sys.argv:
        print("true" if queued else "false")
        return
    deadline = monotonic() + 12 * 60
    checked = recorded = metrics_available = 0
    with PublicPosts() as provider:
        for post_id in queued:
            if monotonic() >= deadline:
                break
            post = worker_request(base, secret, "claim", postId=post_id)["post"]
            if not post or datetime.now(timezone.utc) >= instant(post["finishAt"]):
                continue
            observation = provider.observe(post)
            checked += 1
            if datetime.now(timezone.utc) >= instant(post["finishAt"]):
                continue
            if worker_request(base, secret, "record", postId=post_id, status=observation.status,
                              metrics=observation.metrics, image=observation.image, attemptAt=post["attemptAt"])["recorded"]:
                recorded += 1
                metrics_available += bool(observation.metrics)
    print(f"Due posts: {len(queued)}. Checked: {checked}. Recorded: {recorded}. With public metrics: {metrics_available}.")


if __name__ == "__main__":
    run()
