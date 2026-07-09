from __future__ import annotations

import json
import os
import re
import uuid
import zlib
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, unquote, urljoin, urlparse
from urllib.request import Request, urlopen


ROOT = Path(__file__).parent
API_BASE = "https://api.ticketsearch.com"
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
SNAPSHOT_SECRET = os.environ.get("SNAPSHOT_SECRET", "")
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


class AnalysisError(Exception):
    pass


class StorageError(Exception):
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


def request_text(url: str, referer: str | None = None, accept: str = "text/html,*/*") -> str:
    headers = {
        "Accept": accept,
        "Referer": referer or url,
        "User-Agent": "Mozilla/5.0",
    }
    try:
        with urlopen(Request(url, headers=headers), timeout=30) as response:
            return response.read().decode("utf-8", errors="replace")
    except HTTPError as exc:
        details = exc.read().decode("utf-8", errors="replace")
        raise AnalysisError(f"Website returned HTTP {exc.code}: {details[:400]}") from exc
    except URLError as exc:
        raise AnalysisError(f"Could not connect to website: {exc.reason}") from exc


def request_public_json(url: str, referer: str | None = None) -> Any:
    text = request_text(url, referer=referer, accept="application/json,text/html,*/*")
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise AnalysisError("Website did not return valid JSON.") from exc


def storage_enabled() -> bool:
    return bool(SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)


def supabase_request(
    path: str,
    method: str = "GET",
    payload: Any | None = None,
    prefer: str | None = None,
) -> Any:
    if not storage_enabled():
        raise StorageError("Supabase is not configured.")

    body = None
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
    }
    if prefer:
        headers["Prefer"] = prefer
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")

    url = f"{SUPABASE_URL}/rest/v1/{path.lstrip('/')}"
    try:
        with urlopen(Request(url, data=body, headers=headers, method=method), timeout=30) as response:
            content = response.read().decode("utf-8")
            return json.loads(content) if content else None
    except HTTPError as exc:
        details = exc.read().decode("utf-8", errors="replace")
        raise StorageError(f"Supabase returned HTTP {exc.code}: {details}") from exc
    except URLError as exc:
        raise StorageError(f"Could not connect to Supabase: {exc.reason}") from exc


def supabase_select_all(path: str, page_size: int = 1000) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    offset = 0
    separator = "&" if "?" in path else "?"

    while True:
        page = supabase_request(
            f"{path}{separator}limit={page_size}&offset={offset}"
        ) or []
        rows.extend(page)
        if len(page) < page_size:
            return rows
        offset += page_size


def configure_supabase_cron_secret() -> bool:
    if not storage_enabled() or not SNAPSHOT_SECRET:
        return False
    result = supabase_request(
        "rpc/configure_theatre_snapshot_cron_secret",
        "POST",
        {"secret_value": SNAPSHOT_SECRET},
    )
    return bool(result)


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


def parse_event_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        offset = sydney_offset_hours(parsed.replace(tzinfo=timezone.utc))
        parsed = parsed.replace(tzinfo=timezone(timedelta(hours=offset)))
    return parsed.astimezone(timezone.utc)


def parse_performance_wall_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    text = str(value).replace("Z", "+00:00")
    if "+" in text:
        text = text.rsplit("+", 1)[0]
    elif len(text) > 19 and text[19] == "-":
        text = text[:19]
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return parse_event_datetime(value)
    offset = sydney_offset_hours(parsed.replace(tzinfo=timezone.utc))
    return parsed.replace(tzinfo=timezone(timedelta(hours=offset))).astimezone(timezone.utc)


def performance_wall_datetime_label(value: str | None) -> str | None:
    if not value:
        return None
    text = str(value).replace("Z", "+00:00")
    if "+" in text:
        return text.rsplit("+", 1)[0]
    if len(text) > 19 and text[19] == "-":
        return text[:19]
    return text


def recompute_summary(data: dict[str, Any]) -> None:
    sessions = data.get("sessions") or []
    total_seats = sum(int(item.get("totalSeats") or 0) for item in sessions)
    available = sum(int(item.get("availableSeats") or 0) for item in sessions)
    sold = sum(int(item.get("ticketsSold") or 0) for item in sessions)
    effective_sold = sum(int(item.get("effectiveSoldSeats") or 0) for item in sessions)
    unavailable = sum(int(item.get("unavailableSeats") or 0) for item in sessions)
    capacity_unknown = any(item.get("capacityUnknown") for item in sessions)
    revenue = combine_revenue_estimates(
        [item.get("revenueEstimate") for item in sessions],
        "Estimated ticket revenue from available performance revenue estimates.",
    )
    data["dateRange"] = date_range(sessions)
    data["summary"] = {
        **(data.get("summary") or {}),
        "performances": len(sessions),
        "totalSeats": total_seats,
        "availableSeats": available,
        "ticketsSold": sold,
        "effectiveSoldSeats": effective_sold,
        "unavailableSeats": unavailable,
        "soldPercent": (sold / total_seats * 100) if total_seats else 0,
        "effectiveSoldPercent": (effective_sold / total_seats * 100) if total_seats else 0,
        "unavailablePercent": ((sold + unavailable) / total_seats * 100) if total_seats else 0,
        "revenueEstimate": revenue,
        "capacityUnknown": capacity_unknown,
    }


def canonical_event_url(mask_url: str, event_id: int) -> str:
    return f"{mask_url}/sales/salesevent/{event_id}"


def canonical_trybooking_url(event_id: int) -> str:
    return f"https://www.trybooking.com/events/landing/{event_id}"


def revenue_estimate(
    seat_count: int,
    price_min: float | None,
    price_max: float | None = None,
    basis: str = "",
) -> dict[str, Any] | None:
    if seat_count <= 0 or price_min is None:
        return None

    high = price_max if price_max is not None else price_min
    low = min(price_min, high)
    high = max(price_min, high)
    average = (low + high) / 2
    return {
        "amount": round(seat_count * average, 2),
        "minAmount": round(seat_count * low, 2),
        "maxAmount": round(seat_count * high, 2),
        "currency": "AUD",
        "seatCount": seat_count,
        "priceMin": low,
        "priceMax": high,
        "basis": basis,
    }


def combine_revenue_estimates(estimates: list[dict[str, Any] | None], basis: str) -> dict[str, Any] | None:
    valid = [estimate for estimate in estimates if estimate]
    if not valid:
        return None
    return {
        "amount": round(sum(float(item["amount"]) for item in valid), 2),
        "minAmount": round(sum(float(item["minAmount"]) for item in valid), 2),
        "maxAmount": round(sum(float(item["maxAmount"]) for item in valid), 2),
        "currency": "AUD",
        "seatCount": sum(int(item["seatCount"]) for item in valid),
        "basis": basis,
    }


def parse_price_values(value: str) -> tuple[float | None, float | None]:
    numbers = [
        float(match.group(1).replace(",", ""))
        for match in re.finditer(r"\$?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)", value)
    ]
    if not numbers:
        return None, None
    return min(numbers), max(numbers)


def html_unescape(value: str) -> str:
    import html

    return html.unescape(re.sub(r"\s+", " ", value)).strip()


def html_attr(tag: str, name: str) -> str:
    match = re.search(rf'{re.escape(name)}="([^"]*)"', tag, re.IGNORECASE)
    return html_unescape(match.group(1)) if match else ""


def strip_tags(value: str) -> str:
    return html_unescape(re.sub(r"<[^>]+>", " ", value))


def json_ld_event(html: str) -> dict[str, Any]:
    for match in re.finditer(
        r'<script[^>]+type="application/ld\+json"[^>]*>(.*?)</script>',
        html,
        re.IGNORECASE | re.DOTALL,
    ):
        raw = html_unescape(match.group(1))
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            continue
        items = data if isinstance(data, list) else [data]
        for item in items:
            if isinstance(item, dict) and str(item.get("@type", "")).lower() == "event":
                return item
    return {}


def meta_content(html: str, property_name: str) -> str:
    pattern = (
        rf'<meta[^>]+(?:property|name)="{re.escape(property_name)}"[^>]+content="([^"]*)"'
        rf'|<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="{re.escape(property_name)}"'
    )
    match = re.search(pattern, html, re.IGNORECASE)
    if not match:
        return ""
    return html_unescape(match.group(1) or match.group(2) or "")


def parse_trybooking_input(value: str) -> int | None:
    raw = value.strip()
    if not raw:
        return None
    parsed = urlparse(raw)
    if parsed.netloc.lower() not in {"www.trybooking.com", "trybooking.com"}:
        return None
    match = re.search(r"/events/(?:landing/)?(\d+)", parsed.path, re.IGNORECASE)
    return int(match.group(1)) if match else None


def synthetic_trybooking_schedule_id(event_id: int, date_value: str, time_value: str) -> int:
    raw = f"trybooking:{event_id}:{date_value}:{time_value}".encode("utf-8")
    return zlib.crc32(raw) & 0x7FFFFFFF


def trybooking_data_int(html: str, name: str) -> int | None:
    match = re.search(rf'data-{re.escape(name)}="(-?\d+)"', html, re.IGNORECASE)
    if not match:
        return None
    try:
        return int(match.group(1))
    except ValueError:
        return None


def trybooking_general_admission_session(
    event_id: int,
    session: dict[str, str],
    timezone_offset: str,
    availability: int | None,
    is_sold_out: bool,
    fallback_capacity: int = 0,
) -> dict[str, Any]:
    available = max(int(availability or 0), 0)
    total = fallback_capacity if fallback_capacity and (is_sold_out or fallback_capacity >= available) else 0
    capacity_unknown = total == 0
    effective_sold = max(total - available, 0) if total else 0
    effective_percent = (effective_sold / total * 100) if total else 0
    price_min, price_max = parse_price_values(session.get("priceText", ""))
    basis = (
        "TryBooking marked this general-admission performance as sold out. "
        "Capacity is reused from the best matching stored snapshot when available."
        if is_sold_out
        else "TryBooking general-admission page exposes remaining availability but not total capacity, so sold seats cannot be calculated from the public page alone."
    )
    revenue = revenue_estimate(effective_sold, price_min, price_max, basis)
    breakdown = []
    if is_sold_out:
        breakdown.append(
            {
                "code": "TB_SOLD_OUT",
                "label": "TryBooking sold out performance",
                "kind": "sold-out",
                "count": effective_sold,
                "excludedFromCapacity": 0,
                "countsTowardSoldPercent": True,
            }
        )
    else:
        breakdown.append(
            {
                "code": "TB_GA_AVAILABLE",
                "label": "TryBooking general admission remaining availability",
                "kind": "available",
                "count": available,
                "excludedFromCapacity": 0,
                "countsTowardSoldPercent": False,
            }
        )

    return {
        "scheduleId": int(session["sessionId"]),
        "dateTime": trybooking_session_datetime(session["date"], session.get("time", ""), timezone_offset),
        "description": session.get("time", ""),
        "totalSeats": total,
        "availableSeats": 0 if is_sold_out else available,
        "ticketsSold": effective_sold,
        "effectiveSoldSeats": effective_sold,
        "unavailableSeats": 0,
        "soldPercent": effective_percent,
        "effectiveSoldPercent": effective_percent,
        "unavailablePercent": effective_percent,
        "notAvailableSeats": effective_sold,
        "revenueEstimate": revenue,
        "breakdown": breakdown,
        "thresholdAlert": None,
        "isSoldOut": is_sold_out,
        "capacityUnknown": capacity_unknown,
        "statusLabel": "Sold out" if is_sold_out else "General admission availability only",
    }


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


def is_kill_hide_seat(seat: dict[str, Any]) -> bool:
    code = str(seat.get("HoldChar") or "").strip().upper()
    label = str(seat.get("HoldName") or "").strip().lower()
    return code in {"*K", "K"} or label in {"kill/hide", "kill hide", "kill", "hide"}


def is_excluded_from_capacity(seat: dict[str, Any]) -> bool:
    return bool(seat.get("IsExcludeFromCapacity")) or is_kill_hide_seat(seat)


def seat_snapshot_status(seat: dict[str, Any]) -> str:
    if is_excluded_from_capacity(seat):
        return "excluded"
    if seat.get("IsSold"):
        return "sold"
    code = str(seat.get("HoldChar") or "")
    label = str(seat.get("HoldName") or "")
    if code:
        return "sold-equivalent" if counts_toward_sold_percent(code, label, False) else "hold"
    if seat.get("IsBlock"):
        return "blocked"
    if seat.get("IsSDSeat"):
        return "special"
    if seat.get("IsSelected"):
        return "selected"
    return "available"


def laycock_seat_position(index: int) -> dict[str, Any] | None:
    rear_rows = ["N", "M", "L", "K", "J", "H", "G", "F", "E"]
    if index < 144:
        return {"row": rear_rows[index // 16], "seatNumber": (index % 16) + 1}
    if index < 288:
        offset = index - 144
        return {"row": rear_rows[offset // 16], "seatNumber": (offset % 16) + 17}

    front_rows = [
        ("D", 2, 30),
        ("C", 3, 28),
        ("B", 4, 26),
        ("A", 5, 24),
    ]
    offset = index - 288
    for row, first_seat, count in front_rows:
        if offset < count:
            return {"row": row, "seatNumber": first_seat + offset}
        offset -= count
    return None


def is_laycock_main_layout(event: dict[str, Any], mappings: list[dict[str, Any]]) -> bool:
    venue = str(event.get("VenueName") or "").lower()
    return "laycock" in venue and len(mappings) == 396


def red_tree_seat_position(index: int) -> dict[str, Any] | None:
    rows = ["A", "B", "C", "D", "E", "F", "G"]
    if index < 133:
        return {"row": rows[index // 19], "seatNumber": (index % 19) + 1}
    if index < 142:
        return {"row": "H", "seatNumber": index - 132}
    return None


def is_red_tree_layout(event: dict[str, Any], mappings: list[dict[str, Any]]) -> bool:
    venue = str(event.get("VenueName") or "").lower()
    return "red tree" in venue and len(mappings) == 142


def art_house_seat_position(index: int) -> dict[str, Any] | None:
    api_seat = index + 1

    segments = [
        ("Stalls", "T", 23, 1, 1),
        ("Stalls", "S", 23, 24, 1),
        ("Stalls", "R", 24, 47, 1),
        ("Stalls", "Q", 24, 71, 1),
        ("Stalls", "P", 24, 95, 1),
        ("Stalls", "N", 24, 119, 1),
        ("Stalls", "M", 24, 143, 1),
        ("Stalls", "L", 9, 167, 1),
        ("Stalls", "H", 20, 176, 1),
        ("Stalls", "L", 15, 196, 10),
        ("Stalls", "K", 24, 211, 1),
        ("Stalls", "J", 24, 235, 1),
        ("Stalls", "G", 25, 259, 1),
        ("Stalls", "F", 25, 284, 1),
        ("Stalls", "E", 25, 309, 1),
        ("Stalls", "D", 25, 334, 1),
        ("Stalls", "C", 25, 359, 1),
        ("Stalls", "B", 25, 384, 1),
        ("Stalls", "A", 25, 409, 1),
        ("Balcony 2", "A", 5, 434, 1),
        ("Balcony 2", "B", 6, 439, 1),
        ("Balcony 2", "C", 6, 445, 1),
        ("Balcony 2", "D", 6, 451, 1),
        ("Balcony 2", "E", 6, 457, 1),
        ("Balcony 2", "F", 6, 463, 1),
        ("Balcony 1", "A", 5, 469, 1),
        ("Balcony 1", "B", 6, 474, 1),
        ("Balcony 1", "C", 6, 480, 1),
        ("Balcony 1", "D", 6, 486, 1),
        ("Balcony 1", "E", 6, 492, 1),
        ("Balcony 1", "F", 6, 498, 1),
    ]
    for section, row, length, start, first_seat in segments:
        offset = api_seat - start
        if offset < 0:
            continue
        if offset < length:
            return {"section": section, "row": row, "seatNumber": first_seat + offset}
    return None


def is_art_house_layout(event: dict[str, Any], mappings: list[dict[str, Any]]) -> bool:
    venue = str(event.get("VenueName") or "").lower()
    layout_id = int(event.get("VenueLayoutId") or 0)
    return "art house" in venue and layout_id == 2472 and len(mappings) == 503


def layout_number(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def layout_location_value(properties: dict[str, Any], key: str) -> float:
    location = properties.get("Location") if isinstance(properties.get("Location"), dict) else {}
    value = layout_number(location.get(key))
    return value if value is not None else 0.0


def layout_point_value(properties: dict[str, Any], point_key: str, axis_key: str) -> float | None:
    point = properties.get(point_key) if isinstance(properties.get(point_key), dict) else {}
    value = layout_number(point.get(axis_key))
    return value


def ticketsearch_layout_positions(layout_objects: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
    parents = {
        int(item["VenueLayoutSeatMapObjectId"]): item
        for item in layout_objects
        if item.get("VenueLayoutSeatMapObjectId") is not None
    }
    positions: dict[int, dict[str, Any]] = {}
    for item in layout_objects:
        if item.get("ObjectType") != 384 or item.get("VenueLayoutSeatMapObjectId") is None:
            continue
        row = str(item.get("GroupLabel") or "").strip()
        seat_label = str(item.get("SeatLabel") or "").strip()
        if not row or not seat_label:
            continue
        parent = parents.get(int(item.get("ParentId") or 0)) or {}
        parent_properties = parent.get("ObjectProperties") if isinstance(parent.get("ObjectProperties"), dict) else {}
        properties = item.get("ObjectProperties") if isinstance(item.get("ObjectProperties"), dict) else {}
        seat_number = layout_number(seat_label)
        section = str(item.get("SectionLabel") or parent.get("SectionLabel") or "Stalls").strip() or "Stalls"
        parent_width = layout_number(parent_properties.get("Width")) or 0.0
        parent_height = layout_number(parent_properties.get("Height")) or 0.0
        parent_center_x = layout_point_value(parent_properties, "CenterPoint", "X")
        parent_center_y = layout_point_value(parent_properties, "CenterPoint", "Y")
        parent_x = (
            parent_center_x - (parent_width / 2)
            if parent_center_x is not None
            else layout_location_value(parent_properties, "X")
        )
        parent_y = (
            parent_center_y - (parent_height / 2)
            if parent_center_y is not None
            else layout_location_value(parent_properties, "Y")
        )
        positions[int(item["VenueLayoutSeatMapObjectId"])] = {
            "section": section,
            "row": row,
            "seatNumber": int(seat_number) if seat_number is not None and seat_number.is_integer() else seat_label,
            "visualX": parent_x + layout_location_value(properties, "X"),
            "visualY": parent_y + layout_location_value(properties, "Y"),
        }
    return positions


def seat_snapshot(
    mappings: list[dict[str, Any]],
    event: dict[str, Any] | None = None,
    layout_positions: dict[int, dict[str, Any]] | None = None,
) -> dict[str, Any] | None:
    if not mappings:
        return None
    total = len(mappings)
    is_laycock = is_laycock_main_layout(event or {}, mappings)
    is_red_tree = is_red_tree_layout(event or {}, mappings)
    is_art_house = is_art_house_layout(event or {}, mappings)
    columns = max(12, min(34, round(total ** 0.5 * 1.45)))
    seats = []
    for index, seat in enumerate(mappings):
        status = seat_snapshot_status(seat)
        code = str(seat.get("HoldChar") or "").strip()
        label = str(seat.get("HoldName") or "").strip()
        seat_item = {
            "index": index,
            "status": status,
            "code": code,
            "label": label,
        }
        if is_laycock:
            position = laycock_seat_position(index)
            if position:
                seat_item.update(position)
        elif is_red_tree:
            position = red_tree_seat_position(index)
            if position:
                seat_item.update(position)
        elif is_art_house:
            seatmap_id = seat.get("VenueLayoutSeatmapObjectId") or seat.get("VenueLayoutSeatMapObjectId")
            position = (layout_positions or {}).get(int(seatmap_id or 0)) or art_house_seat_position(index)
            if position:
                seat_item.update(position)
        seats.append(seat_item)
    return {
        "type": "laycock-main" if is_laycock else "red-tree-main" if is_red_tree else "art-house-main" if is_art_house else "status-grid",
        "columns": columns,
        "seatCount": total,
        "seats": seats,
        "legend": [
            {"status": "available", "label": "Available"},
            {"status": "sold", "label": "Sold"},
            {"status": "hold", "label": "Unavailable"},
            {"status": "excluded", "label": "Hidden/kill"},
        ],
    }


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
    level_prices = {
        int(level["PriceLevelId"]): (
            float(level["PriceRangeStart"]) if level.get("PriceRangeStart") is not None else None,
            float(level["PriceRangeEnd"]) if level.get("PriceRangeEnd") is not None else None,
        )
        for level in price_levels
        if level.get("PriceLevelId") is not None
    }
    mappings = []
    for level in price_levels:
        mappings.extend(level.get("PLSeatMapObjectMappings") or [])

    if mappings:
        layout_positions = None
        if is_art_house_layout(event, mappings):
            seatmap_payload = {
                "SalesEventSeatMapGet": {
                    "EventId": event_id,
                    "EventScheduleId": schedule_id,
                    "VenueLayoutId": event.get("VenueLayoutId"),
                    "VenueLayoutDetailId": 0,
                    "IsRSLayout": is_reserved,
                    "OperatorShoppingCartId": 0,
                }
            }
            seatmap_result = api_result(
                request_json(
                    f"{API_BASE}/OnlineApi/SalesEventDetail/GetSalesEventSeatMapDetails",
                    token,
                    seatmap_payload,
                    origin=mask_url,
                    referer=f"{mask_url}/sales/salesevent/{event_id}",
                )
            )
            layout_positions = ticketsearch_layout_positions(seatmap_result.get("VenueLayoutSeatMapObjects") or [])

        seat_map = seat_snapshot(mappings, event, layout_positions)
        capacity_seats = [seat for seat in mappings if not is_excluded_from_capacity(seat)]
        total = len(capacity_seats)
        breakdown: dict[tuple[str, str, str], dict[str, Any]] = {}
        explicit_sold = 0
        effective_sold = 0
        non_sold_unavailable = 0
        non_sold_unavailable_in_capacity = 0
        sold_revenue_amount = 0.0
        sold_revenue_min = 0.0
        sold_revenue_max = 0.0
        priced_sold_seats = 0

        for seat in mappings:
            excluded = is_excluded_from_capacity(seat)
            if seat.get("IsSold"):
                if not excluded:
                    explicit_sold += 1
                    effective_sold += 1
                    price_min, price_max = level_prices.get(int(seat.get("PriceLevelId") or 0), (None, None))
                    if price_min is not None:
                        high = price_max if price_max is not None else price_min
                        low = min(price_min, high)
                        high = max(price_min, high)
                        sold_revenue_amount += (low + high) / 2
                        sold_revenue_min += low
                        sold_revenue_max += high
                        priced_sold_seats += 1
                add_breakdown(breakdown, "SOLD", "Sold seats", "sold", excluded, True)
                continue

            if seat.get("HoldChar"):
                code = str(seat.get("HoldChar"))
                label = str(seat.get("HoldName") or "Held seats")
                include_in_sold_percent = counts_toward_sold_percent(code, label, False)
                if include_in_sold_percent and not excluded:
                    effective_sold += 1
                if not excluded:
                    non_sold_unavailable += 1
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
                if not excluded:
                    non_sold_unavailable += 1
                    non_sold_unavailable_in_capacity += 1
                add_breakdown(breakdown, "BLOCK", "Blocked seats", "blocked", excluded)
                continue

            if seat.get("IsSDSeat"):
                if not excluded:
                    non_sold_unavailable += 1
                    non_sold_unavailable_in_capacity += 1
                add_breakdown(breakdown, "SD", "Special disabled seats", "special", excluded)
                continue

            if seat.get("IsSelected"):
                if not excluded:
                    non_sold_unavailable += 1
                    non_sold_unavailable_in_capacity += 1
                add_breakdown(breakdown, "SELECTED", "Temporarily selected", "selected", excluded)

        available = max(total - explicit_sold - non_sold_unavailable_in_capacity, 0)
        tickets_sold = explicit_sold
        unavailable_other = non_sold_unavailable
        revenue = None
        if priced_sold_seats:
            revenue = {
                "amount": round(sold_revenue_amount, 2),
                "minAmount": round(sold_revenue_min, 2),
                "maxAmount": round(sold_revenue_max, 2),
                "currency": "AUD",
                "seatCount": priced_sold_seats,
                "basis": "Actual sold seats multiplied by their public price level. Holds and blocks are excluded.",
            }
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
        revenue = None
        breakdown_rows = []
        seat_map = None

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
        "revenueEstimate": revenue,
        "breakdown": breakdown_rows,
        "seatMap": seat_map,
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
    capacity_unknown = any(item.get("capacityUnknown") for item in sessions)
    revenue = combine_revenue_estimates(
        [item.get("revenueEstimate") for item in sessions],
        "Estimated ticket revenue from TicketSearch seats marked as sold. Holds and blocks are excluded.",
    )

    return {
        "eventId": event_id,
        "eventUrl": canonical_event_url(mask_url, event_id),
        "orgCode": org,
        "maskUrl": mask_url,
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
            "revenueEstimate": revenue,
            "capacityUnknown": capacity_unknown,
        },
        "sessions": sessions,
    }


def trybooking_session_datetime(date_value: str, time_label: str, timezone_offset: str) -> str:
    start_label = time_label.split("-")[0].strip()
    try:
        parsed = datetime.strptime(start_label, "%I:%M %p")
        return f"{date_value}T{parsed.hour:02d}:{parsed.minute:02d}:00{timezone_offset}"
    except ValueError:
        return f"{date_value}T00:00:00{timezone_offset}"


def trybooking_timezone_offset(html: str) -> str:
    match = re.search(r"\(UTC([+-]\d{1,2})(?::?(\d{2}))?\)", html)
    if not match:
        return "+10:00"
    hours = int(match.group(1))
    minutes = match.group(2) or "00"
    return f"{hours:+03d}:{minutes}"


def trybooking_event_metadata(event_id: int, landing_html: str) -> dict[str, Any]:
    event_json = json_ld_event(landing_html)
    location = event_json.get("location") if isinstance(event_json.get("location"), dict) else {}
    address = location.get("address") if isinstance(location.get("address"), dict) else {}
    address_parts = [
        address.get("streetAddress"),
        address.get("addressLocality"),
        address.get("addressRegion"),
        address.get("postalCode"),
    ]
    title_match = re.search(r"<title>(.*?)</title>", landing_html, re.IGNORECASE | re.DOTALL)
    title = strip_tags(title_match.group(1)) if title_match else ""
    name = event_json.get("name") or meta_content(landing_html, "og:title") or title.split("|")[0].strip()
    image = event_json.get("image") or meta_content(landing_html, "og:image")
    if isinstance(image, list):
        image = image[0] if image else ""

    return {
        "eventName": html_unescape(str(name or f"TryBooking event {event_id}")),
        "venue": html_unescape(str(location.get("name") or "")),
        "location": ", ".join(str(part) for part in address_parts if part),
        "imageUrl": str(image or ""),
        "dateStart": event_json.get("startDate"),
        "dateEnd": event_json.get("endDate"),
    }


def trybooking_sessions(event_id: int, landing_url: str) -> list[dict[str, str]]:
    calendar_url = f"https://www.trybooking.com/events/calendar-session-times/{event_id}"
    dates = request_public_json(calendar_url, referer=landing_url)
    sessions: list[dict[str, str]] = []
    for item in dates if isinstance(dates, list) else []:
        event_date = str(item.get("eventDate") or "")[:10]
        if not event_date:
            continue
        partial_url = f"{landing_url}/sessions-partial?date={quote(event_date)}"
        partial_html = request_text(partial_url, referer=landing_url)
        rows = re.findall(
            r'<div class="tryb-row[^"]*list-group-item[^"]*">(.*?)(?=<div class="tryb-row|\Z)',
            partial_html,
            re.IGNORECASE | re.DOTALL,
        )
        for row in rows:
            time_match = re.search(r'data-tb-title="([^"]+)"', row, re.IGNORECASE)
            if not time_match:
                continue
            time_value = html_unescape(time_match.group(1))
            price_match = re.search(
                r'<div[^>]+class="[^"]*\bprice-range\b[^"]*"[^>]*>(.*?)</div>',
                row,
                re.IGNORECASE | re.DOTALL,
            )
            price_text = strip_tags(price_match.group(1)) if price_match else ""
            status_match = re.search(
                r'<div[^>]+class="[^"]*\blegend-item\b[^"]*"[^>]*>(.*?)</div>',
                row,
                re.IGNORECASE | re.DOTALL,
            )
            status = strip_tags(status_match.group(1)).lower() if status_match else ""
            href_match = re.search(r'href="([^"]+/sessions/\d+/sections\?date=[^"]+)"', row, re.IGNORECASE)
            href = html_unescape(href_match.group(1)) if href_match else ""
            session_match = re.search(r"/sessions/(\d+)/", href)
            if href and not session_match:
                continue
            sessions.append(
                {
                    "date": event_date,
                    "time": time_value,
                    "sessionId": session_match.group(1)
                    if session_match
                    else str(synthetic_trybooking_schedule_id(event_id, event_date, time_value)),
                    "href": urljoin(landing_url, href) if href else "",
                    "priceText": price_text,
                    "status": status,
                    "isSoldOut": str("sold out" in status),
                }
            )
    return sessions


def trybooking_history_key(date_time: str | None, description: str | None) -> tuple[str, str] | None:
    wall_time = performance_wall_datetime_label(date_time)
    if not wall_time:
        return None
    label = re.sub(r"\s+", " ", str(description or "").strip().lower())
    return (wall_time, label)


def trybooking_session_history_key(session: dict[str, str], timezone_offset: str) -> tuple[str, str] | None:
    try:
        date_time = trybooking_session_datetime(session["date"], session.get("time", ""), timezone_offset)
    except Exception:
        return None
    return trybooking_history_key(date_time, session.get("time"))


def trybooking_capacity_hints_from_history(event_url: str) -> tuple[dict[tuple[str, str], int], int]:
    if not storage_enabled():
        return {}, 0
    try:
        tracked = supabase_request(
            "tracked_events"
            f"?event_url=eq.{quote(event_url, safe='')}"
            "&select=id"
            "&order=last_seen_at.desc"
            "&limit=1"
        )
        if not tracked:
            return {}, 0
        rows = supabase_select_all(
            "performance_snapshots"
            f"?tracked_event_id=eq.{tracked[0]['id']}"
            "&select=show_datetime,description,total_seats"
            "&order=show_datetime.asc"
        )
    except StorageError:
        return {}, 0

    hints: dict[tuple[str, str], int] = {}
    event_capacity = 0
    for row in rows or []:
        total = int(row.get("total_seats") or 0)
        if total <= 0:
            continue
        event_capacity = max(event_capacity, total)
        key = trybooking_history_key(row.get("show_datetime"), row.get("description"))
        if key:
            hints[key] = max(hints.get(key, 0), total)
    return hints, event_capacity


def analyse_trybooking_session(
    event_id: int,
    session: dict[str, str],
    timezone_offset: str,
    fallback_capacity: int = 0,
) -> dict[str, Any]:
    if not session.get("href"):
        return trybooking_general_admission_session(
            event_id,
            session,
            timezone_offset,
            0,
            "sold out" in session.get("status", "").lower() or session.get("isSoldOut") == "True",
            fallback_capacity,
        )

    section_html = request_text(session["href"], referer=canonical_trybooking_url(event_id))
    section_match = re.search(r'data-section-id="(\d+)"', section_html, re.IGNORECASE)
    if not section_match:
        raise AnalysisError(f"TryBooking did not return a section for session {session['sessionId']}.")

    section_id = section_match.group(1)
    seat_url = (
        f"https://www.trybooking.com/events/{event_id}/sessions/{session['sessionId']}"
        f"/sections/{section_id}/seats?p="
    )
    seat_html = request_text(seat_url, referer=session["href"])
    seat_tags = list(
        re.finditer(
            r'<button\b(?=[^>]*data-tb-seat-number="(?!-1")[^"]+")[^>]*class="([^"]*)"[^>]*>',
            seat_html,
            re.IGNORECASE,
        )
    )
    available = 0
    unavailable = 0
    unclassified = 0
    for tag in seat_tags:
        classes = tag.group(1).strip().lower()
        if "available" in classes:
            available += 1
        elif "booked" in classes:
            unavailable += 1
        else:
            unclassified += 1

    if not seat_tags:
        availability = trybooking_data_int(section_html, "section-availability")
        if availability is None:
            availability = trybooking_data_int(section_html, "session-availability")
        if availability is not None:
            return trybooking_general_admission_session(
                event_id,
                session,
                timezone_offset,
                availability,
                availability <= 0 or "sold out" in session.get("status", "").lower(),
                fallback_capacity,
            )

    total = len(seat_tags)
    effective_sold = max(total - available, 0)
    effective_percent = (effective_sold / total * 100) if total else 0
    price_min, price_max = parse_price_values(session.get("priceText", ""))
    revenue = revenue_estimate(
        effective_sold,
        price_min,
        price_max,
        "TryBooking estimate uses seats not currently available to buy multiplied by the public session price. True paid sold seats are not exposed publicly.",
    )
    breakdown = []
    if unavailable:
        breakdown.append(
            {
                "code": "TB_UNAVAILABLE",
                "label": "TryBooking unavailable seats",
                "kind": "unavailable",
                "count": unavailable,
                "excludedFromCapacity": 0,
                "countsTowardSoldPercent": True,
            }
        )
    if unclassified:
        breakdown.append(
            {
                "code": "TB_UNCLASSIFIED",
                "label": "TryBooking seat-numbered cells without a public status",
                "kind": "unclassified",
                "count": unclassified,
                "excludedFromCapacity": 0,
                "countsTowardSoldPercent": True,
            }
        )

    return {
        "scheduleId": int(session["sessionId"]),
        "dateTime": trybooking_session_datetime(session["date"], session.get("time", ""), timezone_offset),
        "description": session.get("time", ""),
        "totalSeats": total,
        "availableSeats": available,
        "ticketsSold": effective_sold,
        "effectiveSoldSeats": effective_sold,
        "unavailableSeats": 0,
        "soldPercent": effective_percent,
        "effectiveSoldPercent": effective_percent,
        "unavailablePercent": effective_percent,
        "notAvailableSeats": effective_sold,
        "revenueEstimate": revenue,
        "breakdown": breakdown,
        "thresholdAlert": None,
        "isSoldOut": bool(total and available == 0),
    }


def analyse_trybooking_event(event_id: int) -> dict[str, Any]:
    landing_url = canonical_trybooking_url(event_id)
    landing_html = request_text(landing_url)
    metadata = trybooking_event_metadata(event_id, landing_html)
    timezone_offset = trybooking_timezone_offset(landing_html)
    raw_sessions = trybooking_sessions(event_id, landing_url)
    linked_sessions: dict[int, dict[str, Any]] = {}
    history_capacity_hints, capacity_hint = trybooking_capacity_hints_from_history(landing_url)
    for session in raw_sessions:
        if not session.get("href"):
            continue
        session_key = trybooking_session_history_key(session, timezone_offset)
        session_capacity_hint = history_capacity_hints.get(session_key, capacity_hint) if session_key else capacity_hint
        analysed = analyse_trybooking_session(event_id, session, timezone_offset, session_capacity_hint)
        linked_sessions[int(analysed["scheduleId"])] = analysed
        if not analysed.get("capacityUnknown"):
            capacity_hint = max(capacity_hint, int(analysed.get("totalSeats") or 0))

    sessions = []
    for session in raw_sessions:
        schedule_id = int(session["sessionId"])
        if schedule_id in linked_sessions:
            sessions.append(linked_sessions[schedule_id])
        else:
            session_key = trybooking_session_history_key(session, timezone_offset)
            session_capacity_hint = history_capacity_hints.get(session_key, capacity_hint) if session_key else capacity_hint
            sessions.append(analyse_trybooking_session(event_id, session, timezone_offset, session_capacity_hint))
    sessions.sort(key=lambda item: item.get("dateTime") or "")

    total_seats = sum(item["totalSeats"] for item in sessions)
    available = sum(item["availableSeats"] for item in sessions)
    sold = sum(item["ticketsSold"] for item in sessions)
    effective_sold = sum(item["effectiveSoldSeats"] for item in sessions)
    unavailable = sum(item["unavailableSeats"] for item in sessions)
    capacity_unknown = any(item.get("capacityUnknown") for item in sessions)
    revenue = combine_revenue_estimates(
        [item.get("revenueEstimate") for item in sessions],
        "TryBooking estimate uses seats not currently available to buy multiplied by the public session price. True paid sold seats are not exposed publicly.",
    )

    return {
        "eventId": event_id,
        "eventUrl": landing_url,
        "orgCode": "trybooking",
        "maskUrl": "https://www.trybooking.com",
        "provider": "trybooking",
        "eventName": metadata["eventName"],
        "venue": metadata["venue"],
        "location": metadata["location"],
        "imageUrl": metadata["imageUrl"],
        "dateRange": date_range(sessions)
        if sessions
        else {"start": metadata.get("dateStart"), "end": metadata.get("dateEnd")},
        "layoutType": "TryBookingReservedSeating",
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
            "revenueEstimate": revenue,
            "capacityUnknown": capacity_unknown,
        },
        "sessions": sessions,
    }


def analyse_any_event(value: str) -> dict[str, Any]:
    trybooking_id = parse_trybooking_input(value)
    if trybooking_id is not None:
        return analyse_trybooking_event(trybooking_id)

    data = analyse_event(value)
    data["provider"] = "ticketsearch"
    return data


def performance_snapshot_details(session: dict[str, Any], include_seat_map: bool = False) -> Any:
    details: dict[str, Any] = {
        "items": session.get("breakdown") or [],
        "revenueEstimate": session.get("revenueEstimate"),
    }
    if include_seat_map and session.get("seatMap"):
        details["seatMap"] = session.get("seatMap")
    return details


def parse_performance_snapshot_details(
    value: Any,
) -> tuple[list[dict[str, Any]], dict[str, Any] | None, dict[str, Any] | None]:
    if isinstance(value, dict):
        items = value.get("items") if isinstance(value.get("items"), list) else []
        seat_map = value.get("seatMap") if isinstance(value.get("seatMap"), dict) else None
        revenue = value.get("revenueEstimate") if isinstance(value.get("revenueEstimate"), dict) else None
        return items, seat_map, revenue
    if isinstance(value, list):
        return value, None, None
    return [], None, None


def store_snapshot(
    data: dict[str, Any],
    source: str = "search",
    schedule_ids: set[int] | None = None,
) -> dict[str, Any] | None:
    if not storage_enabled():
        return None

    tracked_payload = {
        "event_id": data["eventId"],
        "event_url": data["eventUrl"],
        "org_code": data["orgCode"],
        "mask_url": data["maskUrl"],
        "event_name": data.get("eventName"),
        "venue": data.get("venue"),
        "location": data.get("location"),
        "image_url": data.get("imageUrl"),
        "date_start": (data.get("dateRange") or {}).get("start"),
        "date_end": (data.get("dateRange") or {}).get("end"),
        "layout_type": data.get("layoutType"),
        "is_active": True,
        "last_seen_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
    }
    tracked_rows = supabase_request(
        "tracked_events?on_conflict=event_url",
        "POST",
        [tracked_payload],
        "resolution=merge-duplicates,return=representation",
    )
    tracked = tracked_rows[0]
    summary = data["summary"]
    snapshot_payload = {
        "tracked_event_id": tracked["id"],
        "performances": summary["performances"],
        "total_seats": summary["totalSeats"],
        "actual_sold": summary["ticketsSold"],
        "effective_sold": summary["effectiveSoldSeats"],
        "unavailable": summary["unavailableSeats"],
        "available": summary["availableSeats"],
        "actual_sold_percent": summary["soldPercent"],
        "effective_sold_percent": summary["effectiveSoldPercent"],
        "unavailable_percent": summary["unavailablePercent"],
        "source": source,
    }
    snapshot_rows = supabase_request(
        "event_snapshots",
        "POST",
        [snapshot_payload],
        "return=representation",
    )
    snapshot = snapshot_rows[0]
    sessions_to_store = [
        session
        for session in data["sessions"]
        if schedule_ids is None or int(session["scheduleId"]) in schedule_ids
    ]
    include_seat_map = source == "final"
    performance_payload = [
        {
            "event_snapshot_id": snapshot["id"],
            "tracked_event_id": tracked["id"],
            "schedule_id": session["scheduleId"],
            "show_datetime": session.get("dateTime"),
            "description": session.get("description"),
            "total_seats": session["totalSeats"],
            "actual_sold": session["ticketsSold"],
            "effective_sold": session["effectiveSoldSeats"],
            "unavailable": session["unavailableSeats"],
            "available": session["availableSeats"],
            "actual_sold_percent": session["soldPercent"],
            "effective_sold_percent": session["effectiveSoldPercent"],
            "unavailable_percent": session["unavailablePercent"],
            "breakdown": performance_snapshot_details(session, include_seat_map),
        }
        for session in sessions_to_store
    ]
    if performance_payload:
        supabase_request("performance_snapshots", "POST", performance_payload)

    return {
        "trackedEventId": tracked["id"],
        "snapshotId": snapshot["id"],
        "capturedAt": snapshot["captured_at"],
    }


def final_snapshot_schedule_ids(
    tracked_event_id: str,
    window_minutes: int = 15,
    late_grace_minutes: int = 30,
) -> set[int]:
    rows = supabase_select_all(
        "performance_snapshots"
        f"?tracked_event_id=eq.{tracked_event_id}"
        "&select=schedule_id,show_datetime,event_snapshots!inner(source,captured_at)"
        "&event_snapshots.source=eq.final"
    )
    finalized: set[int] = set()
    for row in rows or []:
        show_time = parse_performance_wall_datetime(row.get("show_datetime"))
        snapshot = row.get("event_snapshots") or {}
        captured_at = parse_event_datetime(snapshot.get("captured_at"))
        if not show_time or not captured_at:
            continue
        minutes_before_show = (show_time - captured_at).total_seconds() / 60
        if -late_grace_minutes <= minutes_before_show <= window_minutes:
            finalized.add(int(row["schedule_id"]))
    return finalized


def performance_snapshot_to_session(row: dict[str, Any]) -> dict[str, Any]:
    snapshot = row.get("event_snapshots") or {}
    source = str(snapshot.get("source") or "")
    breakdown, seat_map, revenue = parse_performance_snapshot_details(row.get("breakdown"))
    session = {
        "scheduleId": int(row["schedule_id"]),
        "dateTime": performance_wall_datetime_label(row.get("show_datetime")),
        "description": row.get("description"),
        "totalSeats": int(row.get("total_seats") or 0),
        "availableSeats": int(row.get("available") or 0),
        "ticketsSold": int(row.get("actual_sold") or 0),
        "effectiveSoldSeats": int(row.get("effective_sold") or 0),
        "unavailableSeats": int(row.get("unavailable") or 0),
        "soldPercent": float(row.get("actual_sold_percent") or 0),
        "effectiveSoldPercent": float(row.get("effective_sold_percent") or 0),
        "unavailablePercent": float(row.get("unavailable_percent") or 0),
        "notAvailableSeats": int(row.get("actual_sold") or 0) + int(row.get("unavailable") or 0),
        "breakdown": breakdown,
        "isFinal": True,
        "finalSnapshotCapturedAt": snapshot.get("captured_at"),
        "finalSnapshotSource": source,
        "finalSnapshotIsFallback": source != "final",
    }
    if revenue:
        session["revenueEstimate"] = revenue
    if seat_map:
        session["seatMap"] = seat_map
    return session


def finalized_snapshot_rank(row: dict[str, Any], show_time: datetime) -> tuple[int, float]:
    snapshot = row.get("event_snapshots") or {}
    source = str(snapshot.get("source") or "")
    captured_at = parse_event_datetime(snapshot.get("captured_at"))
    if not captured_at:
        return (0, 0.0)
    if source == "final":
        priority = 3
    elif captured_at <= show_time:
        priority = 2
    else:
        priority = 1
    return (priority, captured_at.timestamp())


def backfill_missing_revenue(
    finalized_sessions: dict[int, dict[str, Any]],
    live_sessions: list[dict[str, Any]],
) -> None:
    estimates = [
        session.get("revenueEstimate")
        for session in live_sessions
        if session.get("revenueEstimate") and int(session["revenueEstimate"].get("seatCount") or 0) > 0
    ]
    priced_seats = sum(int(estimate["seatCount"]) for estimate in estimates)
    if not priced_seats:
        return

    price_min = sum(float(estimate["minAmount"]) for estimate in estimates) / priced_seats
    price_max = sum(float(estimate["maxAmount"]) for estimate in estimates) / priced_seats
    basis = (
        "Historical estimate reconstructed from this event's current weighted sold-seat "
        "price range because the original snapshot predates revenue persistence."
    )
    for session in finalized_sessions.values():
        if session.get("revenueEstimate"):
            continue
        session["revenueEstimate"] = revenue_estimate(
            int(session.get("ticketsSold") or 0),
            price_min,
            price_max,
            basis,
        )


def attach_finalized_sessions(data: dict[str, Any]) -> None:
    if not storage_enabled():
        return

    tracked = supabase_request(
        "tracked_events"
        f"?event_url=eq.{quote(data['eventUrl'], safe='')}"
        "&select=id"
        "&order=last_seen_at.desc"
        "&limit=1"
    )
    if not tracked:
        return

    rows = supabase_select_all(
        "performance_snapshots"
        f"?tracked_event_id=eq.{tracked[0]['id']}"
        "&select=schedule_id,show_datetime,description,total_seats,actual_sold,effective_sold,"
        "unavailable,available,actual_sold_percent,effective_sold_percent,unavailable_percent,"
        "breakdown,event_snapshots!inner(source,captured_at)"
        "&order=show_datetime.asc"
    )
    if not rows:
        return

    now_utc = datetime.now(timezone.utc)
    final_by_schedule: dict[int, dict[str, Any]] = {}
    final_rank_by_schedule: dict[int, tuple[int, float]] = {}
    for row in rows:
        show_time = parse_performance_wall_datetime(row.get("show_datetime"))
        if show_time and show_time <= now_utc:
            schedule_id = int(row["schedule_id"])
            session = performance_snapshot_to_session(row)
            rank = finalized_snapshot_rank(row, show_time)
            existing_rank = final_rank_by_schedule.get(schedule_id)
            if existing_rank is None or rank > existing_rank:
                final_by_schedule[schedule_id] = session
                final_rank_by_schedule[schedule_id] = rank

    if not final_by_schedule:
        return

    live_sessions = data.get("sessions", [])
    backfill_missing_revenue(final_by_schedule, live_sessions)
    live_by_schedule = {
        int(session["scheduleId"]): session
        for session in live_sessions
        if session.get("scheduleId") is not None
    }
    live_by_schedule.update(final_by_schedule)
    data["sessions"] = sorted(live_by_schedule.values(), key=lambda item: item.get("dateTime") or "")
    recompute_summary(data)


def attach_daily_performance_deltas(data: dict[str, Any]) -> None:
    for session in data.get("sessions", []):
        session["salesSinceDailySnapshot"] = None
        session["salesSinceDailySnapshotRaw"] = None
        session["dailySnapshotCapturedAt"] = None

    summary = data.get("summary") or {}
    summary["salesSinceDailySnapshot"] = None
    summary["salesSinceDailySnapshotRaw"] = None
    summary["dailySnapshotCapturedAt"] = None

    if not storage_enabled():
        return

    tracked = supabase_request(
        "tracked_events"
        f"?event_url=eq.{quote(data['eventUrl'], safe='')}"
        "&select=id"
        "&order=last_seen_at.desc"
        "&limit=1"
    )
    if not tracked:
        return

    snapshots = supabase_request(
        "event_snapshots"
        f"?tracked_event_id=eq.{tracked[0]['id']}"
        "&source=eq.daily"
        "&select=id,captured_at,actual_sold,effective_sold"
        "&order=captured_at.desc"
        "&limit=14"
    )
    if not snapshots:
        return

    current_local_date = sydney_local_date(datetime.now(timezone.utc))
    baseline = next(
        (snapshot for snapshot in snapshots if snapshot_local_date(snapshot) == current_local_date),
        None,
    )
    if not baseline:
        return

    performances = supabase_select_all(
        "performance_snapshots"
        f"?event_snapshot_id=eq.{baseline['id']}"
        "&select=schedule_id,actual_sold,effective_sold"
    )
    baseline_by_schedule = {int(item["schedule_id"]): int(item["actual_sold"] or 0) for item in performances}
    total_delta = 0
    total_raw_delta = 0
    matched = False
    now_utc = datetime.now(timezone.utc)

    for session in data.get("sessions", []):
        show_time = parse_event_datetime(session.get("dateTime"))
        if session.get("isFinal") or (show_time and show_time <= now_utc):
            session["salesSinceDailySnapshot"] = 0
            session["salesSinceDailySnapshotRaw"] = 0
            session["dailySnapshotCapturedAt"] = baseline["captured_at"]
            continue
        baseline_sold = baseline_by_schedule.get(int(session["scheduleId"]))
        if baseline_sold is None:
            continue
        raw_delta = int(session["ticketsSold"]) - baseline_sold
        delta = max(raw_delta, 0)
        session["salesSinceDailySnapshot"] = delta
        session["salesSinceDailySnapshotRaw"] = raw_delta
        session["dailySnapshotCapturedAt"] = baseline["captured_at"]
        total_delta += delta
        total_raw_delta += raw_delta
        matched = True

    if matched:
        summary["salesSinceDailySnapshot"] = total_delta
        summary["salesSinceDailySnapshotRaw"] = total_raw_delta
        summary["dailySnapshotCapturedAt"] = baseline["captured_at"]


def tracked_events() -> list[dict[str, Any]]:
    if not storage_enabled():
        return []
    return supabase_request(
        "tracked_events?is_active=eq.true&select=id,event_url,event_name,date_end,last_seen_at&order=last_seen_at.desc"
    )


def run_daily_snapshots() -> dict[str, Any]:
    events = tracked_events()
    results = []
    for event in events:
        try:
            data = analyse_any_event(event["event_url"])
            attach_finalized_sessions(data)
            stored = store_snapshot(data, "daily")
            results.append({
                "eventUrl": event["event_url"],
                "eventName": data.get("eventName"),
                "ok": True,
                "snapshot": stored,
            })
        except Exception as exc:
            results.append({
                "eventUrl": event["event_url"],
                "eventName": event.get("event_name"),
                "ok": False,
                "error": str(exc),
            })
    return {"trackedEvents": len(events), "results": results}


def run_final_snapshots(
    window_minutes: int = 15,
    late_grace_minutes: int = 30,
) -> dict[str, Any]:
    events = tracked_events()
    now_utc = datetime.now(timezone.utc)
    window_end = now_utc + timedelta(minutes=window_minutes)
    window_start = now_utc - timedelta(minutes=late_grace_minutes)
    results = []

    for event in events:
        try:
            event_end = parse_event_datetime(event.get("date_end"))
            if event_end and event_end < now_utc - timedelta(days=1):
                results.append({
                    "eventUrl": event["event_url"],
                    "eventName": event.get("event_name"),
                    "ok": True,
                    "skipped": "event completed",
                })
                continue

            already_final = final_snapshot_schedule_ids(
                event["id"],
                window_minutes,
                late_grace_minutes,
            )
            data = analyse_any_event(event["event_url"])
            due_sessions = []
            for session in data.get("sessions", []):
                schedule_id = int(session["scheduleId"])
                show_time = parse_performance_wall_datetime(session.get("dateTime"))
                if (
                    show_time
                    and window_start <= show_time <= window_end
                    and schedule_id not in already_final
                ):
                    due_sessions.append(schedule_id)

            if due_sessions:
                stored = store_snapshot(data, "final", set(due_sessions))
                results.append({
                    "eventUrl": event["event_url"],
                    "eventName": data.get("eventName"),
                    "ok": True,
                    "finalizedSchedules": due_sessions,
                    "snapshot": stored,
                })
            else:
                results.append({
                    "eventUrl": event["event_url"],
                    "eventName": data.get("eventName"),
                    "ok": True,
                    "finalizedSchedules": [],
                    "snapshot": None,
                })
        except Exception as exc:
            results.append({
                "eventUrl": event["event_url"],
                "eventName": event.get("event_name"),
                "ok": False,
                "error": str(exc),
            })

    return {
        "trackedEvents": len(events),
        "windowMinutes": window_minutes,
        "lateGraceMinutes": late_grace_minutes,
        "results": results,
    }


def event_history(event_id: int | None = None, event_url: str | None = None) -> dict[str, Any]:
    if not storage_enabled():
        raise StorageError("Supabase is not configured.")

    if event_url:
        tracked = supabase_request(
            "tracked_events"
            f"?event_url=eq.{quote(event_url, safe='')}"
            "&select=id,event_id,event_url,event_name,venue,location,date_start,date_end"
            "&order=last_seen_at.desc"
            "&limit=1"
        )
    elif event_id is not None:
        tracked = supabase_request(
            "tracked_events"
            f"?event_id=eq.{event_id}"
            "&select=id,event_id,event_url,event_name,venue,location,date_start,date_end"
            "&order=last_seen_at.desc"
            "&limit=1"
        )
    else:
        raise StorageError("Provide an event URL or event ID.")

    if not tracked:
        raise StorageError("No snapshot history has been collected for this event yet.")

    tracked_event = tracked[0]
    snapshots = supabase_request(
        "event_snapshots"
        f"?tracked_event_id=eq.{tracked_event['id']}"
        "&source=eq.daily"
        "&select=id,captured_at,total_seats,actual_sold,effective_sold,unavailable,available,"
        "actual_sold_percent,effective_sold_percent,unavailable_percent,source"
        "&order=captured_at.asc"
    )
    performances = supabase_select_all(
        "performance_snapshots"
        f"?tracked_event_id=eq.{tracked_event['id']}"
        "&select=event_snapshot_id,schedule_id,show_datetime,description,total_seats,actual_sold,effective_sold,"
        "unavailable,available,effective_sold_percent,event_snapshots(id,source,captured_at)"
        "&order=show_datetime.asc"
    )
    daily_snapshots = corrected_daily_snapshot_series(snapshots, performances)
    return {
        "event": tracked_event,
        "snapshots": daily_snapshots,
        "performances": performances,
        "uplift": uplift_metrics(daily_snapshots),
    }


def snapshot_datetime(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def first_sunday(year: int, month: int) -> date:
    first = date(year, month, 1)
    return first + timedelta(days=(6 - first.weekday()) % 7)


def sydney_offset_hours(moment_utc: datetime) -> int:
    year = moment_utc.year
    dst_start_year = year if moment_utc.month >= 10 else year - 1
    dst_end_year = year + 1 if moment_utc.month >= 10 else year
    dst_start_day = first_sunday(dst_start_year, 10)
    dst_end_day = first_sunday(dst_end_year, 4)
    dst_start_utc = datetime(
        dst_start_day.year,
        dst_start_day.month,
        dst_start_day.day,
        2,
        tzinfo=timezone.utc,
    ) - timedelta(hours=10)
    dst_end_utc = datetime(
        dst_end_day.year,
        dst_end_day.month,
        dst_end_day.day,
        3,
        tzinfo=timezone.utc,
    ) - timedelta(hours=11)
    return 11 if dst_start_utc <= moment_utc < dst_end_utc else 10


def snapshot_local_date(snapshot: dict[str, Any]) -> str:
    captured = snapshot_datetime(snapshot["captured_at"]).astimezone(timezone.utc)
    return sydney_local_date(captured)


def sydney_local_date(moment_utc: datetime) -> str:
    moment_utc = moment_utc.astimezone(timezone.utc)
    return (moment_utc + timedelta(hours=sydney_offset_hours(moment_utc))).date().isoformat()


def daily_snapshot_series(snapshots: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_date: dict[str, dict[str, Any]] = {}
    for snapshot in snapshots:
        local_date = snapshot_local_date(snapshot)
        by_date[local_date] = {**snapshot, "local_date": local_date}
    return [by_date[key] for key in sorted(by_date)]


def snapshot_source(row: dict[str, Any]) -> str:
    snapshot = row.get("event_snapshots") or {}
    return str(snapshot.get("source") or "")


def snapshot_captured_at(row: dict[str, Any]) -> datetime | None:
    snapshot = row.get("event_snapshots") or {}
    return parse_event_datetime(snapshot.get("captured_at"))


def best_finalized_performance_rows(performances: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
    best: dict[int, dict[str, Any]] = {}
    ranks: dict[int, tuple[int, float]] = {}
    for row in performances or []:
        schedule_id = int(row.get("schedule_id") or 0)
        show_time = parse_performance_wall_datetime(row.get("show_datetime"))
        captured_at = snapshot_captured_at(row)
        if not schedule_id or not show_time or not captured_at:
            continue
        source = snapshot_source(row)
        if source == "final":
            priority = 3
        elif captured_at <= show_time:
            priority = 2
        else:
            continue
        rank = (priority, captured_at.timestamp())
        if schedule_id not in ranks or rank > ranks[schedule_id]:
            best[schedule_id] = row
            ranks[schedule_id] = rank
    return best


def add_performance_to_snapshot(snapshot: dict[str, Any], row: dict[str, Any]) -> None:
    snapshot["total_seats"] = int(snapshot.get("total_seats") or 0) + int(row.get("total_seats") or 0)
    snapshot["actual_sold"] = int(snapshot.get("actual_sold") or 0) + int(row.get("actual_sold") or 0)
    snapshot["effective_sold"] = int(snapshot.get("effective_sold") or 0) + int(row.get("effective_sold") or 0)
    snapshot["unavailable"] = int(snapshot.get("unavailable") or 0) + int(row.get("unavailable") or 0)
    snapshot["available"] = int(snapshot.get("available") or 0) + int(row.get("available") or 0)


def recompute_snapshot_percentages(snapshot: dict[str, Any]) -> None:
    total = int(snapshot.get("total_seats") or 0)
    actual = int(snapshot.get("actual_sold") or 0)
    effective = int(snapshot.get("effective_sold") or 0)
    unavailable = int(snapshot.get("unavailable") or 0)
    snapshot["actual_sold_percent"] = (actual / total * 100) if total else 0
    snapshot["effective_sold_percent"] = (effective / total * 100) if total else 0
    snapshot["unavailable_percent"] = ((actual + unavailable) / total * 100) if total else 0


def corrected_daily_snapshot_series(
    snapshots: list[dict[str, Any]],
    performances: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    finalized = best_finalized_performance_rows(performances)
    daily_schedule_ids: dict[str, set[int]] = {}
    for row in performances or []:
        snapshot_id = str(row.get("event_snapshot_id") or "")
        if not snapshot_id or snapshot_source(row) != "daily":
            continue
        daily_schedule_ids.setdefault(snapshot_id, set()).add(int(row.get("schedule_id") or 0))

    corrected = []
    for snapshot in snapshots or []:
        item = dict(snapshot)
        snapshot_id = str(item.get("id") or "")
        captured_at = parse_event_datetime(item.get("captured_at"))
        included = daily_schedule_ids.get(snapshot_id, set())
        if captured_at:
            for schedule_id, row in finalized.items():
                show_time = parse_performance_wall_datetime(row.get("show_datetime"))
                if show_time and show_time <= captured_at and schedule_id not in included:
                    add_performance_to_snapshot(item, row)
        recompute_snapshot_percentages(item)
        corrected.append(item)

    return daily_snapshot_series(corrected)


def uplift_metrics(snapshots: list[dict[str, Any]]) -> dict[str, Any]:
    if not snapshots:
        return {"day": None, "week": None}

    latest = snapshots[-1]
    latest_date = datetime.fromisoformat(latest["local_date"]).date()

    def closest_daily_date_before(days: int) -> dict[str, Any] | None:
        target_date = latest_date - timedelta(days=days)
        best = None
        best_delta: int | None = None
        for item in snapshots[:-1]:
            item_date = datetime.fromisoformat(item["local_date"]).date()
            if item_date > target_date:
                continue
            delta = abs((target_date - item_date).days)
            if best_delta is None or delta < best_delta:
                best = item
                best_delta = delta
        return best

    def compare(previous: dict[str, Any] | None) -> dict[str, Any] | None:
        if not previous:
            return None
        effective_change = latest["effective_sold"] - previous["effective_sold"]
        actual_change = latest["actual_sold"] - previous["actual_sold"]
        percent_point_change = float(latest["effective_sold_percent"]) - float(previous["effective_sold_percent"])
        return {
            "from": previous["captured_at"],
            "to": latest["captured_at"],
            "actualSoldChange": actual_change,
            "effectiveSoldChange": effective_change,
            "effectiveSoldPercentPointChange": percent_point_change,
            "effectiveSoldRelativeChange": (
                effective_change / previous["effective_sold"] * 100 if previous["effective_sold"] else None
            ),
        }

    return {
        "day": compare(snapshots[-2] if len(snapshots) > 1 else None),
        "week": compare(closest_daily_date_before(7)),
    }


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/analyse":
            self.handle_analyse(parsed)
            return
        if parsed.path == "/api/snapshot/daily":
            self.handle_daily_snapshot(parsed)
            return
        if parsed.path == "/api/snapshot/finals":
            self.handle_final_snapshot(parsed)
            return
        if parsed.path == "/api/history":
            self.handle_history(parsed)
            return
        if parsed.path == "/api/tracked-events":
            self.handle_tracked_events()
            return
        self.serve_static(parsed.path)

    def handle_analyse(self, parsed: Any) -> None:
        value = parse_qs(parsed.query).get("input", [""])[0]
        try:
            payload = analyse_any_event(unquote(value))
            try:
                attach_finalized_sessions(payload)
            except StorageError as exc:
                payload["snapshotWarning"] = str(exc)
            try:
                attach_daily_performance_deltas(payload)
            except StorageError as exc:
                payload["snapshotWarning"] = str(exc)
            try:
                payload["snapshot"] = store_snapshot(payload, "search")
            except StorageError as exc:
                payload["snapshot"] = None
                payload["snapshotWarning"] = str(exc)
            self.send_json(200, payload)
        except (TicketSearchError, AnalysisError) as exc:
            self.send_json(400, {"error": str(exc)})
        except Exception as exc:  # Keep the UI useful if TicketSearch changes a response.
            self.send_json(500, {"error": f"Unexpected error: {exc}"})

    def handle_daily_snapshot(self, parsed: Any) -> None:
        params = parse_qs(parsed.query)
        secret = params.get("secret", [""])[0] or self.headers.get("X-Snapshot-Secret", "")
        if SNAPSHOT_SECRET and secret != SNAPSHOT_SECRET:
            self.send_json(403, {"error": "Invalid snapshot secret."})
            return
        try:
            self.send_json(200, run_daily_snapshots())
        except StorageError as exc:
            self.send_json(500, {"error": str(exc)})
        except Exception as exc:
            self.send_json(500, {"error": f"Unexpected error: {exc}"})

    def handle_final_snapshot(self, parsed: Any) -> None:
        params = parse_qs(parsed.query)
        secret = params.get("secret", [""])[0] or self.headers.get("X-Snapshot-Secret", "")
        if SNAPSHOT_SECRET and secret != SNAPSHOT_SECRET:
            self.send_json(403, {"error": "Invalid snapshot secret."})
            return
        try:
            window_raw = params.get("windowMinutes", ["15"])[0]
            window_minutes = max(1, min(int(window_raw), 60))
            grace_raw = params.get("lateGraceMinutes", ["30"])[0]
            late_grace_minutes = max(0, min(int(grace_raw), 120))
            self.send_json(200, run_final_snapshots(window_minutes, late_grace_minutes))
        except StorageError as exc:
            self.send_json(500, {"error": str(exc)})
        except Exception as exc:
            self.send_json(500, {"error": f"Unexpected error: {exc}"})

    def handle_history(self, parsed: Any) -> None:
        params = parse_qs(parsed.query)
        event_url = unquote(params.get("eventUrl", [""])[0])
        event_id_raw = params.get("eventId", [""])[0]
        if not event_url and not event_id_raw.isdigit():
            self.send_json(400, {"error": "Provide an eventUrl or eventId query parameter."})
            return
        try:
            self.send_json(200, event_history(int(event_id_raw) if event_id_raw.isdigit() else None, event_url or None))
        except StorageError as exc:
            self.send_json(404, {"error": str(exc)})
        except Exception as exc:
            self.send_json(500, {"error": f"Unexpected error: {exc}"})

    def handle_tracked_events(self) -> None:
        try:
            self.send_json(200, {"events": tracked_events()})
        except StorageError as exc:
            self.send_json(500, {"error": str(exc)})

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
    try:
        if configure_supabase_cron_secret():
            print("Supabase Cron snapshot secret configured.")
    except StorageError as exc:
        print(f"Supabase Cron configuration warning: {exc}")
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"Serving http://{host}:{port}")
    server.serve_forever()
