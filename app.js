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
const BOOKMARK_STORAGE_KEY = "theatreSeatSales.savedShows";
const MAX_BOOKMARKS = 5;
let currentEvent = null;

const formatNumber = new Intl.NumberFormat("en-AU");
const formatDate = new Intl.DateTimeFormat("en-AU", {
  weekday: "short",
  day: "2-digit",
  month: "short",
  year: "numeric",
});
const formatTime = new Intl.DateTimeFormat("en-AU", {
  hour: "numeric",
  minute: "2-digit",
});
const formatShortDate = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  month: "short",
  year: "numeric",
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

  if (!items.length) {
    bookmarkListEl.innerHTML = `<p class="empty-bookmarks">Save up to ${MAX_BOOKMARKS} shows after analysing them.</p>`;
    return;
  }

  items.forEach((item, index) => {
    const wrapper = document.createElement("div");
    wrapper.className = "bookmark-item";
    wrapper.innerHTML = `
      <button class="bookmark-load" type="button" data-index="${index}">${escapeHtml(item.name)}</button>
      <button class="bookmark-remove" type="button" data-index="${index}" aria-label="Remove ${escapeHtml(item.name)}">Remove</button>
    `;
    bookmarkListEl.appendChild(wrapper);
  });
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
  setStatus(`Saved ${currentEvent.name}`);
}

function signedNumber(value) {
  if (value === null || value === undefined) return "-";
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${formatNumber.format(value)}`;
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

  setText("#event-name", data.eventName || `Event ${data.eventId}`);
  setText("#event-location", data.venue || data.location || "Location not supplied");
  setText("#event-dates", formatDateRange(data.dateRange));
  setText("#overall-percent", percent(summary.effectiveSoldPercent));
  document.querySelector("#overall-ring").style.setProperty("--sold", `${Math.min(summary.effectiveSoldPercent, 100)}%`);
  setText("#metric-performances", formatNumber.format(summary.performances));
  setText("#metric-total", formatNumber.format(summary.totalSeats));
  setText("#metric-sold", formatNumber.format(summary.ticketsSold));
  setText("#metric-unavailable", formatNumber.format(summary.unavailableSeats));
  setText("#metric-left", formatNumber.format(summary.availableSeats));

  sessionsEl.innerHTML = "";
  data.sessions.forEach((session, index) => {
    const when = session.dateTime ? new Date(session.dateTime) : null;
    const row = document.createElement("tr");
    row.className = "session-row";
    row.dataset.detail = `detail-${index}`;
    row.innerHTML = `
      <td><button class="expand-button" type="button" aria-expanded="false" aria-controls="detail-${index}">+</button></td>
      <td data-label="Date">${when ? formatDate.format(when) : ""}</td>
      <td data-label="Time">${when ? formatTime.format(when) : ""}</td>
      <td data-label="Sold">${formatNumber.format(session.ticketsSold)} / ${formatNumber.format(session.totalSeats)}</td>
      <td data-label="Unavailable">${formatNumber.format(session.unavailableSeats)}</td>
      <td data-label="Available">${formatNumber.format(session.availableSeats)}</td>
      <td data-label="% sold">
        <div class="bar">
          <span>${percent(session.effectiveSoldPercent)}</span>
          <span class="track"><span class="fill" style="width: ${progressWidth(session.effectiveSoldPercent)}%"></span></span>
        </div>
      </td>
    `;
    sessionsEl.appendChild(row);

    const detailRow = document.createElement("tr");
    detailRow.id = `detail-${index}`;
    detailRow.className = "detail-row";
    detailRow.hidden = true;
    detailRow.innerHTML = `
      <td colspan="7">
        <div class="detail-panel">
          <div class="detail-summary">
            <strong>Seat status detail</strong>
            <span>${formatNumber.format(session.ticketsSold)} sold</span>
            <span>${formatNumber.format(session.effectiveSoldSeats)} counted in sold %</span>
            <span>${formatNumber.format(session.unavailableSeats)} unavailable but not sold</span>
            <span>${formatNumber.format(session.availableSeats)} available to buy</span>
          </div>
          ${renderBreakdown(session.breakdown)}
        </div>
      </td>
    `;
    sessionsEl.appendChild(detailRow);
  });

  summaryEl.hidden = false;
  resultsEl.hidden = false;
  loadHistory(data.eventId);
}

async function loadHistory(eventId) {
  historyEl.hidden = true;
  try {
    const response = await fetch(`/api/history?eventId=${encodeURIComponent(eventId)}`);
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
    ? "1 snapshot collected. Uplift appears after daily snapshots run."
    : `${formatNumber.format(snapshots.length)} snapshots collected.`;
  setText("#uplift-day", signedNumber(history.uplift?.day?.effectiveSoldChange));
  setText("#uplift-week", signedNumber(history.uplift?.week?.effectiveSoldChange));
  if (latest) {
    historyStatusEl.textContent += ` Latest effective sold: ${formatNumber.format(latest.effective_sold)}.`;
  }
  drawHistoryChart(snapshots);
}

function drawHistoryChart(snapshots) {
  const canvas = document.querySelector("#history-chart");
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);

  const padding = { top: 22, right: 28, bottom: 44, left: 68 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  ctx.strokeStyle = "#dfe6eb";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padding.left, padding.top);
  ctx.lineTo(padding.left, padding.top + plotHeight);
  ctx.lineTo(padding.left + plotWidth, padding.top + plotHeight);
  ctx.stroke();

  if (!snapshots.length) {
    ctx.fillStyle = "#66737b";
    ctx.font = "18px Segoe UI, Arial";
    ctx.fillText("No snapshots yet", padding.left + 16, padding.top + 44);
    return;
  }

  const values = snapshots.map((item) => Number(item.effective_sold || 0));
  const maxValue = Math.max(...values, 1);
  const minValue = Math.min(...values, 0);
  const range = Math.max(maxValue - minValue, 1);
  const pointX = (index) => padding.left + (snapshots.length === 1 ? plotWidth : (index / (snapshots.length - 1)) * plotWidth);
  const pointY = (value) => padding.top + plotHeight - ((value - minValue) / range) * plotHeight;

  ctx.fillStyle = "#66737b";
  ctx.font = "13px Segoe UI, Arial";
  ctx.fillText(formatNumber.format(maxValue), 10, padding.top + 8);
  ctx.fillText(formatNumber.format(minValue), 10, padding.top + plotHeight);

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
    ctx.fillStyle = "#071f3d";
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
  });

  const firstDate = new Date(snapshots[0].captured_at);
  const lastDate = new Date(snapshots[snapshots.length - 1].captured_at);
  ctx.fillStyle = "#66737b";
  ctx.font = "13px Segoe UI, Arial";
  ctx.fillText(formatShortDate.format(firstDate), padding.left, height - 15);
  ctx.textAlign = "right";
  ctx.fillText(formatShortDate.format(lastDate), padding.left + plotWidth, height - 15);
  ctx.textAlign = "left";
}

function renderBreakdown(breakdown = []) {
  if (!breakdown.length) {
    return `<p class="empty-detail">No detailed seat-map codes were returned for this session.</p>`;
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
  }
});

saveBookmarkButton.addEventListener("click", saveCurrentBookmark);

async function analyse(event) {
  event.preventDefault();
  submitButton.disabled = true;
  summaryEl.hidden = true;
  historyEl.hidden = true;
  resultsEl.hidden = true;
  setStatus("Analysing TicketSearch sessions...");

  try {
    const response = await fetch(`/api/analyse?input=${encodeURIComponent(input.value)}`);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Analysis failed.");
    }
    render(data);
    setStatus("Analysis complete. Sold % includes actual sold seats and mapped sold-equivalent hold codes.");
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    submitButton.disabled = false;
  }
}

form.addEventListener("submit", analyse);
renderBookmarks();
