const reportEl = document.querySelector("#report");
const statusEl = document.querySelector("#report-status");
const number = new Intl.NumberFormat("en-AU");
const money = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });
const dateFormat = new Intl.DateTimeFormat("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "Australia/Sydney" });
const timeFormat = new Intl.DateTimeFormat("en-AU", { hour: "numeric", minute: "2-digit", timeZone: "Australia/Sydney" });

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function percentage(value) { return `${Number(value || 0).toFixed(1)}%`; }

function chart(points, className = "sales-chart") {
  if (!points.length) return '<p class="empty">No stored sales snapshots.</p>';
  const width = 680;
  const height = 180;
  const pad = { left: 44, right: 18, top: 18, bottom: 30 };
  const values = points.map((point) => Number(point.effectiveSold ?? point.effective_sold ?? 0));
  const min = Math.max(0, Math.floor(Math.min(...values) / 10) * 10 - 10);
  const max = Math.max(min + 1, Math.ceil(Math.max(...values) / 10) * 10 + 10);
  const x = (index) => pad.left + (points.length === 1 ? (width - pad.left - pad.right) / 2 : index * (width - pad.left - pad.right) / (points.length - 1));
  const y = (value) => pad.top + (height - pad.top - pad.bottom) * (1 - (value - min) / (max - min));
  const path = points.map((point, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(values[index]).toFixed(1)}`).join(" ");
  const ticks = Array.from({ length: 4 }, (_, index) => min + (max - min) * index / 3);
  const grid = ticks.map((tick) => `<g><line x1="${pad.left}" x2="${width - pad.right}" y1="${y(tick)}" y2="${y(tick)}"/><text x="${pad.left - 8}" y="${y(tick) + 4}">${number.format(Math.round(tick))}</text></g>`).join("");
  const circles = points.map((point, index) => `<circle cx="${x(index)}" cy="${y(values[index])}" r="3.5"><title>${new Date(point.capturedAt || point.captured_at).toLocaleString("en-AU", { timeZone: "Australia/Sydney" })}: ${number.format(values[index])} sold</title></circle>`).join("");
  const first = new Date(points[0].capturedAt || points[0].captured_at);
  const last = new Date(points[points.length - 1].capturedAt || points[points.length - 1].captured_at);
  return `<svg class="${className}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Sales over time"><g class="grid">${grid}</g><path class="line" d="${path}"/>${circles}<text class="x-label" x="${pad.left}" y="${height - 8}">${dateFormat.format(first)}</text><text class="x-label right" x="${width - pad.right}" y="${height - 8}">${dateFormat.format(last)}</text></svg>`;
}

function seatMap(map) {
  if (!map?.seats?.length) return "";
  const seats = map.seats.map((seat) => `<span class="seat ${escapeHtml(seat.status || "available")}" title="${escapeHtml(`${seat.row || ""} ${seat.seatNumber || ""}`)}"></span>`).join("");
  return `<div class="seat-map"><strong>Final seat map</strong><div class="seat-grid" style="--columns:${Math.max(16, Math.min(32, map.columns || 24))}">${seats}</div><div class="legend"><span><i class="available"></i> Available</span><span><i class="sold"></i> Sold</span><span><i class="hold"></i> Unavailable</span><span><i class="excluded"></i> Hidden/kill</span></div></div>`;
}

function sessionCard(session, histories) {
  const when = new Date(session.dateTime);
  const revenue = session.revenueEstimate?.amount;
  const history = histories[String(session.scheduleId)] || [];
  return `<article class="performance-card">
    <header><div><h3>${dateFormat.format(when)}</h3><p>${timeFormat.format(when)} - final numbers</p></div><strong>${percentage(session.effectiveSoldPercent)} sold</strong></header>
    <div class="performance-stats"><span><b>${number.format(session.ticketsSold)}</b> sold</span><span><b>${number.format(session.totalSeats)}</b> capacity</span><span><b>${number.format(session.availableSeats)}</b> left</span><span><b>${revenue == null ? "-" : money.format(revenue)}</b> est. revenue</span></div>
    ${chart(history, "performance-chart")}
    ${seatMap(session.seatMap)}
  </article>`;
}

function engagementValue(value) { return value == null ? "-" : number.format(value); }

function campaignSection(analysis) {
  if (!analysis?.posts?.length) return "";
  const postAverage = analysis.postNextDayAverage == null ? "-" : `+${number.format(analysis.postNextDayAverage)}`;
  const nonPostAverage = analysis.nonPostNextDayAverage == null ? "-" : `+${number.format(analysis.nonPostNextDayAverage)}`;
  const cards = analysis.posts.map((post) => {
    const postDate = new Date(`${post.date}T12:00:00+10:00`);
    const change = post.nextDayTicketChange == null ? "-" : `${post.nextDayTicketChange >= 0 ? "+" : ""}${number.format(post.nextDayTicketChange)}`;
    return `<article class="campaign-card"><img src="${escapeHtml(post.screenshot)}" alt="Facebook post from ${escapeHtml(post.date)}"><div><h3>${dateFormat.format(postDate)}</h3><p>${escapeHtml(post.type === "video" ? "Facebook video" : "Facebook post")}</p><dl><div><dt>Reactions</dt><dd>${engagementValue(post.reactions)}</dd></div><div><dt>Comments</dt><dd>${engagementValue(post.comments)}</dd></div><div><dt>Shares</dt><dd>${engagementValue(post.shares)}</dd></div><div><dt>Next-day sales</dt><dd>${change}</dd></div></dl><a href="${escapeHtml(post.url)}" target="_blank" rel="noreferrer">View post</a></div></article>`;
  }).join("");
  return `<section class="report-section campaign"><h2>${escapeHtml(analysis.title)}</h2><p class="subtle">Facebook activity supplied by the company. Ticket response is the change between the scheduled snapshots on the post date and the following day. This shows association, not proof that a post caused sales.</p><div class="campaign-summary"><span><b>${number.format(analysis.posts.length)}</b> posts</span><span><b>${postAverage}</b> average next-day sales after a post</span><span><b>${nonPostAverage}</b> average on non-post days</span></div><p class="subtle">Engagement figures were captured from publicly visible Facebook cards on ${escapeHtml(analysis.engagementCapturedAt || "")}. A dash means Facebook did not expose a reliable count in the captured card.</p><div class="campaign-grid">${cards}</div></section>`;
}

function render(data) {
  const event = data.event || {};
  const summary = data.summary || {};
  const image = event.image_url ? `<img class="hero-image" src="${escapeHtml(event.image_url)}" alt="">` : "";
  reportEl.innerHTML = `
    <div class="report-actions no-print"><button id="print-report" type="button">Print / Save PDF</button></div>
    <section class="cover">${image}<div class="cover-copy"><p class="eyebrow">Post-show analysis</p><h1>${escapeHtml(event.event_name || "Theatre report")}</h1><p>${escapeHtml(event.venue || event.location || "")}</p><p>Final report generated ${new Date().toLocaleDateString("en-AU")}</p></div></section>
    <section class="overview"><div class="ring"><b>${percentage(summary.effectiveSoldPercent)}</b><span>sold</span></div><div class="overview-copy"><h2>Run summary</h2><div class="summary-grid"><span><b>${number.format(summary.performances)}</b> Performances</span><span><b>${number.format(summary.totalSeats)}</b> Saleable seats</span><span><b>${number.format(summary.ticketsSold)}</b> Tickets sold</span><span><b>${money.format(summary.revenueEstimate?.amount || 0)}</b> Est. revenue</span></div></div></section>
    <section class="report-section"><h2>Sales across the run</h2><p class="subtle">Effective sold seats at each daily scheduled snapshot. Completed performances remain included in the run total.</p>${chart(data.dailySnapshots || [])}</section>
    ${campaignSection(data.campaignAnalysis)}
    <section class="report-section"><h2>Performance final results</h2><div class="final-table"><div class="table-head"><span>Date</span><span>Time</span><span>Sold</span><span>Capacity</span><span>Sold %</span><span>Revenue</span></div>${(data.performances || []).map((session) => { const when = new Date(session.dateTime); return `<div class="table-row"><span>${dateFormat.format(when)}</span><span>${timeFormat.format(when)}</span><span>${number.format(session.ticketsSold)}</span><span>${number.format(session.totalSeats)}</span><span>${percentage(session.effectiveSoldPercent)}</span><span>${session.revenueEstimate?.amount == null ? "-" : money.format(session.revenueEstimate.amount)}</span></div>`; }).join("")}</div></section>
    <section class="report-section performances"><h2>Performance detail</h2>${(data.performances || []).map((session) => sessionCard(session, data.performanceHistory || {})).join("")}</section>
    <footer>Final figures are taken from the stored final pre-show snapshot or retired TicketSearch schedule snapshot. Revenue is an estimate from public ticket price levels and excludes holds.</footer>`;
  document.querySelector("#print-report").addEventListener("click", () => window.print());
}

async function load() {
  const eventUrl = new URLSearchParams(location.search).get("eventUrl");
  if (!eventUrl) { statusEl.textContent = "No event URL was provided."; return; }
  try {
    const response = await fetch(`/api/report?eventUrl=${encodeURIComponent(eventUrl)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Unable to build report.");
    render(data);
  } catch (error) { statusEl.textContent = error.message; }
}

document.querySelector("#print-report").addEventListener("click", () => window.print());
load();
