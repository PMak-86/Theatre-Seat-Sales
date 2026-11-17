const form = document.querySelector("#analyse-form");
const input = document.querySelector("#event-input");
const statusEl = document.querySelector("#status");
const summaryEl = document.querySelector("#summary");
const historyEl = document.querySelector("#history");
const historyStatusEl = document.querySelector("#history-status");
const resultsEl = document.querySelector("#results");
const sessionsEl = document.querySelector("#sessions");
const submitButton = form.querySelector("button");
const bookmarksEl = document.querySelector("#bookmarks");
const bookmarkListEl = document.querySelector("#bookmark-list");
const saveBookmarkButton = document.querySelector("#save-bookmark");
const postShowReportButton = document.querySelector("#post-show-report");
const performanceList = document.querySelector("#performance-list");
const performanceChart = document.querySelector("#performance-chart");
const BOOKMARK_STORAGE_KEY = "theatreSeatSales.savedShows";
const MAX_BOOKMARKS = 8;
let currentEvent = null;
const chartPoints = new WeakMap();
let currentData = null;
let historyData = { snapshots: [] };
let visibleSnapshots = [];
let performanceSnapshots = [];
let performanceHistoryStatus = "loading";
let selectedPerformance = null;
let selectedRange = "all";
let analysisRequest = 0;
let analysisController = null;
let historyController = null;
let isLoading = false;

const formatNumber = new Intl.NumberFormat("en-AU");
const formatCurrency = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
  maximumFractionDigits: 0,
});
const formatDate = new Intl.DateTimeFormat("en-AU", {
  weekday: "short",
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "Australia/Sydney",
});
const formatTime = new Intl.DateTimeFormat("en-AU", {
  hour: "numeric",
  minute: "2-digit",
  timeZone: "Australia/Sydney",
});
const formatShortDate = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Australia/Sydney",
});
const formatSnapshotDateTime = new Intl.DateTimeFormat("en-AU", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "Australia/Sydney",
});

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
  input.setAttribute("aria-invalid", String(isError && !currentData));
}

function percent(value) {
  return `${value.toFixed(1)}%`;
}

function progressWidth(value) {
  if (!value) return 0;
  return Math.min(Math.max(value, 2), 100);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function setText(id, value) {
  document.querySelector(id).textContent = value;
}

function savedBookmarks() {
  try {
    const parsed = JSON.parse(localStorage.getItem(BOOKMARK_STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter(item => item && typeof item.name === "string" && typeof item.url === "string" && item.url.trim()).slice(0, MAX_BOOKMARKS) : [];
  } catch (error) {
    return [];
  }
}

function saveBookmarks(items) {
  try {
    localStorage.setItem(BOOKMARK_STORAGE_KEY, JSON.stringify(items.slice(0, MAX_BOOKMARKS)));
    return true;
  } catch {
    setStatus("This browser could not save your show. Allow local storage and try again.", true);
    return false;
  }
}

function bookmarkKey(value) {
  return String(value || "").trim().toLowerCase();
}

function renderBookmarks() {
  const items = savedBookmarks();
  bookmarksEl.hidden = false;
  bookmarkListEl.innerHTML = "";
  setText("#bookmark-count", `${items.length} / ${MAX_BOOKMARKS}`);
  updateBookmarkButton();

  if (!items.length) {
    bookmarkListEl.innerHTML = `<p class="empty-bookmarks">Your shows, one click away.<br>Save a show after analysing it.</p>`;
    return;
  }

  items.forEach((item, index) => {
    const wrapper = document.createElement("div");
    wrapper.className = "bookmark-item";
    wrapper.innerHTML = `
      <button class="bookmark-load" type="button" data-index="${index}">${escapeHtml(item.name)}</button>
      <button class="bookmark-remove" type="button" data-index="${index}" aria-label="Remove ${escapeHtml(item.name)}">×</button>
    `;
    bookmarkListEl.appendChild(wrapper);
  });
}

function updateBookmarkButton() {
  const items = savedBookmarks();
  const isSaved = currentEvent && items.some((item) => bookmarkKey(item.url) === bookmarkKey(currentEvent.url));
  saveBookmarkButton.textContent = isSaved ? "✓ Saved show" : "+ Save show";
  saveBookmarkButton.setAttribute("aria-label", isSaved ? "Remove current show from saved shows" : "Save current show");
  saveBookmarkButton.setAttribute("aria-pressed", String(Boolean(isSaved)));
  saveBookmarkButton.classList.toggle("is-saved", Boolean(isSaved));
  saveBookmarkButton.title = isSaved ? "Saved show" : "Save current show";
}

function saveCurrentBookmark() {
  if (!currentEvent) return;

  const items = savedBookmarks();
  const key = bookmarkKey(currentEvent.url);
  const existingIndex = items.findIndex((item) => bookmarkKey(item.url) === key);
  const nextItem = {
    name: currentEvent.name,
    url: currentEvent.url,
  };

  if (existingIndex >= 0) {
    items.splice(existingIndex, 1);
    if (!saveBookmarks(items)) return;
    renderBookmarks();
    setStatus(`Removed ${currentEvent.name} from saved shows.`);
    return;
  }

  items.unshift(nextItem);
  if (!saveBookmarks(items)) return;
  renderBookmarks();
  updateBookmarkButton();
  setStatus(`Saved ${currentEvent.name}`);
}

function signedNumber(value) {
  if (value === null || value === undefined) return "-";
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${formatNumber.format(value)}`;
}

function dailyDeltaLabel(value) {
  if (value === null || value === undefined) return "-";
  return signedNumber(value);
}

function revenueLabel(estimate) {
  if (!estimate || estimate.amount === null || estimate.amount === undefined) return "-";
  return formatCurrency.format(Number(estimate.amount));
}

function soldCellLabel(session) {
  if (session.capacityUnknown && session.isSoldOut) return "Sold out";
  if (session.capacityUnknown) return `${formatNumber.format(session.availableSeats)} available`;
  return `${formatNumber.format(session.ticketsSold)} / ${formatNumber.format(session.totalSeats)}`;
}

function percentCellLabel(session) {
  if (session.capacityUnknown && session.isSoldOut) return "Sold out";
  if (session.capacityUnknown) return "Capacity unknown";
  return percent(session.effectiveSoldPercent);
}

function sellThroughBar(session) {
  return `<div class="bar">
    <span>${percentCellLabel(session)}</span>
    ${session.capacityUnknown ? "" : `<span class="track" aria-hidden="true"><span class="fill" style="width: ${progressWidth(session.effectiveSoldPercent)}%"></span></span>`}
  </div>`;
}

function renderSeatMap(seatMap) {
  if (!seatMap || !Array.isArray(seatMap.seats) || !seatMap.seats.length) {
    return "";
  }

  if (seatMap.type === "laycock-main") {
    return renderLaycockSeatMap(seatMap);
  }
  if (seatMap.type === "red-tree-main") {
    return renderRedTreeSeatMap(seatMap);
  }
  if (seatMap.type === "art-house-main") {
    return renderArtHouseSeatMap(seatMap);
  }

  const columns = Math.max(8, Math.min(Number(seatMap.columns) || 20, 40));
  const seats = seatMap.seats
    .map((seat) => {
      const status = escapeHtml(seat.status || "available");
      const titleParts = [seat.label, seat.code ? `Code ${seat.code}` : "", `Seat ${Number(seat.index || 0) + 1}`]
        .filter(Boolean);
      return `<span class="seat-dot seat-${status}" title="${escapeHtml(titleParts.join(" - "))}"></span>`;
    })
    .join("");
  const legend = (seatMap.legend || [])
    .map((item) => `
      <span class="seat-legend-item">
        <span class="seat-dot seat-${escapeHtml(item.status)}"></span>
        ${escapeHtml(item.label)}
      </span>
    `)
    .join("");

  return `
    <div class="seat-map-panel">
      <div class="seat-map-header">
        <strong>Seat map snapshot</strong>
        <span>${formatNumber.format(seatMap.seatCount || seatMap.seats.length)} seats captured at analysis time</span>
      </div>
      <div class="seat-map-stage">Stage</div>
      <div class="seat-map-grid" style="--seat-columns: ${columns}">
        ${seats}
      </div>
      <div class="seat-map-legend">${legend}</div>
    </div>
  `;
}

function seatTitle(seat) {
  const titleParts = [
    seat.row && seat.seatNumber ? `Row ${seat.row} Seat ${seat.seatNumber}` : `Seat ${Number(seat.index || 0) + 1}`,
    seat.label,
    seat.code ? `Code ${seat.code}` : "",
  ].filter(Boolean);
  return escapeHtml(titleParts.join(" - "));
}

function renderSeatDot(seat, extraClass = "", style = "") {
  if (!seat) {
    return `<span class="seat-empty" aria-hidden="true"></span>`;
  }
  const status = escapeHtml(seat.status || "available");
  const className = extraClass ? ` ${extraClass}` : "";
  const styleAttr = style ? ` style="${style}"` : "";
  return `<span class="seat-dot seat-${status}${className}"${styleAttr} title="${seatTitle(seat)}"></span>`;
}

function renderLaycockSeatMap(seatMap) {
  const seatByPosition = new Map(
    seatMap.seats
      .filter((seat) => seat.row && seat.seatNumber)
      .map((seat) => [`${seat.row}-${seat.seatNumber}`, seat])
  );
  const rows = ["N", "M", "L", "K", "J", "H", "G", "F", "E", "D", "C", "B", "A"];
  const rowMarkup = rows
    .map((row) => {
      const leftSeats = Array.from({ length: 16 }, (_, index) => {
        const seatNumber = index + 1;
        return renderSeatDot(seatByPosition.get(`${row}-${seatNumber}`));
      }).join("");
      const rightSeats = Array.from({ length: 16 }, (_, index) => {
        const seatNumber = index + 17;
        return renderSeatDot(seatByPosition.get(`${row}-${seatNumber}`));
      }).join("");
      return `
        <div class="laycock-row">
          <span class="laycock-row-label">${row}</span>
          <div class="laycock-seat-block">${leftSeats}</div>
          <span class="laycock-aisle"></span>
          <div class="laycock-seat-block">${rightSeats}</div>
          <span class="laycock-row-label">${row}</span>
        </div>
      `;
    })
    .join("");
  const legend = (seatMap.legend || [])
    .map((item) => `
      <span class="seat-legend-item">
        <span class="seat-dot seat-${escapeHtml(item.status)}"></span>
        ${escapeHtml(item.label)}
      </span>
    `)
    .join("");

  return `
    <div class="seat-map-panel laycock-seat-map-panel">
      <div class="seat-map-header">
        <strong>Laycock Street seat map snapshot</strong>
        <span>${formatNumber.format(seatMap.seatCount || seatMap.seats.length)} seats captured at analysis time</span>
      </div>
      <div class="laycock-map">
        <div class="laycock-back-label">Back row</div>
        ${rowMarkup}
        <div class="laycock-stage">Stage</div>
      </div>
      <div class="seat-map-legend">${legend}</div>
    </div>
  `;
}

function renderRedTreeSeatMap(seatMap) {
  const seatByPosition = new Map(
    seatMap.seats
      .filter((seat) => seat.row && seat.seatNumber)
      .map((seat) => [`${seat.row}-${seat.seatNumber}`, seat])
  );
  const rows = ["A", "B", "C", "D", "E", "F", "G", "H"];
  const rowMarkup = rows
    .map((row, rowIndex) => {
      const leftSeats = Array.from({ length: 5 }, (_, index) => {
        const seatNumber = index + 1;
        return renderSeatDot(seatByPosition.get(`${row}-${seatNumber}`));
      }).join("");
      const centreSeats = Array.from({ length: 8 }, (_, index) => {
        const seatNumber = index + 6;
        return renderSeatDot(seatByPosition.get(`${row}-${seatNumber}`));
      }).join("");
      const rightSeats = Array.from({ length: 6 }, (_, index) => {
        const seatNumber = index + 14;
        return renderSeatDot(seatByPosition.get(`${row}-${seatNumber}`));
      }).join("");
      const gridRow = rowIndex + 1;
      return `
        <span class="red-tree-row-label" style="grid-row: ${gridRow}; grid-column: 1;">${row}</span>
        <div class="red-tree-seat-block red-tree-left-block" style="grid-row: ${gridRow}; grid-column: 2;">${leftSeats}</div>
        <div class="red-tree-seat-block red-tree-centre-block" style="grid-row: ${gridRow}; grid-column: 4;">${centreSeats}</div>
        <div class="red-tree-seat-block red-tree-right-block" style="grid-row: ${gridRow}; grid-column: 6;">${rightSeats}</div>
        <span class="red-tree-row-label" style="grid-row: ${gridRow}; grid-column: 7;">${row}</span>
      `;
    })
    .join("");
  const legend = (seatMap.legend || [])
    .map((item) => `
      <span class="seat-legend-item">
        <span class="seat-dot seat-${escapeHtml(item.status)}"></span>
        ${escapeHtml(item.label)}
      </span>
    `)
    .join("");

  return `
    <div class="seat-map-panel red-tree-seat-map-panel">
      <div class="seat-map-header">
        <strong>Red Tree Theatre seat map snapshot</strong>
        <span>${formatNumber.format(seatMap.seatCount || seatMap.seats.length)} seats captured at analysis time</span>
      </div>
      <div class="red-tree-map">
        <div class="red-tree-stage">Stage</div>
        <div class="red-tree-front-label">Front row</div>
        <div class="red-tree-seating-area">
          <span class="red-tree-long-aisle" style="grid-column: 3;">Aisle</span>
          <span class="red-tree-long-aisle" style="grid-column: 5;">Aisle</span>
          ${rowMarkup}
        </div>
        <div class="red-tree-back-label">Back row</div>
      </div>
      <div class="seat-map-legend">${legend}</div>
    </div>
  `;
}

function artHouseRowSeatCount(seatsByPosition, section, rows) {
  return Math.max(
    1,
    ...rows.map((row) => seatsByPosition.filter((seat) => seat.section === section && seat.row === row).length)
  );
}

function renderArtHouseRows(seatsByPosition, section, rows, blockClass, seatCount = null) {
  const fixedSeatCount = seatCount || artHouseRowSeatCount(seatsByPosition, section, rows);
  return rows
    .map((row) => {
      const rowSeats = seatsByPosition
        .filter((seat) => seat.section === section && seat.row === row)
        .sort((a, b) => {
          const ax = Number.isFinite(a.visualX) ? a.visualX : 0;
          const bx = Number.isFinite(b.visualX) ? b.visualX : 0;
          if (ax !== bx) return ax - bx;
          const ay = Number.isFinite(a.visualY) ? a.visualY : 0;
          const by = Number.isFinite(b.visualY) ? b.visualY : 0;
          if (ay !== by) return ay - by;
          return Number(b.seatNumber || 0) - Number(a.seatNumber || 0);
        });
      const seats = rowSeats
        .map((seat) => renderSeatDot(seat))
        .join("");
      return `
        <div class="art-house-row ${blockClass}-row">
          <span class="art-house-row-label">${escapeHtml(row)}</span>
          <div class="art-house-seat-block ${blockClass}-seats" style="--art-house-seat-count: ${fixedSeatCount}">${seats}</div>
          <span class="art-house-row-label">${escapeHtml(row)}</span>
        </div>
      `;
    })
    .join("");
}

function artHouseBounds(seats) {
  const coordinates = seats.filter((seat) => Number.isFinite(seat.visualX) && Number.isFinite(seat.visualY));
  if (!coordinates.length) return null;
  const xs = coordinates.map((seat) => seat.visualX);
  const ys = coordinates.map((seat) => seat.visualY);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const width = Math.max(maxX - minX, 1);
  const height = Math.max(maxY - minY, 1);
  return {
    minX: minX - width * 0.06,
    maxX: maxX + width * 0.06,
    minY: minY - height * 0.06,
    maxY: maxY + height * 0.22,
  };
}

function coordinatePercent(value, min, max) {
  return ((value - min) / Math.max(max - min, 1)) * 100;
}

function renderArtHouseCoordinateStalls(seats) {
  const stallsSeats = seats.filter((seat) => seat.section === "Stalls");
  const bounds = artHouseBounds(stallsSeats);
  if (!bounds) return "";

  const seatMarkup = stallsSeats
    .map((seat) => {
      const left = coordinatePercent(seat.visualX, bounds.minX, bounds.maxX);
      const top = coordinatePercent(seat.visualY, bounds.minY, bounds.maxY);
      return renderSeatDot(
        seat,
        "art-house-coordinate-seat",
        `left: ${left.toFixed(3)}%; top: ${top.toFixed(3)}%;`
      );
    })
    .join("");

  const rowLabels = [...new Set(stallsSeats.map((seat) => seat.row))]
    .map((row) => {
      const rowSeats = stallsSeats.filter((seat) => seat.row === row);
      const y = rowSeats.reduce((total, seat) => total + seat.visualY, 0) / rowSeats.length;
      const top = coordinatePercent(y, bounds.minY, bounds.maxY);
      return `
        <span class="art-house-coordinate-row-label art-house-coordinate-row-label-left" style="top: ${top.toFixed(3)}%">${escapeHtml(row)}</span>
        <span class="art-house-coordinate-row-label art-house-coordinate-row-label-right" style="top: ${top.toFixed(3)}%">${escapeHtml(row)}</span>
      `;
    })
    .join("");
  const ratio = ((bounds.maxX - bounds.minX) / Math.max(bounds.maxY - bounds.minY, 1)).toFixed(3);

  return `
    <div class="art-house-stalls art-house-stalls-coordinate" style="--art-house-stalls-ratio: ${ratio};">
      <div class="art-house-coordinate-stage">Stage</div>
      ${rowLabels}
      ${seatMarkup}
    </div>
  `;
}

function renderArtHouseSeatMap(seatMap) {
  const seatsByPosition = (seatMap.seats || [])
    .filter((seat) => seat.section && seat.row && seat.seatNumber)
    .map((seat) => ({
      ...seat,
      visualX: Number(seat.visualX),
      visualY: Number(seat.visualY),
    }));
  const rowOrder = (section, fallback) => (
    fallback.filter((row) => seatsByPosition.some((seat) => seat.section === section && seat.row === row))
  );
  const upperRows = ["T", "S", "R", "Q", "P", "N", "M", "L", "K", "J"];
  const lowerRows = ["H", "G", "F", "E", "D", "C", "B", "A"];
  const balconyRows = ["F", "E", "D", "C", "B", "A"];
  const upperSeatCount = artHouseRowSeatCount(seatsByPosition, "Stalls", rowOrder("Stalls", upperRows));
  const lowerSeatCount = artHouseRowSeatCount(seatsByPosition, "Stalls", rowOrder("Stalls", lowerRows));
  const balconySeatCount = Math.max(
    artHouseRowSeatCount(seatsByPosition, "Balcony 1", rowOrder("Balcony 1", balconyRows)),
    artHouseRowSeatCount(seatsByPosition, "Balcony 2", rowOrder("Balcony 2", balconyRows))
  );
  const legend = (seatMap.legend || [])
    .map((item) => `
      <span class="seat-legend-item">
        <span class="seat-dot seat-${escapeHtml(item.status)}"></span>
        ${escapeHtml(item.label)}
      </span>
    `)
    .join("");

  return `
    <div class="seat-map-panel art-house-seat-map-panel">
      <div class="seat-map-header">
        <strong>The Art House seat map snapshot</strong>
        <span>${formatNumber.format(seatMap.seatCount || seatMap.seats.length)} seats captured at analysis time</span>
      </div>
      <div class="art-house-map">
        <div class="art-house-stalls-label">Stalls</div>
        <div class="art-house-balcony art-house-balcony-two">
          <div class="art-house-balcony-title">Balcony 2</div>
          ${renderArtHouseRows(seatsByPosition, "Balcony 2", rowOrder("Balcony 2", balconyRows), "art-house-balcony", balconySeatCount)}
        </div>
        <div class="art-house-stalls">
          <div class="art-house-stalls-upper">
            ${renderArtHouseRows(seatsByPosition, "Stalls", rowOrder("Stalls", upperRows), "art-house-stalls-upper", upperSeatCount)}
          </div>
          <div class="art-house-stalls-gap"></div>
          <div class="art-house-stalls-lower">
            ${renderArtHouseRows(seatsByPosition, "Stalls", rowOrder("Stalls", lowerRows), "art-house-stalls-lower", lowerSeatCount)}
          </div>
          <div class="art-house-stage">Stage</div>
        </div>
        <div class="art-house-balcony art-house-balcony-one">
          <div class="art-house-balcony-title">Balcony 1</div>
          ${renderArtHouseRows(seatsByPosition, "Balcony 1", rowOrder("Balcony 1", balconyRows), "art-house-balcony", balconySeatCount)}
        </div>
      </div>
      <div class="seat-map-legend">${legend}</div>
    </div>
  `;
}

function baselineLabel(value) {
  if (!value) return "No daily baseline yet";
  return `Compared with ${formatSnapshotDateTime.format(new Date(value))}`;
}

function finalNumbersBadge(session) {
  if (!session.isFinal && !session.isHistoricalSnapshot) return "";
  if (!session.isFinal) {
    const captured = session.finalSnapshotCapturedAt
      ? `Last recorded snapshot captured ${formatSnapshotDateTime.format(new Date(session.finalSnapshotCapturedAt))}. No confirmed final snapshot was stored.`
      : "Last recorded snapshot. No confirmed final snapshot was stored.";
    return `<span class="final-badge last-recorded-badge" title="${escapeHtml(captured)}">Last recorded</span>`;
  }
  const sourceNote = session.finalSnapshotSource === "retired"
    ? "using retired schedule snapshot"
    : session.finalSnapshotIsFallback
      ? "using latest stored snapshot"
      : "using final pre-show snapshot";
  const captured = session.finalSnapshotCapturedAt
    ? `Final numbers ${sourceNote}, captured ${formatSnapshotDateTime.format(new Date(session.finalSnapshotCapturedAt))}`
    : `Final numbers ${sourceNote}`;
  return `<span class="final-badge" title="${escapeHtml(captured)}">Final numbers</span>`;
}

function formatDateRange(range) {
  if (!range || !range.start) return "Dates not supplied";
  const start = new Date(range.start);
  const end = range.end ? new Date(range.end) : start;
  if (formatShortDate.format(start) === formatShortDate.format(end)) {
    return formatShortDate.format(start);
  }
  return `${formatShortDate.format(start)} to ${formatShortDate.format(end)}`;
}

function render(data) {
  const previous = currentData?.eventUrl === data.eventUrl
    ? currentData?.sessions[selectedPerformance]?.scheduleId
    : null;
  currentData = data;
  selectedPerformance = previous == null ? null : data.sessions.findIndex(session => session.scheduleId === previous);
  document.querySelector("#dashboard").hidden = false;
  document.querySelector("#welcome").hidden = true;
  document.querySelector("#export-csv").disabled = false;
  setText("#provider-label", data.provider === "trybooking" ? "TryBooking" : "TicketSearch");
  setText("#performance-count", data.sessions.length);
  const summary = data.summary;
  const art = document.querySelector(".show-art");
  art.replaceChildren();
  art.hidden = !data.imageUrl;
  if (data.imageUrl) {
    const image = document.createElement("img");
    image.id = "event-image";
    image.alt = data.eventName || "Event artwork";
    image.onerror = () => { art.hidden = true; };
    image.src = data.imageUrl;
    art.appendChild(image);
  }
  currentEvent = {
    name: data.eventName || `Event ${data.eventId}`,
    url: data.eventUrl || input.value.trim(),
  };
  saveBookmarkButton.disabled = !currentEvent.url;
  const allFinal = data.sessions.length > 0 && data.sessions.every((session) => session.isFinal);
  setText("#event-run-label", allFinal ? "Completed run" : "Performance overview");
  postShowReportButton.hidden = !allFinal;
  updateBookmarkButton();

  setText("#event-name", data.eventName || `Event ${data.eventId}`);
  setText("#event-location", data.venue || data.location || "");
  setText("#event-dates", formatDateRange(data.dateRange));
  const capturedAt = data.snapshot?.capturedAt || data.generatedAt;
  setText("#analysis-time", capturedAt ? `Analysed ${formatSnapshotDateTime.format(new Date(capturedAt))} · Sydney time` : "Analysis time unavailable");
  setText("#overall-percent", summary.capacityUnknown ? "N/A" : percent(summary.effectiveSoldPercent));
  document.querySelector("#overall-ring").style.setProperty("--sold", `${summary.capacityUnknown ? 0 : Math.min(summary.effectiveSoldPercent, 100)}%`);
  setText("#overall-sold-today", dailyDeltaLabel(summary.salesSinceDailySnapshot));
  setText("#overall-sales-baseline", summary.dailySnapshotCapturedAt
    ? `since ${formatSnapshotDateTime.format(new Date(summary.dailySnapshotCapturedAt))}`
    : "since last daily snapshot");
  setText("#metric-performances", formatNumber.format(summary.performances));
  setText("#metric-total", summary.capacityUnknown ? "Unknown" : formatNumber.format(summary.totalSeats));
  setText("#metric-sold", formatNumber.format(summary.ticketsSold));
  setText("#metric-unavailable", formatNumber.format(summary.unavailableSeats));
  setText("#metric-left", formatNumber.format(summary.availableSeats));
  setText("#metric-revenue", revenueLabel(summary.revenueEstimate));
  document.querySelector("#metric-revenue").title = summary.revenueEstimate?.basis || "Estimated ticket revenue";

  sessionsEl.innerHTML = "";
  data.sessions.forEach((session, index) => {
    const when = session.dateTime ? new Date(session.dateTime) : null;
    const row = document.createElement("tr");
    row.className = `session-row${session.isFinal ? " session-final" : ""}`;
    row.dataset.detail = `detail-${index}`;
    row.dataset.index = index;
    row.innerHTML = `
      <td><button class="expand-button" type="button" aria-label="Show details for ${escapeHtml(when ? `${formatDate.format(when)}, ${formatTime.format(when)}` : 'performance')}" aria-expanded="false" aria-controls="detail-${index}">+</button></td>
      <td data-label="Date"><span>${when ? formatDate.format(when) : ""}</span>${finalNumbersBadge(session)}</td>
      <td data-label="Time">${when ? formatTime.format(when) : ""}</td>
      <td data-label="Tickets sold">${soldCellLabel(session)}</td>
      <td data-label="Unavailable">${formatNumber.format(session.unavailableSeats)}</td>
      <td data-label="Available">${formatNumber.format(session.availableSeats)}</td>
      <td data-label="Sold today" title="${escapeHtml(baselineLabel(session.dailySnapshotCapturedAt))}">
        <span class="delta-value">${dailyDeltaLabel(session.salesSinceDailySnapshot)}</span>
      </td>
      <td data-label="Sell-through">${sellThroughBar(session)}</td>
    `;
    sessionsEl.appendChild(row);

    const detailRow = document.createElement("tr");
    detailRow.id = `detail-${index}`;
    detailRow.className = "detail-row";
    detailRow.hidden = true;
    sessionsEl.appendChild(detailRow);
  });

  summaryEl.hidden = false;
  resultsEl.hidden = false;
  document.querySelector("#session-search").value = "";
  document.querySelector("#session-filter").value = "all";
  document.querySelector("#session-sort").value = "date";
  loadHistory(data);
  applyPerformanceFilters();
}

function performanceNotes(session) {
  return `
    ${session.capacityUnknown && session.statusLabel ? `<span>${escapeHtml(session.statusLabel)}</span>` : ""}
    <span title="${escapeHtml(session.revenueEstimate?.basis || "Estimated ticket revenue")}">${revenueLabel(session.revenueEstimate)} est. revenue</span>
    ${finalNumbersBadge(session)}
    ${session.finalSnapshotCapturedAt ? `<span>Snapshot: ${escapeHtml(formatSnapshotDateTime.format(new Date(session.finalSnapshotCapturedAt)))}</span>` : ""}
  `;
}

function performanceSeatDetails(session) {
  return `${renderSeatMap(session.seatMap)}${renderBreakdown(session.breakdown)}`;
}

function performanceDetails(session) {
  return `
    <div class="detail-summary">
      <span>${formatNumber.format(session.ticketsSold)} sold</span>
      <span>${formatNumber.format(session.effectiveSoldSeats)} counted in sell-through</span>
      <span>${formatNumber.format(session.unavailableSeats)} unavailable but not sold</span>
      <span>${formatNumber.format(session.availableSeats)} available to buy</span>
      ${!session.isFinal && !session.isHistoricalSnapshot && session.dailySnapshotCapturedAt
        ? `<span>${dailyDeltaLabel(session.salesSinceDailySnapshot)} sold since ${escapeHtml(formatSnapshotDateTime.format(new Date(session.dailySnapshotCapturedAt)))}</span>`
        : ""}
      ${performanceNotes(session)}
    </div>
    ${performanceSeatDetails(session)}
  `;
}

function populateMobileDetails(row) {
  if (row.firstElementChild) return;
  const index = Number(row.id.replace("detail-", ""));
  row.innerHTML = `<td colspan="8"><div class="detail-panel"><h3>Seat status detail</h3>${performanceDetails(currentData.sessions[index])}</div></td>`;
}

function selectPerformance(index) {
  selectedPerformance = index;
  const session = currentData.sessions[index];
  if (!session) return;
  for (const button of performanceList.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(Number(button.dataset.index) === index));
  }
  const when = session.dateTime ? new Date(session.dateTime) : null;
  setText("#selected-performance-title", when
    ? `${formatDate.format(when)} · ${formatTime.format(when)}`
    : "Performance time unavailable");
  document.querySelector("#selected-performance-stats").innerHTML = `
    <div><dt>Tickets sold</dt><dd>${soldCellLabel(session)}</dd></div>
    <div><dt>Unavailable</dt><dd>${formatNumber.format(session.unavailableSeats)}</dd></div>
    <div><dt>Available</dt><dd>${formatNumber.format(session.availableSeats)}</dd></div>
    <div><dt>Sold today</dt><dd class="delta-value" title="${escapeHtml(baselineLabel(session.dailySnapshotCapturedAt))}">${dailyDeltaLabel(session.salesSinceDailySnapshot)}</dd></div>
    <div><dt>Sell-through</dt><dd>${sellThroughBar(session)}</dd></div>
  `;
  document.querySelector("#selected-performance-notes").innerHTML = performanceNotes(session);
  document.querySelector("#selected-performance-details").innerHTML = performanceSeatDetails(session);
  renderPerformanceHistory();
}

function renderPerformanceHistory() {
  const session = currentData?.sessions[selectedPerformance];
  const recorded = historyData.performanceHistory?.[session?.scheduleId] || [];
  // Later event analyses can carry a completed performance's final count forward.
  const finalTime = Date.parse(session?.finalSnapshotCapturedAt);
  const points = Number.isFinite(finalTime)
    ? recorded.filter(point => Date.parse(point.capturedAt) <= finalTime)
    : recorded;
  performanceSnapshots = points.map(point => ({
    captured_at: point.capturedAt,
    actual_sold: point.actualSold,
  }));
  const hasPoints = points.length > 0;
  const latest = points.at(-1);
  setText("#performance-history-status", latest
    ? `${formatNumber.format(latest.actualSold)} tickets sold at the last snapshot · ${formatSnapshotDateTime.format(new Date(latest.capturedAt))}`
    : { loading: "Loading performance snapshots…", error: "Performance sales history is currently unavailable.", ready: "No sales snapshots have been recorded for this performance yet." }[performanceHistoryStatus]);
  document.querySelector("#performance-chart-wrap").hidden = !hasPoints;
  document.querySelector("#performance-history-data").hidden = !hasPoints;
  document.querySelector("#performance-history-data").open = false;
  renderSnapshotTable("#performance-history-body", performanceSnapshots);
  drawHistoryChart(performanceSnapshots, performanceChart);
}

function renderSnapshotTable(selector, snapshots) {
  document.querySelector(selector).innerHTML = snapshots.map(snapshot =>
    `<tr><td>${escapeHtml(formatSnapshotDateTime.format(new Date(snapshot.captured_at)))}</td><td>${formatNumber.format(Number(snapshot.actual_sold || 0))}</td></tr>`
  ).join("");
}

async function loadHistory(data) {
  historyController?.abort();
  historyController = new AbortController();
  const controller = historyController;
  historyData = { snapshots: [] };
  visibleSnapshots = [];
  performanceHistoryStatus = "loading";
  renderPerformanceHistory();
  historyEl.hidden = false;
  historyStatusEl.textContent = "Loading recorded snapshots…";
  drawHistoryChart([]);
  try {
    const historyUrl = data.eventUrl
      ? `/api/history?eventUrl=${encodeURIComponent(data.eventUrl)}`
      : `/api/history?eventId=${encodeURIComponent(data.eventId)}`;
    const response = await fetch(`${historyUrl}&view=dashboard`, { signal: controller.signal });
    const history = await response.json();
    if (!response.ok) {
      throw new Error(history.error || "No history found.");
    }
    if (currentData !== data || controller.signal.aborted) return;
    historyData = history;
    performanceHistoryStatus = "ready";
    renderPerformanceHistory();
    renderHistory(history);
    historyEl.hidden = false;
  } catch (error) {
    if (currentData !== data || controller.signal.aborted) return;
    performanceHistoryStatus = "error";
    renderPerformanceHistory();
    document.querySelector("#history-data-body").innerHTML = "";
    historyStatusEl.textContent = "Sales history will appear after snapshots are collected.";
    setText("#uplift-day", "-");
    setText("#uplift-week", "-");
    drawHistoryChart([]);
    historyEl.hidden = false;
  }
}

function renderHistory(history) {
  const allSnapshots = (history.snapshots || []).slice().sort((a, b) => new Date(a.captured_at) - new Date(b.captured_at));
  const latestTime = allSnapshots.length ? chartDate(allSnapshots[allSnapshots.length - 1]).getTime() : 0;
  const cutoff = selectedRange === "all" ? -Infinity : latestTime - (Number(selectedRange) - 1) * 86400000;
  const snapshots = allSnapshots.filter(snapshot => chartDate(snapshot).getTime() >= cutoff);
  visibleSnapshots = snapshots;
  renderSnapshotTable("#history-data-body", snapshots);
  const latest = snapshots[snapshots.length - 1];
  historyStatusEl.textContent = snapshots.length === 0 ? "Sales history will appear after snapshots are collected." : snapshots.length === 1
    ? "1 daily snapshot collected. Uplift appears after the next scheduled snapshot."
    : `${formatNumber.format(snapshots.length)} daily snapshots collected.`;
  setText("#uplift-day", signedNumber(history.uplift?.day?.actualSoldChange));
  setText("#uplift-week", signedNumber(history.uplift?.week?.actualSoldChange));
  if (latest) {
    historyStatusEl.textContent += ` Latest ticket sales: ${formatNumber.format(latest.actual_sold)}.`;
  }
  setText("#history-range-label", selectedRange === "all" ? "All recorded snapshots" : `${selectedRange} days to latest snapshot`);
  drawHistoryChart(snapshots);
}

function chartDate(snapshot) {
  if (snapshot.local_date) {
    // Plot a local calendar day independently of the viewer's machine timezone.
    return new Date(`${snapshot.local_date}T00:00:00Z`);
  }
  return new Date(snapshot.captured_at);
}

function niceTicks(minValue, maxValue, count = 5) {
  if (minValue === maxValue) {
    const step = Math.max(1, Math.ceil(Math.max(maxValue, 1) / 4));
    const start = Math.max(0, minValue - step * 2);
    return Array.from({ length: count }, (_, index) => start + step * index);
  }

  const rawStep = (maxValue - minValue) / Math.max(count - 1, 1);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const multiplier = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  const step = multiplier * magnitude;
  const start = Math.floor(minValue / step) * step;
  const end = Math.ceil(maxValue / step) * step;
  const ticks = [];

  for (let value = start; value <= end + step / 2; value += step) {
    ticks.push(Math.round(value));
  }

  return ticks;
}

function drawHistoryChart(snapshots, canvas = historyChart) {
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = rect.width;
  const height = rect.height;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const points = [];
  chartPoints.set(canvas, points);
  hideHistoryTooltip(canvas);
  ctx.clearRect(0, 0, width, height);
  const padding = { top: 24, right: 16, bottom: 34, left: width < 500 ? 42 : 54 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  ctx.font = '11px "Funnel Sans", sans-serif';
  ctx.fillStyle = "#727d70";
  if (!snapshots.length) {
    canvas.setAttribute("aria-label", "No sales snapshots recorded yet");
    ctx.textAlign = "center";
    ctx.fillText("No snapshots recorded yet", width / 2, height / 2);
    return;
  }
  const values = snapshots.map(item => Number(item.actual_sold || 0));
  const ticks = niceTicks(0, Math.max(...values, 1), 5);
  const maxValue = ticks[ticks.length - 1];
  const times = snapshots.map(snapshot => chartDate(snapshot).getTime());
  const firstTime = times[0];
  const lastTime = times[times.length - 1];
  const pointX = index => padding.left + (lastTime === firstTime ? plotWidth / 2 : ((times[index] - firstTime) / (lastTime - firstTime)) * plotWidth);
  const pointY = value => padding.top + plotHeight - (value / Math.max(maxValue, 1)) * plotHeight;
  ctx.textAlign = "right";
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 4]);
  ticks.forEach(tick => {
    const y = pointY(tick);
    ctx.strokeStyle = "#e7ece3";
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
    ctx.fillStyle = "#727d70";
    ctx.fillText(formatNumber.format(tick), padding.left - 12, y + 4);
  });
  ctx.setLineDash([]);
  ctx.beginPath();
  values.forEach((value, index) => {
    if (index === 0) ctx.moveTo(pointX(index), pointY(value));
    else ctx.lineTo(pointX(index), pointY(value));
  });
  ctx.lineTo(pointX(values.length - 1), padding.top + plotHeight);
  ctx.lineTo(pointX(0), padding.top + plotHeight);
  ctx.closePath();
  ctx.fillStyle = "#edf3e8";
  ctx.fill();
  ctx.beginPath();
  values.forEach((value, index) => {
    if (index === 0) ctx.moveTo(pointX(index), pointY(value));
    else ctx.lineTo(pointX(index), pointY(value));
  });
  ctx.strokeStyle = "#668750";
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round";
  ctx.stroke();
  values.forEach((value, index) => {
    const x = pointX(index), y = pointY(value);
    points.push({ x: x * dpr, y: y * dpr, value, capturedAt: snapshots[index].captured_at });
    if (values.length <= 12 || index === values.length - 1) {
      ctx.beginPath();
      ctx.arc(x, y, index === values.length - 1 ? 4 : 3, 0, Math.PI * 2);
      ctx.fillStyle = "#668750";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#fff";
      ctx.stroke();
    }
  });
  const day = 86400000;
  const span = lastTime - firstTime;
  const intraday = span > 0 && span < day;
  const count = span === 0 ? 1 : Math.min(snapshots.length, width < 500 ? 3 : 6, intraday ? 3 : Math.floor(span / day) + 1);
  const dateLabel = new Intl.DateTimeFormat("en-AU", {
    day: "numeric", month: "short", timeZone: "Australia/Sydney",
    ...(intraday ? { hour: "numeric", minute: "2-digit" } : {}),
  });
  for (let index = 0; index < count; index++) {
    const ratio = count === 1 ? 0.5 : index / (count - 1);
    ctx.textAlign = count === 1 ? "center" : index === 0 ? "left" : index === count - 1 ? "right" : "center";
    ctx.fillStyle = "#727d70";
    ctx.fillText(dateLabel.format(new Date(firstTime + ratio * span)), padding.left + ratio * plotWidth, height - 10);
  }
  canvas.setAttribute("aria-label", snapshots.length + " sales snapshots. Latest: " + formatNumber.format(values[values.length - 1]) + " tickets sold. Exact values are in the snapshot table below.");
}


function hideHistoryTooltip(canvas) {
  canvas.parentElement.querySelector(".history-tooltip").hidden = true;
}

function showHistoryTooltip(canvas, point, clientX) {
  const historyTooltipEl = canvas.parentElement.querySelector(".history-tooltip");
  const canvasRect = canvas.getBoundingClientRect();
  const wrapRect = canvas.parentElement.getBoundingClientRect();
  const scaleX = canvasRect.width / canvas.width;
  const scaleY = canvasRect.height / canvas.height;
  const pointLeft = canvasRect.left - wrapRect.left + point.x * scaleX;
  const pointTop = canvasRect.top - wrapRect.top + point.y * scaleY;
  const alignRight = clientX > canvasRect.left + canvasRect.width / 2;
  const date = new Date(point.capturedAt);

  historyTooltipEl.innerHTML = `
    <strong>${formatSnapshotDateTime.format(date)}</strong>
    <span>${formatNumber.format(point.value)} tickets sold</span>
  `;
  historyTooltipEl.hidden = false;
  const tooltipWidth = historyTooltipEl.offsetWidth;
  const tooltipHeight = historyTooltipEl.offsetHeight;
  const left = alignRight ? pointLeft - tooltipWidth - 12 : pointLeft + 12;
  historyTooltipEl.style.left = `${Math.max(4, Math.min(left, wrapRect.width - tooltipWidth - 4))}px`;
  historyTooltipEl.style.top = `${Math.max(4, pointTop - tooltipHeight / 2)}px`;
  historyTooltipEl.style.transform = "none";
}

function handleHistoryPointer(event) {
  const canvas = event.currentTarget;
  const points = chartPoints.get(canvas);
  if (!points?.length) {
    hideHistoryTooltip(canvas);
    return;
  }

  const rect = canvas.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
  const y = ((event.clientY - rect.top) / rect.height) * canvas.height;
  const hitRadius = (event.pointerType === "touch" ? 30 : 18) * (canvas.width / rect.width);
  const nearest = points
    .map((point) => ({
      point,
      distance: Math.hypot(point.x - x, point.y - y),
    }))
    .sort((a, b) => a.distance - b.distance)[0];

  if (!nearest || nearest.distance > hitRadius) {
    hideHistoryTooltip(canvas);
    canvas.style.cursor = "default";
    return;
  }

  canvas.style.cursor = "pointer";
  showHistoryTooltip(canvas, nearest.point, event.clientX);
}

function renderBreakdown(breakdown = []) {
  if (!breakdown.length) {
    return `<p class="empty-detail">No detailed unavailable-seat codes were returned for this session.</p>`;
  }

  const rows = breakdown
    .map((item) => {
      const excluded = item.excludedFromCapacity
        ? `${formatNumber.format(item.excludedFromCapacity)} excluded from capacity`
        : "";
      const included = item.countsTowardSoldPercent ? "Yes" : "No";
      return `
        <tr>
          <td data-label="Code"><span class="code-pill">${escapeHtml(item.code)}</span></td>
          <td data-label="Meaning">${escapeHtml(item.label)}</td>
          <td data-label="Seats" class="numeric">${formatNumber.format(item.count)}</td>
          <td data-label="In sold %">${included}</td>
          <td data-label="Capacity note">${excluded}</td>
        </tr>
      `;
    })
    .join("");

  return `
    <table class="breakdown-table">
      <thead>
        <tr>
          <th>Code</th>
          <th>Meaning</th>
          <th>Seats</th>
          <th>In sold %</th>
          <th>Capacity note</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

sessionsEl.addEventListener("click", (event) => {
  const row = event.target.closest(".session-row");
  if (!row) return;

  const detailRow = document.querySelector(`#${row.dataset.detail}`);
  const button = row.querySelector(".expand-button");
  const isOpen = !detailRow.hidden;
  if (!isOpen) populateMobileDetails(detailRow);
  detailRow.hidden = isOpen;
  button.textContent = isOpen ? "+" : "-";
  button.setAttribute("aria-expanded", String(!isOpen));
  syncExpandAll();
});

bookmarkListEl.addEventListener("click", (event) => {
  const loadButton = event.target.closest(".bookmark-load");
  const removeButton = event.target.closest(".bookmark-remove");
  const items = savedBookmarks();

  if (loadButton) {
    const item = items[Number(loadButton.dataset.index)];
    if (!item) return;
    input.value = item.url;
    form.requestSubmit();
    return;
  }

  if (removeButton) {
    const index = Number(removeButton.dataset.index);
    if (!Number.isInteger(index)) return;
    items.splice(index, 1);
    if (!saveBookmarks(items)) return;
    renderBookmarks();
    updateBookmarkButton();
  }
});

saveBookmarkButton.addEventListener("click", saveCurrentBookmark);

postShowReportButton.addEventListener("click", () => {
  if (!currentEvent?.url) return;
  window.open(`/report.html?eventUrl=${encodeURIComponent(currentEvent.url)}`, "_blank", "noopener");
});
const historyChart = document.querySelector("#history-chart");
for (const canvas of [historyChart, performanceChart]) {
  canvas.addEventListener("pointermove", handleHistoryPointer);
  canvas.addEventListener("pointerdown", handleHistoryPointer);
  canvas.addEventListener("pointerleave", () => {
    canvas.style.cursor = "default";
    hideHistoryTooltip(canvas);
  });
}

performanceList.addEventListener("click", event => {
  const button = event.target.closest("button[data-index]");
  if (button) selectPerformance(Number(button.dataset.index));
});

async function analyse(event) {
  event.preventDefault();
  const value = input.value.trim();
  if (!value) {
    setStatus("Enter a TicketSearch event number or a TicketSearch or TryBooking link.", true);
    input.focus();
    return;
  }
  analysisController?.abort();
  historyController?.abort();
  const requestId = ++analysisRequest;
  analysisController = new AbortController();
  const controller = analysisController;
  const timeout = setTimeout(() => controller.abort(), 180000);
  isLoading = true;
  submitButton.disabled = true;
  saveBookmarkButton.disabled = true;
  document.querySelector("#export-csv").disabled = true;
  document.querySelector("#loading-state").hidden = false;
  document.querySelector("#welcome").hidden = true;
  document.querySelector("#dashboard").hidden = true;
  document.querySelector("#dashboard").setAttribute("aria-busy", "true");
  document.querySelector(".analyse-label").textContent = "Analysing…";
  closeMenu();
  setStatus("Checking ticket sales and seat availability…");

  try {
    const response = await fetch(`/api/analyse?input=${encodeURIComponent(value)}`, { signal: controller.signal });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Analysis failed.");
    }
    if (requestId !== analysisRequest) return;
    if (!data.summary || !Array.isArray(data.sessions)) throw new Error("The event returned incomplete sales data. Please try again.");
    render(data);
    const message = data.provider === "trybooking"
      ? "Analysis complete. TryBooking sell-through includes seats unavailable to buy; detailed hold codes are not public."
      : "Analysis complete. Your latest ticket sales and seat availability are ready.";
    setStatus(message);
    if (data.snapshotWarning) {
      setStatus(`${message} This analysis could not be saved to history.`, true);
    }
  } catch (error) {
    if (requestId !== analysisRequest) return;
    const message = error.name === "AbortError" ? "The event took too long to respond. Please try again." : error.message;
    setStatus(currentData ? `${message} Your previous analysis is still shown below.` : message, true);
    document.querySelector("#dashboard").hidden = !currentData;
    document.querySelector("#welcome").hidden = Boolean(currentData);
    if (currentData) loadHistory(currentData);
  } finally {
    clearTimeout(timeout);
    if (requestId !== analysisRequest) return;
    isLoading = false;
    submitButton.disabled = false;
    saveBookmarkButton.disabled = !currentEvent?.url;
    document.querySelector("#export-csv").disabled = !currentData;
    document.querySelector("#loading-state").hidden = true;
    document.querySelector("#dashboard").setAttribute("aria-busy", "false");
    document.querySelector(".analyse-label").textContent = "Analyse event";
    if (!historyEl.hidden) requestAnimationFrame(() => drawHistoryChart(visibleSnapshots));
  }
}

function filteredSessions() {
  if (!currentData) return [];
  const query = document.querySelector("#session-search").value.trim().toLowerCase();
  const filter = document.querySelector("#session-filter").value;
  const sort = document.querySelector("#session-sort").value;
  const sessions = currentData.sessions.map((session, index) => ({ session, index })).filter(({ session }) => {
    const when = session.dateTime ? new Date(session.dateTime) : null;
    const label = when ? `${formatDate.format(when)} ${formatTime.format(when)} ${session.dateTime}`.toLowerCase() : "";
    return (!query || label.includes(query)) && (filter !== "final" || session.isFinal) && (filter !== "upcoming" || (when && when.getTime() > Date.now()));
  });
  const numeric = { sold: "ticketsSold", available: "availableSeats", sellthrough: "effectiveSoldPercent" };
  return sessions.sort((a, b) => sort === "date" ? (new Date(a.session.dateTime || 0) - new Date(b.session.dateTime || 0)) : Number(b.session[numeric[sort]] || 0) - Number(a.session[numeric[sort]] || 0));
}

function applyPerformanceFilters() {
  if (!currentData) return;
  const visible = filteredSessions();
  const shown = new Set(visible.map(item => item.index));
  sessionsEl.querySelectorAll(".session-row").forEach(row => {
    row.hidden = !shown.has(Number(row.dataset.index));
    const detail = document.querySelector(`#${row.dataset.detail}`);
    if (row.hidden) {
      detail.hidden = true;
      row.querySelector("button").setAttribute("aria-expanded", "false");
      row.querySelector("button").textContent = "+";
    }
  });
  visible.forEach(({ index }) => {
    const row = sessionsEl.querySelector(`[data-index="${index}"]`);
    sessionsEl.append(row, document.querySelector(`#${row.dataset.detail}`));
  });
  performanceList.innerHTML = visible.map(({ session, index }) => {
    const when = session.dateTime ? new Date(session.dateTime) : null;
    const soldPercent = session.capacityUnknown || !(session.totalSeats > 0)
      ? "N/A"
      : percent(100 * session.ticketsSold / session.totalSeats);
    return `<li><button type="button" data-index="${index}" aria-controls="selected-performance" aria-pressed="false">
      <span class="performance-choice-date"><strong>${when ? formatDate.format(when) : "Date unavailable"}</strong>
      <span>${when ? formatTime.format(when) : ""}</span></span>
      <span class="performance-choice-percent">${soldPercent}<span class="sr-only"> sold</span></span>
    </button></li>`;
  }).join("");
  document.querySelector(".performance-workspace").hidden = !visible.length;
  if (visible.length) {
    const next = visible.find(({ index }) => index === selectedPerformance)
      || visible.find(({ session }) => session.dateTime && new Date(session.dateTime).getTime() > Date.now())
      || visible[0];
    selectPerformance(next.index);
  } else {
    selectedPerformance = null;
  }
  document.querySelector("#no-performances").hidden = visible.length > 0;
  setText("#results-count", `${visible.length} of ${currentData.sessions.length} performances`);
  document.querySelector("#expand-all").disabled = !visible.length;
  syncExpandAll();
}

function syncExpandAll() {
  const rows = [...sessionsEl.querySelectorAll(".session-row")].filter(row => !row.hidden);
  const allOpen = rows.length > 0 && rows.every(row => row.querySelector("button").getAttribute("aria-expanded") === "true");
  const button = document.querySelector("#expand-all");
  button.textContent = allOpen ? "Collapse all" : "Expand all";
  button.setAttribute("aria-expanded", String(allOpen));
}

function csvCell(value) {
  let text = String(value ?? "");
  if (typeof value === "string" && /^[\s]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function exportCsv() {
  if (!currentData || isLoading) return;
  const rows = [["Event", "Performance (Australia/Sydney)", "Tickets sold", "Capacity", "Unavailable", "Available", "Sold today", "Sell-through (%)", "Estimated revenue (AUD)", "Status"]];
  filteredSessions().forEach(({ session }) => rows.push([
    currentEvent.name, session.dateTime ? `${formatDate.format(new Date(session.dateTime))} ${formatTime.format(new Date(session.dateTime))}` : "",
    session.ticketsSold, session.capacityUnknown ? "Unknown" : session.totalSeats, session.unavailableSeats, session.availableSeats,
    session.salesSinceDailySnapshot, session.capacityUnknown ? "Unknown" : Number(session.effectiveSoldPercent).toFixed(1), session.revenueEstimate?.amount,
    session.isFinal ? "Final" : session.isHistoricalSnapshot ? "Last recorded" : "Current"
  ]));
  const url = URL.createObjectURL(new Blob(["\ufeff" + rows.map(row => row.map(csvCell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${currentEvent.name.replace(/[^a-z0-9 -]/gi, "").trim() || "theatre-sales"}-performances.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus(`Exported ${rows.length - 1} performances to CSV.`);
}

function closeMenu(returnFocus = false) {
  const sidebar = document.querySelector("#sidebar");
  if (!sidebar.classList.contains("open")) return;
  sidebar.classList.remove("open");
  document.querySelector("#menu-toggle").setAttribute("aria-expanded", "false");
  document.querySelector("#menu-toggle").setAttribute("aria-label", "Open navigation");
  if (returnFocus) document.querySelector("#menu-toggle").focus();
}

function focusEvent() {
  closeMenu();
  window.scrollTo({ top: 0, behavior: "instant" });
  input.focus();
  input.select();
}

document.querySelectorAll("[data-range]").forEach(button => button.addEventListener("click", () => {
  selectedRange = button.dataset.range;
  document.querySelectorAll("[data-range]").forEach(item => {
    item.classList.toggle("selected", item === button);
    item.setAttribute("aria-pressed", String(item === button));
  });
  renderHistory(historyData);
}));
document.querySelector("#session-search").addEventListener("input", applyPerformanceFilters);
document.querySelector("#session-filter").addEventListener("change", applyPerformanceFilters);
document.querySelector("#session-sort").addEventListener("change", applyPerformanceFilters);
document.querySelector("#expand-all").addEventListener("click", () => {
  const shouldOpen = document.querySelector("#expand-all").getAttribute("aria-expanded") !== "true";
  sessionsEl.querySelectorAll(".session-row").forEach(row => {
    if (row.hidden) return;
    const detail = document.querySelector(`#${row.dataset.detail}`);
    if (shouldOpen) populateMobileDetails(detail);
    detail.hidden = !shouldOpen;
    row.querySelector("button").setAttribute("aria-expanded", String(shouldOpen));
    row.querySelector("button").textContent = shouldOpen ? "−" : "+";
  });
  syncExpandAll();
});
document.querySelector("#export-csv").addEventListener("click", exportCsv);
document.querySelector("#new-event").addEventListener("click", focusEvent);
document.querySelector("#focus-event").addEventListener("click", focusEvent);
document.querySelector("#menu-toggle").addEventListener("click", () => {
  const open = document.querySelector("#sidebar").classList.toggle("open");
  document.querySelector("#menu-toggle").setAttribute("aria-expanded", String(open));
  document.querySelector("#menu-toggle").setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
  if (open) document.querySelector("#sidebar .brand").focus();
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape") closeMenu(true);
});
document.addEventListener("click", event => {
  if (!event.target.closest("#sidebar, #menu-toggle")) closeMenu();
});
let resizeFrame;
const chartResizeObserver = new ResizeObserver(() => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    drawHistoryChart(visibleSnapshots);
    drawHistoryChart(performanceSnapshots, performanceChart);
  });
});
chartResizeObserver.observe(historyChart.parentElement);
chartResizeObserver.observe(performanceChart.parentElement);

form.addEventListener("submit", analyse);
renderBookmarks();
const linkedEvent = new URLSearchParams(location.search).get("event");
if (linkedEvent) {
  input.value = linkedEvent;
  form.requestSubmit();
}
