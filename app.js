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
const historyTooltipEl = document.querySelector("#history-tooltip");
const BOOKMARK_STORAGE_KEY = "theatreSeatSales.savedShows";
const MAX_BOOKMARKS = 8;
let currentEvent = null;
let chartPoints = [];

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
    return Array.isArray(parsed) ? parsed.slice(0, MAX_BOOKMARKS) : [];
  } catch (error) {
    return [];
  }
}

function saveBookmarks(items) {
  localStorage.setItem(BOOKMARK_STORAGE_KEY, JSON.stringify(items.slice(0, MAX_BOOKMARKS)));
}

function bookmarkKey(value) {
  return String(value || "").trim().toLowerCase();
}

function renderBookmarks() {
  const items = savedBookmarks();
  bookmarksEl.hidden = false;
  bookmarkListEl.innerHTML = "";
  updateBookmarkButton();

  if (!items.length) {
    bookmarkListEl.innerHTML = `<p class="empty-bookmarks">Save up to ${MAX_BOOKMARKS} shows after analysing them.</p>`;
    return;
  }

  items.forEach((item, index) => {
    const wrapper = document.createElement("div");
    wrapper.className = "bookmark-item";
    wrapper.innerHTML = `
      <button class="bookmark-load" type="button" data-index="${index}">${escapeHtml(item.name)}</button>
      <button class="bookmark-remove" type="button" data-index="${index}" aria-label="Remove ${escapeHtml(item.name)}">x</button>
    `;
    bookmarkListEl.appendChild(wrapper);
  });
}

function updateBookmarkButton() {
  const items = savedBookmarks();
  const isSaved = currentEvent && items.some((item) => bookmarkKey(item.url) === bookmarkKey(currentEvent.url));
  saveBookmarkButton.textContent = isSaved ? "\u2605" : "\u2606";
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
  }

  items.unshift(nextItem);
  saveBookmarks(items);
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
  if (!session.isFinal) return "";
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
  if (start.toDateString() === end.toDateString()) {
    return formatShortDate.format(start);
  }
  return `${formatShortDate.format(start)} to ${formatShortDate.format(end)}`;
}

function render(data) {
  const summary = data.summary;
  const image = document.querySelector("#event-image");
  image.src = data.imageUrl || "";
  image.alt = data.eventName || "Event image";
  currentEvent = {
    name: data.eventName || `Event ${data.eventId}`,
    url: data.eventUrl || input.value.trim(),
  };
  saveBookmarkButton.disabled = !currentEvent.url;
  updateBookmarkButton();

  setText("#event-name", data.eventName || `Event ${data.eventId}`);
  setText("#event-location", data.venue || data.location || "Location not supplied");
  setText("#event-dates", formatDateRange(data.dateRange));
  setText("#overall-percent", summary.capacityUnknown ? "N/A" : percent(summary.effectiveSoldPercent));
  document.querySelector("#overall-ring").style.setProperty("--sold", `${summary.capacityUnknown ? 0 : Math.min(summary.effectiveSoldPercent, 100)}%`);
  setText("#overall-sold-today", dailyDeltaLabel(summary.salesSinceDailySnapshot));
  document.querySelector("#overall-sold-today").title = baselineLabel(summary.dailySnapshotCapturedAt);
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
    row.innerHTML = `
      <td><button class="expand-button" type="button" aria-expanded="false" aria-controls="detail-${index}">+</button></td>
      <td data-label="Date"><span>${when ? formatDate.format(when) : ""}</span>${finalNumbersBadge(session)}</td>
      <td data-label="Time">${when ? formatTime.format(when) : ""}</td>
      <td data-label="Sold">${soldCellLabel(session)}</td>
      <td data-label="Unavailable">${formatNumber.format(session.unavailableSeats)}</td>
      <td data-label="Available">${formatNumber.format(session.availableSeats)}</td>
      <td data-label="Sold today" title="${escapeHtml(baselineLabel(session.dailySnapshotCapturedAt))}">
        <span class="delta-value">${dailyDeltaLabel(session.salesSinceDailySnapshot)}</span>
      </td>
      <td data-label="% sold">
        <div class="bar">
          <span>${percentCellLabel(session)}</span>
          <span class="track"><span class="fill" style="width: ${session.capacityUnknown ? 0 : progressWidth(session.effectiveSoldPercent)}%"></span></span>
        </div>
      </td>
    `;
    sessionsEl.appendChild(row);

    const detailRow = document.createElement("tr");
    detailRow.id = `detail-${index}`;
    detailRow.className = "detail-row";
    detailRow.hidden = true;
    detailRow.innerHTML = `
      <td colspan="8">
        <div class="detail-panel">
          <div class="detail-summary">
            <strong>Seat status detail</strong>
            <span>${formatNumber.format(session.ticketsSold)} sold</span>
            <span>${formatNumber.format(session.effectiveSoldSeats)} counted in sold %</span>
            <span>${formatNumber.format(session.unavailableSeats)} unavailable but not sold</span>
            <span>${formatNumber.format(session.availableSeats)} available to buy</span>
            ${session.capacityUnknown ? `<span>${escapeHtml(session.statusLabel || "Capacity unknown")}</span>` : ""}
            <span>${dailyDeltaLabel(session.salesSinceDailySnapshot)} sold today</span>
            <span title="${escapeHtml(session.revenueEstimate?.basis || "Estimated ticket revenue")}">${revenueLabel(session.revenueEstimate)} est. revenue</span>
            ${session.isFinal ? `<span class="final-note">${finalNumbersBadge(session)}</span>` : ""}
          </div>
          ${renderSeatMap(session.seatMap)}
          ${renderBreakdown(session.breakdown)}
        </div>
      </td>
    `;
    sessionsEl.appendChild(detailRow);
  });

  summaryEl.hidden = false;
  resultsEl.hidden = false;
  loadHistory(data);
}

async function loadHistory(data) {
  historyEl.hidden = true;
  try {
    const historyUrl = data.eventUrl
      ? `/api/history?eventUrl=${encodeURIComponent(data.eventUrl)}`
      : `/api/history?eventId=${encodeURIComponent(data.eventId)}`;
    const response = await fetch(historyUrl);
    const history = await response.json();
    if (!response.ok) {
      throw new Error(history.error || "No history found.");
    }
    renderHistory(history);
    historyEl.hidden = false;
  } catch (error) {
    historyStatusEl.textContent = "Sales history will appear after snapshots are collected.";
    setText("#uplift-day", "-");
    setText("#uplift-week", "-");
    drawHistoryChart([]);
    historyEl.hidden = false;
  }
}

function renderHistory(history) {
  const snapshots = history.snapshots || [];
  const latest = snapshots[snapshots.length - 1];
  historyStatusEl.textContent = snapshots.length === 1
    ? "1 daily snapshot collected. Uplift appears after the next scheduled snapshot."
    : `${formatNumber.format(snapshots.length)} daily snapshots collected.`;
  setText("#uplift-day", signedNumber(history.uplift?.day?.effectiveSoldChange));
  setText("#uplift-week", signedNumber(history.uplift?.week?.effectiveSoldChange));
  if (latest) {
    historyStatusEl.textContent += ` Latest effective sold: ${formatNumber.format(latest.effective_sold)}.`;
  }
  drawHistoryChart(snapshots);
}

function chartDate(snapshot) {
  if (snapshot.local_date) {
    return new Date(`${snapshot.local_date}T12:00:00`);
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

function drawHistoryChart(snapshots) {
  const canvas = document.querySelector("#history-chart");
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  chartPoints = [];
  hideHistoryTooltip();
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);

  const padding = { top: 22, right: 30, bottom: 48, left: 76 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  if (!snapshots.length) {
    ctx.fillStyle = "#66737b";
    ctx.font = "18px Segoe UI, Arial";
    ctx.fillText("No snapshots yet", padding.left + 16, padding.top + 44);
    return;
  }

  const values = snapshots.map((item) => Number(item.effective_sold || 0));
  const ticks = niceTicks(Math.min(...values, 0), Math.max(...values, 1), 5);
  const minValue = ticks[0];
  const maxValue = ticks[ticks.length - 1];
  const range = Math.max(maxValue - minValue, 1);
  const pointX = (index) => padding.left + (snapshots.length === 1 ? plotWidth : (index / (snapshots.length - 1)) * plotWidth);
  const pointY = (value) => padding.top + plotHeight - ((value - minValue) / range) * plotHeight;

  ctx.strokeStyle = "#e8edf1";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#66737b";
  ctx.font = "13px Segoe UI, Arial";
  ctx.textAlign = "right";
  ticks.forEach((tick) => {
    const y = pointY(tick);
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + plotWidth, y);
    ctx.stroke();
    ctx.fillText(formatNumber.format(tick), padding.left - 10, y + 4);
  });

  const labelCount = Math.min(snapshots.length, width < 700 ? 4 : 6);
  const xLabelIndices = labelCount <= 1
    ? [0]
    : Array.from({ length: labelCount }, (_, index) => Math.round(index * (snapshots.length - 1) / (labelCount - 1)))
        .filter((value, index, list) => list.indexOf(value) === index);

  ctx.strokeStyle = "#f0f3f6";
  ctx.fillStyle = "#66737b";
  ctx.textAlign = "center";
  xLabelIndices.forEach((index) => {
    const x = pointX(index);
    ctx.beginPath();
    ctx.moveTo(x, padding.top);
    ctx.lineTo(x, padding.top + plotHeight);
    ctx.stroke();
    ctx.fillText(formatShortDate.format(chartDate(snapshots[index])), x, height - 16);
  });

  ctx.strokeStyle = "#cfd9e1";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padding.left, padding.top);
  ctx.lineTo(padding.left, padding.top + plotHeight);
  ctx.lineTo(padding.left + plotWidth, padding.top + plotHeight);
  ctx.stroke();

  ctx.strokeStyle = "#071f3d";
  ctx.lineWidth = 4;
  ctx.beginPath();
  values.forEach((value, index) => {
    const x = pointX(index);
    const y = pointY(value);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  values.forEach((value, index) => {
    const x = pointX(index);
    const y = pointY(value);
    chartPoints.push({
      x,
      y,
      value,
      capturedAt: snapshots[index].captured_at,
    });
    ctx.fillStyle = "#071f3d";
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.textAlign = "left";
}

function hideHistoryTooltip() {
  if (historyTooltipEl) {
    historyTooltipEl.hidden = true;
  }
}

function showHistoryTooltip(point, clientX) {
  if (!historyTooltipEl) return;

  const canvas = document.querySelector("#history-chart");
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
    <span>${formatNumber.format(point.value)} effective sold</span>
  `;
  historyTooltipEl.hidden = false;
  historyTooltipEl.style.left = `${pointLeft}px`;
  historyTooltipEl.style.top = `${pointTop}px`;
  historyTooltipEl.style.transform = alignRight
    ? "translate(calc(-100% - 12px), -50%)"
    : "translate(12px, -50%)";
}

function handleHistoryPointer(event) {
  if (!chartPoints.length) {
    hideHistoryTooltip();
    return;
  }

  const canvas = document.querySelector("#history-chart");
  const rect = canvas.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
  const y = ((event.clientY - rect.top) / rect.height) * canvas.height;
  const hitRadius = event.pointerType === "touch" ? 30 : 18;
  const nearest = chartPoints
    .map((point) => ({
      point,
      distance: Math.hypot(point.x - x, point.y - y),
    }))
    .sort((a, b) => a.distance - b.distance)[0];

  if (!nearest || nearest.distance > hitRadius) {
    hideHistoryTooltip();
    canvas.style.cursor = "default";
    return;
  }

  canvas.style.cursor = "pointer";
  showHistoryTooltip(nearest.point, event.clientX);
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
  detailRow.hidden = isOpen;
  button.textContent = isOpen ? "+" : "-";
  button.setAttribute("aria-expanded", String(!isOpen));
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
    saveBookmarks(items);
    renderBookmarks();
    updateBookmarkButton();
  }
});

saveBookmarkButton.addEventListener("click", saveCurrentBookmark);
const historyChart = document.querySelector("#history-chart");
historyChart.addEventListener("pointermove", handleHistoryPointer);
historyChart.addEventListener("pointerdown", handleHistoryPointer);
historyChart.addEventListener("pointerleave", () => {
  historyChart.style.cursor = "default";
  hideHistoryTooltip();
});

async function analyse(event) {
  event.preventDefault();
  currentEvent = null;
  submitButton.disabled = true;
  saveBookmarkButton.disabled = true;
  updateBookmarkButton();
  summaryEl.hidden = true;
  historyEl.hidden = true;
  resultsEl.hidden = true;
  setStatus("Analysing sessions...");

  try {
    const response = await fetch(`/api/analyse?input=${encodeURIComponent(input.value)}`);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Analysis failed.");
    }
    render(data);
    const message = data.provider === "trybooking"
      ? "Analysis complete. TryBooking sold % uses seats not currently available to buy because detailed hold codes are not public."
      : "Analysis complete. Sold % includes actual sold seats and mapped sold-equivalent hold codes.";
    setStatus(message);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    submitButton.disabled = false;
    saveBookmarkButton.disabled = !currentEvent?.url;
  }
}

form.addEventListener("submit", analyse);
renderBookmarks();
