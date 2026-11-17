"""Campaign validation, snapshot cadence and service-role persistence."""
from datetime import date, datetime, timedelta, timezone
from urllib.parse import parse_qs, quote, urlencode, urlsplit, urlunsplit
from uuid import UUID
import re


PLATFORMS = {
    "facebook": {"facebook.com", "www.facebook.com", "m.facebook.com", "fb.watch"},
    "instagram": {"instagram.com", "www.instagram.com"},
    "tiktok": {"www.tiktok.com", "tiktok.com", "vm.tiktok.com", "vt.tiktok.com"},
}
POST_TYPES = {"photo", "video", "reel", "carousel", "story", "link", "text", "other"}
POST_FIELDS = "id,published_on,platform,post_type,url,notes,preview,capture_status,last_attempt_at"
CAPTURE_FIELDS = "captured_at,cadence,views,clicks,engagements,likes,comments,shares"
FINAL_PERFORMANCE_RUNTIME = timedelta(hours=3)


class CampaignError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def post_notes(value):
    if not isinstance(value, str) or len(value) > 1000 or "\x00" in value:
        raise CampaignError("Post notes must be text and at most 1,000 characters.")
    return value.strip()


def instant(value):
    if not isinstance(value, str) or len(value) > 64:
        raise CampaignError("Enter a date and time with a time zone.")
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise CampaignError("Enter a valid date and time.") from exc
    if result.tzinfo is None:
        raise CampaignError("Enter a date and time with a time zone.")
    return result.astimezone(timezone.utc)


def post_url(value, platform):
    if not isinstance(platform, str) or platform not in PLATFORMS:
        raise CampaignError("Choose Facebook, Instagram or TikTok.")
    if not isinstance(value, str) or not 1 <= len(value) <= 2048 or re.search(r"[\s\\\x00-\x1f]", value):
        raise CampaignError("Enter a valid HTTPS post URL.")
    try:
        parsed = urlsplit(value)
        host = parsed.hostname
        valid = parsed.scheme == "https" and parsed.netloc.lower() == host and host in PLATFORMS[platform]
    except ValueError:
        valid = False
    if not valid:
        raise CampaignError("The URL must match the selected social platform.")
    path = parsed.path.rstrip("/")
    query = parse_qs(parsed.query)
    if platform == "instagram":
        match = re.fullmatch(r"/(?:[A-Za-z0-9_.]+/)?(p|reels?|tv)/([A-Za-z0-9_-]+)", path)
        if match:
            kind = "reel" if match[1] == "reels" else match[1]
            return f"https://www.instagram.com/{kind}/{match[2]}/", match[2]
        story = re.fullmatch(r"/stories/([A-Za-z0-9_.]+)/(\d+)", path)
        if story:
            return f"https://www.instagram.com{path}/", f"story-{story[2]}"
    elif platform == "tiktok":
        match = re.fullmatch(r"/@[\w.]+/(?:video|photo)/(\d+)", path, re.ASCII)
        if match:
            return f"https://www.tiktok.com{path}", match[1]
    else:
        match = re.search(r"/(?:posts|reel|videos)/([A-Za-z0-9_]+)$", path)
        post_id = (query.get("story_fbid") or query.get("fbid") or query.get("v") or [""])[0]
        if match or re.fullmatch(r"[A-Za-z0-9_]+", post_id):
            key = match[1] if match else post_id
            preserved = {k: query[k][0] for k in ("story_fbid", "fbid", "v", "id") if query.get(k)}
            return urlunsplit(("https", "www.facebook.com", path, urlencode(preserved), "")), key
    if (host in {"fb.watch", "vm.tiktok.com", "vt.tiktok.com"} and re.fullmatch(r"/[A-Za-z0-9_-]+", path)
            or platform == "facebook" and re.fullmatch(r"/share/(?:[prv]/)?[A-Za-z0-9_-]+", path)):
        return urlunsplit(("https", host, path, "", "")), host + path
    raise CampaignError("Use a link to an individual post, reel or video.")


def capture_cadence(now, opening, finish, published_on, last_capture, local_day):
    """Return the due cadence on Sydney calendar dates, with an exact finish cutoff."""
    if now >= finish:
        return None
    today = local_day(now)
    if published_on > today:
        return None
    if last_capture is not None and local_day(last_capture) >= today:
        return None
    if today >= local_day(opening) - timedelta(days=7):
        return "daily"
    if last_capture is None or today >= local_day(last_capture) + timedelta(days=7):
        return "weekly"
    return None


class CampaignStore:
    def __init__(self, request, select_all, local_day):
        self.request = request
        self.select_all = select_all
        self.local_day = local_day

    def event(self, url):
        if not isinstance(url, str) or not 1 <= len(url) <= 2048:
            raise CampaignError("Load a show before opening its campaign.")
        rows = self.request(f"tracked_events?event_url=eq.{quote(url, safe='')}&select=id,date_start,date_end&limit=1")
        if not rows:
            raise CampaignError("Analyse the show first so it can be tracked.", 404)
        return rows[0]

    def load(self, event):
        event_id = event["id"]
        posts = self.select_all(
            f"campaign_posts?tracked_event_id=eq.{event_id}&removed_at=is.null&select={POST_FIELDS},campaign_captures({CAPTURE_FIELDS})"
            "&order=published_on.desc,id.asc&campaign_captures.order=captured_at.desc&campaign_captures.limit=1"
        )
        finish = instant(event["date_end"]) + FINAL_PERFORMANCE_RUNTIME if event["date_end"] else None
        return {"openingAt": event["date_start"], "lastPerformanceAt": event["date_end"],
                "finishAt": finish.isoformat() if finish else None, "posts": posts}

    def post_values(self, body):
        platform = body.get("platform")
        url, key = post_url(body.get("url"), platform)
        post_type = body.get("postType")
        if not isinstance(post_type, str) or post_type not in POST_TYPES:
            raise CampaignError("Choose a post type.")
        try:
            published_on = date.fromisoformat(body.get("publishedOn", ""))
        except (TypeError, ValueError) as exc:
            raise CampaignError("Enter a valid publication date.") from exc
        if published_on > self.local_day(datetime.now(timezone.utc)):
            raise CampaignError("The publication date must be today or earlier.")
        return {
            "published_on": published_on.isoformat(), "platform": platform, "post_type": post_type,
            "url": url, "source_key": key, "notes": post_notes(body.get("notes", "")),
        }

    def add_post(self, event, body):
        try:
            rows = self.request(f"campaign_posts?select={POST_FIELDS}", "POST",
                                {"tracked_event_id": event["id"], **self.post_values(body)}, "return=representation")
        except Exception as exc:
            if "23505" in str(exc):
                raise CampaignError("That post is already logged for this show.", 409) from exc
            raise
        if not rows:
            raise CampaignError("That post is already logged for this show.", 409)
        return rows[0]

    def edit_post(self, event, post_id, body):
        path = self.post_path(event, post_id)
        existing = self.request(f"{path}&removed_at=is.null&select={POST_FIELDS}")
        if not existing:
            raise CampaignError("This post is not logged for the show.", 404)
        current = existing[0]
        values = self.post_values({
            **body, "platform": current["platform"], "url": current["url"],
        })
        changes = {key: values[key] for key in ("published_on", "post_type", "notes")}
        rows = self.request(f"{path}&removed_at=is.null&select={POST_FIELDS}", "PATCH", changes, "return=representation")
        if not rows:
            raise CampaignError("This entry has been removed. Reload the campaign.", 409)
        return rows[0]

    def remove_post(self, event, post_id, restore=False):
        path = self.post_path(event, post_id)
        try:
            rows = self.request(f"{path}&select=id", "PATCH",
                                {"removed_at": None if restore else datetime.now(timezone.utc).isoformat()},
                                "return=representation")
        except Exception as exc:
            if restore and "23505" in str(exc):
                raise CampaignError("This post has been logged again. Remove the duplicate before restoring.", 409) from exc
            raise
        if not rows:
            raise CampaignError("This post is not logged for the show.", 404)
        return rows[0]

    def post_path(self, event, post_id):
        try:
            post_id = UUID(post_id)
        except (ValueError, TypeError, AttributeError) as exc:
            raise CampaignError("Invalid post ID.") from exc
        return f"campaign_posts?id=eq.{post_id}&tracked_event_id=eq.{event['id']}"

    def save_notes(self, event, post_id, value):
        path = self.post_path(event, post_id)
        rows = self.request(f"{path}&removed_at=is.null&select=id,notes", "PATCH", {"notes": post_notes(value)}, "return=representation")
        if not rows:
            raise CampaignError("This post is not logged for the show.", 404)
        return rows[0]

    def post_detail(self, event, post_id):
        path = self.post_path(event, post_id)
        rows = self.request(f"{path}&removed_at=is.null&select={POST_FIELDS},preview_image")
        if not rows:
            raise CampaignError("This post is not logged for the show.", 404)
        captures = self.select_all(f"campaign_captures?post_id=eq.{rows[0]['id']}&select={CAPTURE_FIELDS}&order=captured_at.desc")
        return {"post": rows[0], "captures": captures}

    def worker_posts(self, now, post_id=None):
        path = (
            "campaign_posts?removed_at=is.null&select=id,platform,url,published_on,preview,last_attempt_at,"
            "tracked_events!inner(date_start,date_end),campaign_captures(captured_at)&order=id.asc"
            "&campaign_captures.order=captured_at.desc&campaign_captures.limit=1"
            f"&tracked_events.date_end=gt.{quote((now - FINAL_PERFORMANCE_RUNTIME).isoformat(), safe='')}"
        )
        if post_id is not None:
            try:
                path += f"&id=eq.{UUID(post_id)}"
            except (ValueError, TypeError, AttributeError) as exc:
                raise CampaignError("Invalid post ID.") from exc
        for post in self.select_all(path):
            event = post["tracked_events"]
            if not event["date_start"] or not event["date_end"]:
                continue
            finish = instant(event["date_end"]) + FINAL_PERFORMANCE_RUNTIME
            latest = post["campaign_captures"]
            cadence = capture_cadence(now, instant(event["date_start"]), finish,
                                      date.fromisoformat(post["published_on"]),
                                      instant(latest[0]["captured_at"]) if latest else None, self.local_day)
            if cadence:
                yield post, finish, cadence

    def worker_queue(self):
        return [post["id"] for post, _, _ in self.worker_posts(datetime.now(timezone.utc))]

    def claim_capture(self, post_id):
        if not post_id:
            raise CampaignError("Enter a post ID.")
        matches = self.worker_posts(datetime.now(timezone.utc), post_id)
        match = next(matches, None)
        if not match:
            return None
        post, finish, _ = match
        if not self.request("rpc/claim_campaign_post", "POST", {"target": post["id"]}):
            return None
        return {key: post[key] for key in ("id", "platform", "url", "preview")} | {"finishAt": finish.isoformat()}

    def record_capture(self, body):
        post_id = body.get("postId")
        if not post_id:
            raise CampaignError("Enter a post ID.")
        now = datetime.now(timezone.utc)
        match = next(self.worker_posts(now, post_id), None)
        if not match:
            return False
        post, finish, cadence = match
        attempt = instant(post["last_attempt_at"]) if post["last_attempt_at"] else None
        if now >= finish or attempt is None or not timedelta(0) <= now - attempt < timedelta(minutes=50):
            return False
        metrics = body.get("metrics")
        allowed = {"views", "clicks", "engagements", "likes", "comments", "shares"}
        if not isinstance(metrics, dict) or metrics.keys() - allowed or any(
            type(value) is not int or not 0 <= value < 2**63 for value in metrics.values()
        ):
            raise CampaignError("Invalid public metrics.")
        status = body.get("status")
        if not isinstance(status, str) or not 0 < len(status) <= 250:
            raise CampaignError("Invalid capture status.")
        changes = {"capture_status": status}
        image = body.get("image")
        if image and not post["preview"]:
            if not isinstance(image, str) or len(image) > 800100 or not re.fullmatch(r"data:image/jpeg;base64,[A-Za-z0-9+/]+={0,2}", image):
                raise CampaignError("Invalid screenshot.")
            changes.update(preview={"kind": "screenshot", "capturedAt": now.isoformat()}, preview_image=image)
        self.request(f"campaign_posts?id=eq.{post['id']}&removed_at=is.null", "PATCH", changes, "return=minimal")
        self.request("campaign_captures?on_conflict=post_id,capture_day", "POST", {
            "post_id": post["id"], "capture_day": self.local_day(now).isoformat(),
            "captured_at": now.isoformat(), "cadence": cadence, **metrics,
        }, "resolution=ignore-duplicates,return=minimal")
        return True
