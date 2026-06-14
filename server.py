from __future__ import annotations

import json
import os
import re
import uuid
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, unquote, urlparse
from urllib.request import Request, urlopen


ROOT = Path(__file__).parent
API_BASE = "https://api.ticketsearch.com"
SOLD_PERCENT_HOLD_CODES = {"C", "TT", "P", "T", "COMP", "H"}
SOLD_PERCENT_HOLD_LABELS = {
    "closed seats",
    "venue holds",
    "producer hold",
    "producer holds",
    "promotor",
    "promotor hold",
    "promotor holds",
    "promoter",
    "promoter hold",
    "promoter holds",
    "technician",
    "technician hold",
    "technician holds",
    "comp",
    "comp hold",
    "comp holds",
    "comp seats",
    "complimentary",
    "complimentary seats",
    "house",
    "house seat",
    "house seats",
    "house hold",
    "house holds",
}


class TicketSearchError(Exception):
    pass


def request_json(
    url: str,
    token: str | None = None,
    payload: dict[str, Any] | None = None,
    origin: str | None = None,
    referer: str | None = None,
) -> dict[str, Any]:
    body = None
    method = "GET"
    headers = {
        "Content-Type": "application/json; charset=utf-8",
        "Accept": "application/json",
        "Origin": origin or "https://ccclaycock.sales.ticketsearch.com",
        "Referer": referer or "https://ccclaycock.sales.ticketsearch.com/",
        "User-Agent": "Mozilla/5.0",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if payload is not None:
        method = "POST"
        body = json.dumps(payload).encode("utf-8")

    try:
        with urlopen(Request(url, data=body, headers=headers, method=method), timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        details = exc.read().decode("utf-8", errors="replace")
        raise TicketSearchError(f"TicketSearch returned HTTP {exc.code}: {details}") from exc
    except URLError as exc:
        raise TicketSearchError(f"Could not connect to TicketSearch: {exc.reason}") from exc


def parse_event_input(value: str) -> tuple[str, str, int]:
    raw = value.strip()
    if not raw:
        raise TicketSearchError("Enter a TicketSearch event URL or event number.")

    if raw.isdigit():
        return "ccclaycock", "https://ccclaycock.sales.ticketsearch.com", int(raw)

    parsed = urlparse(raw)
    host = parsed.netloc.lower()
    match = re.search(r"/salesevent/(\d+)", parsed.path, re.IGNORECASE)
    if not host or not match:
        raise TicketSearchError("The URL must look like https://org.sales.ticketsearch.com/sales/salesevent/12345")

    org = host.split(".")[0]
    return org, f"{parsed.scheme}://{host}", int(match.group(1))


def get_guest_token(org: str, mask_url: str) -> str:
    guest_id = str(uuid.uuid4())
    url = (
        f"{API_BASE}/Auth/OnlineToken/GetGuestTokenByMask"
        f"?orgCode={quote(org)}&guestId={quote(guest_id)}&maskURL={quote(mask_url, safe='')}"
    )
    data = request_json(url, origin=mask_url, referer=f"{mask_url}/")
    token = data.get("Result", {}).get("GuestToken", {}).get("Token")
    if not token:
        raise TicketSearchError("TicketSearch did not return an anonymous guest token.")
    return token


def api_result(data: dict[str, Any], key: str | None = None) -> Any:
    if data.get("Errors"):
        raise TicketSearchError("; ".join(str(error) for error in data["Errors"]))
    result = data.get("Result")
    if key is None:
        return result
    return (result or {}).get(key)


def first_event_image(event: dict[str, Any], mask_url: str) -> str | None:
    images = event.get("SalesEventImage") or event.get("EventImages") or []
    if not images:
        return None

    image = images[0] if isinstance(images[0], dict) else {}
    path = image.get("FilePath") or image.get("FileUrl") or image.get("ImageUrl") or image.get("Url")
    if not path:
        return None
    if str(path).lower().startswith(("http://", "https://")):
        return str(path)
    return f"{mask_url.rstrip('/')}/{str(path).lstrip('/')}"


def venue_location(event: dict[str, Any]) -> str:
    if event.get("VenueLocation"):
        return str(event["VenueLocation"])

    address = event.get("VenueAddress") or {}
    parts = [
        address.get("StreetAddress"),
        address.get("Suburb"),
        address.get("State"),
        address.get("Postcode"),
        address.get("Country"),
    ]
    formatted = ", ".join(str(part) for part in parts if part)
    return formatted or event.get("VenueName") or ""


def date_range(sessions: list[dict[str, Any]]) -> dict[str, str | None]:
    dates = [item.get("dateTime") for item in sessions if item.get("dateTime")]
    if not dates:
        return {"start": None, "end": None}
    return {"start": min(dates), "end": max(dates)}


def add_breakdown(
    breakdown: dict[tuple[str, str, str], dict[str, Any]],
    code: str,
    label: str,
    kind: str,
    excluded: bool,
    counts_toward_sold_percent: bool = False,
) -> None:
    key = (code, label, kind)
    if key not in breakdown:
        breakdown[key] = {
            "code": code,
            "label": label,
            "kind": kind,
            "count": 0,
            "excludedFromCapacity": 0,
            "countsTowardSoldPercent": counts_toward_sold_percent,
        }
    breakdown[key]["count"] += 1
    if excluded:
        breakdown[key]["excludedFromCapacity"] += 1


def counts_toward_sold_percent(code: str, label: str, is_sold: bool) -> bool:
    if is_sold:
        return True

    normalized_code = code.strip().upper()
    normalized_label = label.strip().lower()
    return normalized_code in SOLD_PERCENT_HOLD_CODES or normalized_label in SOLD_PERCENT_HOLD_LABELS


def analyse_session(
    token: str,
    event_id: int,
    event: dict[str, Any],
    schedule: dict[str, Any],
    mask_url: str,
) -> dict[str, Any]:
    schedule_id = int(schedule["EventScheduleId"])
    is_reserved = event.get("LayoutTypeDesc") == "ReservedSeating"

    price_payload = {
        "SalesEventDetailFilter": {
            "EventId": event_id,
            "EventScheduleId": schedule_id,
            "CrossSellId": 0,
            "IsExclusive": False,
            "IsRSLayout": is_reserved,
            "OperatorShoppingCartId": 0,
        },
        "SalesEventPLFilter": {
            "EventId": event_id,
            "EventScheduleId": schedule_id,
            "isExclusiveOffers": False,
        },
    }
    price_result = api_result(
        request_json(
            f"{API_BASE}/OnlineApi/SalesEventDetail/GetEventSchedulePriceLevels",
            token,
            price_payload,
            origin=mask_url,
            referer=f"{mask_url}/sales/salesevent/{event_id}",
        )
    )

    price_levels = price_result.get("EventDetailSchedulePriceLevels") or []
    mappings = []
    for level in price_levels:
        mappings.extend(level.get("PLSeatMapObjectMappings") or [])

    if mappings:
        capacity_seats = [seat for seat in mappings if not seat.get("IsExcludeFromCapacity")]
        total = len(capacity_seats)
        breakdown: dict[tuple[str, str, str], dict[str, Any]] = {}
        explicit_sold = 0
        effective_sold = 0
        non_sold_unavailable = 0
        non_sold_unavailable_in_capacity = 0

        for seat in mappings:
            excluded = bool(seat.get("IsExcludeFromCapacity"))
            if seat.get("IsSold"):
                explicit_sold += 1
                effective_sold += 1
                add_breakdown(breakdown, "SOLD", "Sold seats", "sold", excluded, True)
                continue

            if seat.get("HoldChar"):
                code = str(seat.get("HoldChar"))
                label = str(seat.get("HoldName") or "Held seats")
                include_in_sold_percent = counts_toward_sold_percent(code, label, False)
                if include_in_sold_percent:
                    effective_sold += 1
                non_sold_unavailable += 1
                if not excluded:
                    non_sold_unavailable_in_capacity += 1
                add_breakdown(
                    breakdown,
                    code,
                    label,
                    "hold",
                    excluded,
                    include_in_sold_percent,
                )
                continue

            if seat.get("IsBlock"):
                non_sold_unavailable += 1
                if not excluded:
                    non_sold_unavailable_in_capacity += 1
                add_breakdown(breakdown, "BLOCK", "Blocked seats", "blocked", excluded)
                continue

            if seat.get("IsSDSeat"):
                non_sold_unavailable += 1
                if not excluded:
                    non_sold_unavailable_in_capacity += 1
                add_breakdown(breakdown, "SD", "Special disabled seats", "special", excluded)
                continue

            if seat.get("IsSelected"):
                non_sold_unavailable += 1
                if not excluded:
                    non_sold_unavailable_in_capacity += 1
                add_breakdown(breakdown, "SELECTED", "Temporarily selected", "selected", excluded)

        available = max(total - explicit_sold - non_sold_unavailable_in_capacity, 0)
        tickets_sold = explicit_sold
        unavailable_other = non_sold_unavailable
        breakdown_rows = sorted(
            breakdown.values(),
            key=lambda item: (
                0 if item["kind"] == "sold" else 1,
                0 if item["countsTowardSoldPercent"] else 1,
                item["code"],
            ),
        )
    else:
        available = int(schedule.get("ScheduleAvailable") or 0)
        total = int((schedule.get("ScheduleCapacity") or 0) or available)
        tickets_sold = max(total - available, 0)
        explicit_sold = 0
        effective_sold = tickets_sold
        unavailable_other = 0
        breakdown_rows = []

    sold_percent = (tickets_sold / total * 100) if total else 0
    effective_sold_percent = (effective_sold / total * 100) if total else 0
    unavailable_percent = ((tickets_sold + unavailable_other) / total * 100) if total else 0
    return {
        "scheduleId": schedule_id,
        "dateTime": schedule.get("ScheduleStartDate"),
        "description": schedule.get("SessionDescription"),
        "totalSeats": total,
        "availableSeats": available,
        "ticketsSold": tickets_sold,
        "effectiveSoldSeats": effective_sold,
        "unavailableSeats": unavailable_other,
        "soldPercent": sold_percent,
        "effectiveSoldPercent": effective_sold_percent,
        "unavailablePercent": unavailable_percent,
        "notAvailableSeats": tickets_sold + unavailable_other,
        "breakdown": breakdown_rows,
        "thresholdAlert": schedule.get("ThresholdAlert"),
        "isSoldOut": bool(schedule.get("IsSoldOut")),
    }


def analyse_event(value: str) -> dict[str, Any]:
    org, mask_url, event_id = parse_event_input(value)
    token = get_guest_token(org, mask_url)

    event = api_result(
        request_json(
            f"{API_BASE}/OnlineApi/SalesEventDetail/GetEventDetail?eventId={event_id}",
            token,
            origin=mask_url,
            referer=f"{mask_url}/sales/salesevent/{event_id}",
        ),
        "SalesEventDetail",
    )
    if not event:
        raise TicketSearchError("TicketSearch did not return event details.")

    schedules_payload = {
        "SalesEventDetailFilter": {
            "EventId": event_id,
            "EventScheduleId": 0,
            "CrossSellId": 0,
            "IsExclusive": False,
        }
    }
    schedules = api_result(
        request_json(
            f"{API_BASE}/OnlineApi/SalesEventDetail/GetEventSchedules",
            token,
            schedules_payload,
            origin=mask_url,
            referer=f"{mask_url}/sales/salesevent/{event_id}",
        ),
        "SalesEventDetailSchedules",
    ) or []

    sessions = [analyse_session(token, event_id, event, schedule, mask_url) for schedule in schedules]
    sessions.sort(key=lambda item: item.get("dateTime") or "")

    total_seats = sum(item["totalSeats"] for item in sessions)
    available = sum(item["availableSeats"] for item in sessions)
    sold = sum(item["ticketsSold"] for item in sessions)
    effective_sold = sum(item["effectiveSoldSeats"] for item in sessions)
    unavailable = sum(item["unavailableSeats"] for item in sessions)

    return {
        "eventId": event_id,
        "eventName": " ".join(part for part in [event.get("EventLine1"), event.get("EventLine2")] if part),
        "venue": event.get("VenueName"),
        "location": venue_location(event),
        "imageUrl": first_event_image(event, mask_url),
        "dateRange": date_range(sessions),
        "layoutType": event.get("LayoutTypeDesc"),
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "summary": {
            "performances": len(sessions),
            "totalSeats": total_seats,
            "availableSeats": available,
            "ticketsSold": sold,
            "effectiveSoldSeats": effective_sold,
            "unavailableSeats": unavailable,
            "soldPercent": (sold / total_seats * 100) if total_seats else 0,
            "effectiveSoldPercent": (effective_sold / total_seats * 100) if total_seats else 0,
            "unavailablePercent": ((sold + unavailable) / total_seats * 100) if total_seats else 0,
        },
        "sessions": sessions,
    }


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/analyse":
            self.handle_analyse(parsed)
            return
        self.serve_static(parsed.path)

    def handle_analyse(self, parsed: Any) -> None:
        value = parse_qs(parsed.query).get("input", [""])[0]
        try:
            payload = analyse_event(unquote(value))
            self.send_json(200, payload)
        except TicketSearchError as exc:
            self.send_json(400, {"error": str(exc)})
        except Exception as exc:  # Keep the UI useful if TicketSearch changes a response.
            self.send_json(500, {"error": f"Unexpected error: {exc}"})

    def serve_static(self, path: str) -> None:
        target = "index.html" if path in {"", "/"} else path.lstrip("/")
        file_path = (ROOT / target).resolve()
        if ROOT.resolve() not in file_path.parents and file_path != ROOT.resolve():
            self.send_error(403)
            return
        if not file_path.exists() or not file_path.is_file():
            self.send_error(404)
            return

        content_type = "text/plain"
        if file_path.suffix == ".html":
            content_type = "text/html; charset=utf-8"
        elif file_path.suffix == ".css":
            content_type = "text/css; charset=utf-8"
        elif file_path.suffix == ".js":
            content_type = "application/javascript; charset=utf-8"

        body = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:
        return


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8787"))
    host = "0.0.0.0" if os.environ.get("PORT") else "127.0.0.1"
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"Serving http://{host}:{port}")
    server.serve_forever()
