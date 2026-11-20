"""Observe public post metrics and save a visual record without signing in."""
from base64 import b64encode
from contextlib import ExitStack
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
import json
import os
import re
from urllib.parse import parse_qs, quote, urlsplit


PAGE_HOSTS = {
    "facebook": {"www.facebook.com", "m.facebook.com", "facebook.com", "fb.watch"},
    "instagram": {"www.instagram.com", "instagram.com"},
    "tiktok": {"www.tiktok.com", "tiktok.com", "vm.tiktok.com", "vt.tiktok.com"},
}
RESOURCE_DOMAINS = {
    "facebook": ("facebook.com", "fbcdn.net", "fbsbx.com"),
    "instagram": ("instagram.com", "cdninstagram.com", "fbcdn.net"),
    "tiktok": ("tiktok.com", "tiktokcdn.com", "tiktokcdn-us.com", "tiktokcdn-eu.com",
               "tiktokv.com", "tiktokv.us", "byteoversea.com", "ibytedtos.com", "muscdn.com", "ttwstatic.com"),
}
POST_LOCATORS = {
    "facebook": '[role="article"], article, .userContentWrapper, [data-ad-preview="message"], video',
    "instagram": '.Embed, article, [data-testid="post-container"]',
    "tiktok": '[data-e2e="browse-video"], [data-e2e="video-detail"], [class*="DivVideoDetailContainer"]',
}
METRIC_NAMES = {
    "views": r"views?|plays?",
    "clicks": r"link clicks?|post clicks?",
    "likes": r"(?:all\s+)?(?:likes?|reactions?)",
    "comments": r"comments?",
    "shares": r"shares?",
    "engagements": r"engagements?|interactions?",
}
COUNT = r"(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+(?:\.[0-9]+)?)(?:\s*[KMB])?"
LOCKED = re.compile(r"page (?:isn't|is not) available|post (?:isn't|is not) available|content isn't available|video currently unavailable|log in to continue", re.I)


class ProviderError(Exception):
    pass


@dataclass
class Observation:
    metrics: dict
    status: str
    preview: dict | None = None
    image: str | None = None


def count_value(value):
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        return None
    raw = str(value).upper().replace(",", "").replace(" ", "")
    if not re.fullmatch(r"\d+(?:\.\d+)?[KMB]?", raw):
        return None
    scale = {"K": 1000, "M": 1000000, "B": 1000000000}.get(raw[-1], 1)
    try:
        count = int(Decimal(raw[:-1] if scale != 1 else raw) * scale)
    except (InvalidOperation, ValueError):
        return None
    return count if 0 <= count < 2**63 else None


def visible_metrics(labels):
    labels = [part.strip() for label in labels for part in re.split(r"[·•]", label)]
    labels = [re.sub(r"^(?:like|comment|share|react),\s*", "", label, flags=re.I) for label in labels]
    counts = {}
    for name, words in METRIC_NAMES.items():
        forward = re.compile(rf"({COUNT})\s+(?:{words})", re.I)
        reverse = re.compile(rf"(?:{words})\s*:?\s*({COUNT})", re.I)
        values = set()
        for label in labels:
            match = forward.fullmatch(label.strip()) or reverse.fullmatch(label.strip())
            if match and (count := count_value(match[1])) is not None:
                values.add(count)
        if len(values) == 1:
            counts[name] = values.pop()
    if "engagements" not in counts and all(key in counts for key in ("likes", "comments", "shares")):
        counts["engagements"] = counts["likes"] + counts["comments"] + counts["shares"]
    return counts


def tiktok_metrics(raw, url):
    match = re.search(r"/(?:video|photo)/(\d+)", url)
    if not match or not raw:
        return {}
    try:
        item = json.loads(raw)["__DEFAULT_SCOPE__"]["webapp.video-detail"]["itemInfo"]["itemStruct"]
        if str(item.get("id")) != match[1]:
            return {}
        stats = item.get("statsV2") or item["stats"]
        metrics = {"views": count_value(stats.get("playCount"))}
        per_action = {"likes": "diggCount", "comments": "commentCount", "shares": "shareCount"}
        counts = [count_value(stats.get(key)) for key in per_action.values()]
        metrics.update(zip(per_action, counts))
        if all(count is not None for count in counts):
            metrics["engagements"] = sum(counts)
        return {key: value for key, value in metrics.items() if value is not None}
    except (ValueError, KeyError, TypeError, AttributeError):
        return {}


def embed_url(platform, url):
    if platform == "facebook" and urlsplit(url).hostname != "fb.watch":
        path = urlsplit(url).path
        if not path.startswith("/share/"):
            plugin = "video.php" if re.search(r"/(?:videos|reel)/", path) or "v" in parse_qs(urlsplit(url).query) else "post.php"
            return f"https://www.facebook.com/plugins/{plugin}?href={quote(url, safe='')}&width=500&show_text=true"
    if platform == "instagram" and not urlsplit(url).path.startswith("/stories/"):
        return url.rstrip("/") + "/embed/captioned/"
    if platform == "tiktok":
        # Photo URLs omit server-rendered stats; the public video detail route
        # serves the same photo post. tiktok_metrics verifies its exact ID.
        return re.sub(r"(/@[^/]+/)photo/(\d+)(?=/|[?#]|$)", r"\1video/\2", url, count=1)
    return url


def allow_request(platform, url, is_main_navigation):
    try:
        parsed = urlsplit(url)
        host = parsed.hostname
        if parsed.scheme != "https" or not host or parsed.netloc.lower() != host:
            return False
        if is_main_navigation:
            return host in PAGE_HOSTS[platform]
        return any(host == suffix or host.endswith("." + suffix) for suffix in RESOURCE_DOMAINS[platform])
    except ValueError:
        return False


class PublicPosts:
    def __init__(self):
        self.resources = ExitStack()
        self.browser = None
        self.start_error = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.resources.close()

    def start(self):
        if self.start_error:
            raise self.start_error
        if self.browser is not None:
            return
        try:
            from playwright.sync_api import Error, sync_playwright
        except ImportError as exc:
            self.start_error = ProviderError("The public post browser has not been installed.")
            raise self.start_error from exc
        self.browser_error = Error
        try:
            playwright = self.resources.enter_context(sync_playwright())
            domains = {host for hosts in PAGE_HOSTS.values() for host in hosts}
            for suffixes in RESOURCE_DOMAINS.values():
                for suffix in suffixes:
                    domains.update((suffix, "*." + suffix))
            rules = ", ".join(["MAP * ~NOTFOUND", *(f"EXCLUDE {host}" for host in sorted(domains))])
            self.browser = playwright.chromium.launch(
                headless=True, channel=os.environ.get("CAMPAIGN_CHROMIUM_CHANNEL") or None,
                args=[f"--host-resolver-rules={rules}"],
            )
            self.resources.callback(self.browser.close)
        except Error as exc:
            self.start_error = ProviderError("The public post browser could not start.")
            raise self.start_error from exc

    def observe(self, post):
        self.start()
        if post["platform"] == "facebook" and (post.get("preview") or {}).get("version", 0) < 2:
            post = {**post, "preview": None}
        platform = post["platform"]
        context = self.browser.new_context(viewport={"width": 600, "height": 780}, service_workers="block")
        page = context.new_page()
        page.set_default_timeout(4000)

        def route_request(route):
            request = route.request
            try:
                main_navigation = request.is_navigation_request() and request.frame == page.main_frame
            except self.browser_error:
                main_navigation = request.is_navigation_request()
            if allow_request(platform, request.url, main_navigation):
                route.continue_()
            else:
                route.abort()

        page.route("**/*", route_request)
        try:
            return self.read_post(page, post)
        except self.browser_error:
            return Observation({}, "The platform could not load this public post during the check.")
        finally:
            context.close()

    def open_post(self, page, platform, url, selector):
        try:
            response = page.goto(url, wait_until="domcontentloaded", timeout=12000)
            if not response or response.status >= 400 or not allow_request(platform, page.url, True):
                return None
            self.dismiss_login_prompt(page)
            target = page.locator(selector).filter(visible=True).first
            target.wait_for(state="visible")
            self.dismiss_login_prompt(page)
            if not LOCKED.search(target.inner_text()[:2000]):
                return target
        except self.browser_error:
            pass
        return None

    def read_post(self, page, post):
        platform = post["platform"]
        url = post["url"]
        embed = embed_url(platform, url)
        selector = "body" if platform == "facebook" and "/plugins/" in urlsplit(embed).path else POST_LOCATORS[platform]
        target = self.open_post(page, platform, embed, selector)
        if not target and embed != url:
            target = self.open_post(page, platform, url, POST_LOCATORS[platform])

        metrics = {}
        if platform == "tiktok":
            payload = page.locator('script[id="__UNIVERSAL_DATA_FOR_REHYDRATION__"]')
            if payload.count():
                metrics = tiktok_metrics(payload.text_content(), page.url)
        if target:
            context = self.metric_scope(page, platform, target)
            metrics = {**visible_metrics(self.labels(context)), **metrics}

        if platform == "tiktok" and not post["preview"]:
            video = re.search(r"/(?:video|photo)/(\d+)", page.url)
            if video:
                player = f"https://www.tiktok.com/player/v1/{video[1]}?controls=0&description=1"
                target = self.open_post(page, platform, player, '[class*="EmbedPlayerContainer"]') or target

        canonical = page.url
        capture_target = self.post_capture_target(platform, target) if target else None
        image = self.screenshot(page, capture_target) if capture_target and not post["preview"] else None
        if platform == "facebook" and "/plugins/" not in urlsplit(canonical).path:
            public_embed = embed_url("facebook", canonical)
            if public_embed != canonical:
                embedded = self.open_post(page, platform, public_embed, "body")
                if embedded:
                    metrics.update(visible_metrics(self.labels(embedded)))
                    if not post["preview"] and self.has_post_media(embedded):
                        image = self.screenshot(page, embedded) or image
        preview = {"kind": "screenshot", "version": 2} if image else None
        # The official Facebook embed sometimes shows the media but omits the
        # reel's public reaction, comment and share buttons.
        if platform == "facebook" and "/plugins/" in urlsplit(page.url).path and "engagements" not in metrics:
            direct = self.open_post(page, platform, url, POST_LOCATORS[platform])
            if direct:
                metrics.update(visible_metrics(self.labels(self.metric_scope(page, platform, direct))))
        status = "Public metrics captured." if metrics else "The platform showed no public views, clicks or total engagement."
        if not image and not post["preview"]:
            status += " A clear public screenshot was unavailable; it will be retried."
        if not target and not metrics and not image:
            status = "A public preview was unavailable or the platform required sign-in."
        return Observation(metrics, status, preview, image)

    def metric_scope(self, page, platform, target):
        path = urlsplit(page.url).path
        if platform == "facebook" and (path.startswith("/plugins/") or path.startswith("/reel/")):
            return page.locator("body")
        return target

    def labels(self, target):
        return target.evaluate(r"""element => {
            const lines = element.innerText.split(/\n+/).map(line => line.trim());
            const adjacent = lines.flatMap((line, index) =>
                /^(?:all\s+)?(?:reactions?|likes?|shares?|comments?|views?)\s*:?$/i.test(line)
                    ? [line + " " + (lines[index + 1] || "")] : []);
            return [
            ...lines, ...adjacent,
            ...Array.from(element.querySelectorAll('[aria-label], [title]')).flatMap(
                node => {
                    const title = node.getAttribute('title');
                    // Official Facebook embeds render bare counts beside titled icons.
                    const countLabel = /^(?:like|comment|share)$/i.test(title || '')
                        ? title + ' ' + node.innerText.trim() : null;
                    return [node.getAttribute('aria-label'), title, countLabel].filter(Boolean);
                })
        ].slice(0, 300);
        }""")

    def dismiss_login_prompt(self, page):
        """Use the platform's own dismiss control when a public post is obscured."""
        dialogs = page.get_by_role("dialog").filter(visible=True)
        for dialog in dialogs.all():
            if not dialog.locator('input[type="password"], input[name="email"]').count():
                continue
            close = dialog.get_by_role("button", name=re.compile(r"^close$", re.I))
            if close.count() and close.first.is_visible():
                close.first.click(timeout=2000)
                dialog.wait_for(state="hidden", timeout=2000)

    def has_post_media(self, target):
        return target.evaluate("""element => Array.from(element.querySelectorAll('video, img')).some(media => {
            const box = media.getBoundingClientRect();
            return box.width >= 140 && box.height >= 100 &&
                (media.tagName === 'VIDEO' || media.complete && media.naturalWidth >= 140);
        })""")

    def post_capture_target(self, platform, target):
        if platform != "facebook":
            return target
        # Facebook may identify only its caption with data-ad-preview. Include
        # the nearest post container holding the photo or video as well.
        candidate = target
        for _ in range(8):
            if self.has_post_media(candidate):
                return candidate
            parent = candidate.locator("..")
            if not parent.count() or parent.evaluate("element => element.tagName === 'BODY'"):
                break
            candidate = parent
        return target

    def screenshot(self, page, target):
        try:
            self.dismiss_login_prompt(page)
            if page.locator('input[type="password"]:visible, input[name="email"]:visible').count():
                return None
            target.scroll_into_view_if_needed()
            box = target.bounding_box()
            if not box or box["width"] < 100 or box["height"] < 80:
                return None
            if box["height"] > page.viewport_size["height"]:
                page.set_viewport_size({"width": 600, "height": min(1600, int(box["height"]) + 32)})
                target.scroll_into_view_if_needed()
                box = target.bounding_box()
            # Refuse a capture if an unrelated dialog covers the post.
            blocked = target.evaluate("""element => {
                const r = element.getBoundingClientRect();
                const hit = document.elementFromPoint(
                    Math.max(1, Math.min(innerWidth-1, r.x+r.width/2)),
                    Math.max(1, Math.min(innerHeight-1, r.y+Math.min(r.height/2, innerHeight/2))));
                return !!hit && !!hit.closest('[role="dialog"]') &&
                    !element.contains(hit) && !hit.contains(element);
            }""")
            if blocked:
                return None
            # Clip to the visible post rather than saving recommendation panels.
            viewport = page.viewport_size
            x, y = max(0, box["x"]), max(0, box["y"])
            width = min(viewport["width"] - x, box["width"])
            height = min(viewport["height"] - y, box["height"])
            if width < 100 or height < 80:
                return None
            screenshot = page.screenshot(type="jpeg", quality=74, animations="disabled", timeout=5000,
                                         clip={"x": x, "y": y, "width": width, "height": height})
            if len(screenshot) <= 600_000:
                return "data:image/jpeg;base64," + b64encode(screenshot).decode("ascii")
        except self.browser_error:
            pass
        return None
