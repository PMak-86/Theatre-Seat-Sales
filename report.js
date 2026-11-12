const reportEl = document.querySelector("#report");
const statusEl = document.querySelector("#report-status");
const number = new Intl.NumberFormat("en-AU");
const money = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });
const dateFormat = new Intl.DateTimeFormat("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "Australia/Sydney" });
const timeFormat = new Intl.DateTimeFormat("en-AU", { hour: "numeric", minute: "2-digit", timeZone: "Australia/Sydney" });
const chartDateFormat = new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "numeric", timeZone: "Australia/Sydney" });

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function percentage(value) { return `${Number(value || 0).toFixed(1)}%`; }

function chart(points, className = "sales-chart", markers = []) {
  if (!points.length) return '<p class="empty">No stored sales snapshots.</p>';
  const width = 680;
  const height = 196;
  const pad = { left: 44, right: 18, top: 18, bottom: 48 };
  const values = points.map((point) => Number(point.actualSold ?? point.actual_sold ?? 0));
  const validMarkers = markers.filter((marker) => marker.capturedAt && Number.isFinite(new Date(marker.capturedAt).getTime()));
  const min = Math.max(0, Math.floor(Math.min(...values) / 10) * 10 - 10);
  const max = Math.max(min + 1, Math.ceil(Math.max(...values) / 10) * 10 + 10);
  const timestamps = points.map((point) => new Date(point.capturedAt || point.captured_at).getTime());
  const markerTimes = validMarkers.map((marker) => new Date(marker.capturedAt).getTime());
  const startTime = Math.min(...timestamps, ...markerTimes);
  const endTime = Math.max(...timestamps, ...markerTimes);
  const x = (timestamp) => pad.left + (startTime === endTime
    ? (width - pad.left - pad.right) / 2
    : (timestamp - startTime) * (width - pad.left - pad.right) / (endTime - startTime));
  const y = (value) => pad.top + (height - pad.top - pad.bottom) * (1 - (value - min) / (max - min));
  const cumulativeValueAt = (timestamp) => {
    if (timestamp <= timestamps[0]) return values[0];
    if (timestamp >= timestamps[timestamps.length - 1]) return values[values.length - 1];
    const nextIndex = timestamps.findIndex((pointTime) => pointTime >= timestamp);
    const previousIndex = Math.max(0, nextIndex - 1);
    const span = timestamps[nextIndex] - timestamps[previousIndex];
    if (!span) return values[previousIndex];
    const progress = (timestamp - timestamps[previousIndex]) / span;
    return values[previousIndex] + ((values[nextIndex] - values[previousIndex]) * progress);
  };
  const path = points.map((point, index) => `${index ? "L" : "M"}${x(timestamps[index]).toFixed(1)},${y(values[index]).toFixed(1)}`).join(" ");
  const ticks = Array.from({ length: 4 }, (_, index) => min + (max - min) * index / 3);
  const grid = ticks.map((tick) => `<g><line x1="${pad.left}" x2="${width - pad.right}" y1="${y(tick)}" y2="${y(tick)}"/><text x="${pad.left - 8}" y="${y(tick) + 4}">${number.format(Math.round(tick))}</text></g>`).join("");
  const circles = points.map((point, index) => `<circle cx="${x(timestamps[index])}" cy="${y(values[index])}" r="3.5"><title>${new Date(point.capturedAt || point.captured_at).toLocaleString("en-AU", { timeZone: "Australia/Sydney" })}: ${number.format(values[index])} sold</title></circle>`).join("");
  const markerCircles = validMarkers.map((marker) => {
    const timestamp = new Date(marker.capturedAt).getTime();
    const cumulativeSold = cumulativeValueAt(timestamp);
    return `<circle class="final-marker" cx="${x(timestamp)}" cy="${y(cumulativeSold)}" r="5"><title>Performance final snapshot: ${new Date(marker.capturedAt).toLocaleString("en-AU", { timeZone: "Australia/Sydney" }).replace(",", "")}. Cumulative run sales: ${number.format(Math.round(cumulativeSold))}</title></circle>`;
  }).join("");
  const labelCount = Math.min(5, points.length);
  const labelIndexes = labelCount === 1 ? [0] : Array.from({ length: labelCount }, (_, index) => Math.round(index * (points.length - 1) / (labelCount - 1))).filter((index, position, all) => all.indexOf(index) === position);
  const xLabels = labelIndexes.map((index) => {
    const pointDate = new Date(points[index].capturedAt || points[index].captured_at);
    const anchor = index === 0 ? "" : index === labelIndexes[labelIndexes.length - 1] ? " right" : " middle";
    return `<text class="x-label${anchor}" x="${x(timestamps[index])}" y="${height - 22}">${chartDateFormat.format(pointDate)}</text>`;
  }).join("");
  const legend = validMarkers.length ? `<text class="chart-legend" x="44" y="${height - 4}">Red = performance final snapshot</text>` : "";
  return `<svg class="${className}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Sales over time">${legend}<g class="grid">${grid}</g><path class="line" d="${path}"/>${circles}${markerCircles}${xLabels}</svg>`;
}

function seatMap(map) {
  if (!map?.seats?.length) return "";
  if (map.type === "laycock-main") return laycockSeatMap(map);
  const seats = map.seats.map((seat) => `<span class="seat ${escapeHtml(seat.status || "available")}" title="${escapeHtml(`${seat.row || ""} ${seat.seatNumber || ""}`)}"></span>`).join("");
  return `<div class="seat-map"><strong>Final seat map</strong><div class="seat-grid" style="--columns:${Math.max(16, Math.min(32, map.columns || 24))}">${seats}</div><div class="legend"><span><i class="available"></i> Available</span><span><i class="sold"></i> Sold</span><span><i class="hold"></i> Unavailable</span><span><i class="excluded"></i> Hidden/kill</span></div></div>`;
}

function mapLegend(map) {
  return (map.legend || []).map((item) => `<span><i class="${escapeHtml(item.status)}"></i>${escapeHtml(item.label)}</span>`).join("");
}

function laycockSeatMap(map) {
  const byPosition = new Map(map.seats.filter((seat) => seat.row && seat.seatNumber).map((seat) => [`${seat.row}-${seat.seatNumber}`, seat]));
  const dot = (seat) => seat ? `<span class="seat ${escapeHtml(seat.status || "available")}" title="${escapeHtml(`Row ${seat.row} Seat ${seat.seatNumber}`)}"></span>` : '<span class="seat-empty"></span>';
  const rows = ["N", "M", "L", "K", "J", "H", "G", "F", "E", "D", "C", "B", "A"].map((row) => {
    const left = Array.from({ length: 16 }, (_, index) => dot(byPosition.get(`${row}-${index + 1}`))).join("");
    const right = Array.from({ length: 16 }, (_, index) => dot(byPosition.get(`${row}-${index + 17}`))).join("");
    return `<div class="laycock-row"><span>${row}</span><div>${left}</div><b></b><div>${right}</div><span>${row}</span></div>`;
  }).join("");
  return `<div class="seat-map laycock-report-map"><strong>Laycock Street final seat map</strong><div class="laycock-back">Back row</div><div class="laycock-layout">${rows}<div class="laycock-stage">Stage</div></div><div class="legend">${mapLegend(map)}</div></div>`;
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

function socialCampaignSection(analysis) {
  const display = (value) => value == null ? "—" : number.format(value);
  const correlation = ({ r, days }) => r == null ? "—" : `${r.toFixed(2)} (${days} days)`;
  const periodRows = analysis.periods.map((period) => `<tr>
    <th scope="row">${escapeHtml(period.label)}</th>
    <td>${display(period.postAverage)} (${period.postDays} days)</td>
    <td>${display(period.otherAverage)} (${period.otherDays} days)</td>
    <td>${correlation(period.frequency)}</td>
  </tr>`).join("");
  const platformRows = analysis.platforms.map((platform) => `<tr>
    <th scope="row">${escapeHtml(platform.name)}</th><td>${display(platform.posts)}</td>
    <td>${correlation(platform.views)}</td><td>${correlation(platform.viewsWithoutOpening)}</td>
    <td>${correlation(platform.reactions)}</td>
  </tr>`).join("");
  const postRows = analysis.posts.map((post) => {
    const when = new Date(post.postedAt || `${post.date}T12:00:00+10:00`);
    const time = post.postedAt ? `<small>${timeFormat.format(when)}</small>` : "";
    const views = `${post.viewsApproximate ? "≈" : ""}${display(post.views)}`;
    return `<tr><td>${dateFormat.format(when)}${time}</td><td>${escapeHtml(post.platform)}</td>
      <th scope="row"><a href="${escapeHtml(post.url)}" target="_blank" rel="noreferrer">${escapeHtml(post.theme)}</a>${post.archived ? "<small>Archived caption</small>" : ""}</th>
      <td>${views}</td><td>${display(post.reactions)}</td><td>${display(post.comments)}</td>
      <td>${display(post.shares)}</td><td>${display(post.saves)}</td><td>${display(post.nextDayTicketChange)}</td></tr>`;
  }).join("");
  const captured = dateFormat.format(new Date(`${analysis.engagementCapturedAt}T12:00:00+11:00`));
  const [overall, leadUp, run] = analysis.periods;
  const hasComparisons = [overall, leadUp, run].every((period) => period.postDays && period.otherDays);
  const finding = hasComparisons ? `<div class="campaign-analysis"><h3>What the data suggests</h3>
    <p>Across the available campaign dates, days with an observed post averaged ${display(overall.postAverage)} net tickets, compared with ${display(overall.otherAverage)} on other days. The gap was ${display(Number((leadUp.postAverage - leadUp.otherAverage).toFixed(1)))} tickets before opening and ${display(Number((run.postAverage - run.otherAverage).toFixed(1)))} during the run.</p>
  </div>` : "";
  return `<section class="report-section campaign" aria-labelledby="social-campaign-title">
    <h2 id="social-campaign-title">${escapeHtml(analysis.title)}</h2>
    <p class="subtle">${display(analysis.posts.length)} caption matches from the public Gosford Musical Society profiles and a Facebook archive. This is a partial inventory because the public profiles exposed limited history. Counters were captured ${captured}.</p>
    ${finding}
    <h3 id="campaign-sales-title">Posting and ticket sales</h3>
    <p class="subtle">Each Sydney date counts once. Net tickets are the change from that morning’s scheduled snapshot to the following morning’s snapshot. The comparison ends on closing day and skips dates with a missing snapshot. Days without an observed match may still have had campaign posts.</p>
    <div class="social-table" role="region" aria-labelledby="campaign-sales-title" tabindex="0"><table>
      <thead><tr><th scope="col">Period</th><th scope="col">Avg. tickets · post found</th><th scope="col">Avg. tickets · no post found</th><th scope="col">Posts per day · Pearson r</th></tr></thead>
      <tbody>${periodRows}</tbody>
    </table></div>
    <h3 id="campaign-engagement-title">Engagement and ticket sales</h3>
    <p class="subtle">Pearson r compares each platform’s daily totals with net tickets on days when the metric was available for every observed post on that platform. Lifetime counters include engagement after the sales window. Small samples, opening-weekend pricing and cross-posting limit what these associations say about ticket sales driven by each platform.</p>
    <div class="social-table" role="region" aria-labelledby="campaign-engagement-title" tabindex="0"><table>
      <thead><tr><th scope="col">Platform</th><th scope="col">Posts found</th><th scope="col">Views · r</th><th scope="col">Views excluding opening day · r</th><th scope="col">Likes / reactions · r</th></tr></thead>
      <tbody>${platformRows}</tbody>
    </table></div>
    <h3 id="campaign-posts-title">Posts and public counters</h3>
    <p class="subtle">Dates and times are Sydney local. A dash indicates missing or inapplicable data. Approximate view counts reflect platform rounding. Posts on the same date share the same sales figure.</p>
    <div class="social-table social-table--posts" role="region" aria-labelledby="campaign-posts-title" tabindex="0"><table>
      <thead><tr><th scope="col">Posted</th><th scope="col">Platform</th><th scope="col">Post</th><th scope="col">Views</th><th scope="col">Likes / reactions</th><th scope="col">Comments</th><th scope="col">Shares</th><th scope="col">Saves</th><th scope="col">Net tickets</th></tr></thead>
      <tbody>${postRows}</tbody>
    </table></div>
  </section>`;
}

function campaignSection(analysis) {
  if (analysis?.platforms) return socialCampaignSection(analysis);
  if (!analysis?.posts?.length) return "";
  const postAverage = analysis.postNextDayAverage == null ? "-" : `+${number.format(analysis.postNextDayAverage)}`;
  const nonPostAverage = analysis.nonPostNextDayAverage == null ? "-" : `+${number.format(analysis.nonPostNextDayAverage)}`;
  const postDayUplift = analysis.postDayUpliftPercent == null ? "-" : `${analysis.postDayUpliftPercent.toFixed(1)}%`;
  const highEngagementUplift = analysis.highEngagementUpliftPercent == null ? "-" : `${analysis.highEngagementUpliftPercent.toFixed(1)}%`;
  const writtenAnalysis = analysis.writtenAnalysis || `Days following a Facebook post averaged ${postAverage} ticket sales by the next scheduled snapshot, versus ${nonPostAverage} on days without a post. That is a ${postDayUplift} higher daily ticket uplift after posting. Across ${number.format(analysis.engagementSampleSize || 0)} posts with engagement captured, posts above the median engagement level (${number.format(analysis.medianEngagement || 0)} interactions) averaged ${number.format(analysis.highEngagementAverage || 0)} next-day tickets, compared with ${number.format(analysis.lowEngagementAverage || 0)} for posts at or below the median: a ${highEngagementUplift} higher uplift. The result indicates that more engaging posts coincided with stronger sales movement, but it is not causal proof because both demand and posting frequency increased close to opening.`;
  const cards = analysis.posts.map((post) => {
    const postDate = new Date(post.postedAt || `${post.date}T12:00:00+10:00`);
    const change = post.nextDayTicketChange == null ? "-" : `${post.nextDayTicketChange >= 0 ? "+" : ""}${number.format(post.nextDayTicketChange)}`;
    const postLabel = escapeHtml(post.theme || (post.type === "video" ? "Facebook video" : "Facebook post"));
    const postTime = post.timestampVerified === false ? `${postLabel} - time not exposed` : `${timeFormat.format(postDate)} - ${postLabel}`;
    return `<article class="campaign-card${analysis.compactCards ? " campaign-card--compact" : ""}"><img src="${escapeHtml(post.screenshot)}" alt="Facebook post from ${escapeHtml(post.date)}"><div><h3>${dateFormat.format(postDate)}</h3><p class="post-time">${postTime}</p><dl><div><dt>Likes / reactions</dt><dd>${engagementValue(post.reactions)}</dd></div><div><dt>Comments</dt><dd>${engagementValue(post.comments)}</dd></div><div><dt>Shares</dt><dd>${engagementValue(post.shares)}</dd></div><div><dt>Total engagement</dt><dd>${engagementValue(post.engagementTotal)}</dd></div><div><dt>Next-day sales</dt><dd>${change}</dd></div></dl><a href="${escapeHtml(post.url)}" target="_blank" rel="noreferrer">View post</a></div></article>`;
  }).join("");
  return `<section class="report-section campaign"><h2>${escapeHtml(analysis.title)}</h2><p class="subtle">Facebook activity supplied by the company. Ticket response is the change between the scheduled snapshots on the post date and the following day. This shows association, not proof that a post caused sales.</p><div class="campaign-summary"><span><b>${number.format(analysis.posts.length)}</b> posts</span><span><b>${postAverage}</b> average next-day sales after a post</span><span><b>${nonPostAverage}</b> average on non-post days</span></div><div class="campaign-analysis"><h3>What the data suggests</h3><p>${escapeHtml(writtenAnalysis)}</p></div><p class="subtle">Each saved Facebook thumbnail includes the public post day and time. Engagement figures are shown where Facebook exposed a reliable counter; a dash means the public card did not expose one.</p><div class="campaign-grid${analysis.compactCards ? " campaign-grid--compact" : ""}">${cards}</div></section>`;
}

function render(data) {
  const event = data.event || {};
  const summary = data.summary || {};
  const reportHeader = data.campaignAnalysis?.headerImage || (data.campaignAnalysis && !data.campaignAnalysis.platforms
    ? "/assets/report-headers/finding-nemo-campaign-header.png"
    : (event.report_header_url || event.image_url || "/assets/report-headers/default-theatre-report-header.png"));
  const image = reportHeader ? `<img class="hero-image" src="${escapeHtml(reportHeader)}" alt="">` : "";
  reportEl.innerHTML = `
    <div class="report-actions no-print"><button id="print-report" type="button">Print / Save PDF</button></div>
    <section class="cover${data.campaignAnalysis ? " campaign-cover" : ""}">${image}<div class="cover-copy"><p class="eyebrow">Post-show analysis</p><h1>${escapeHtml(event.event_name || "Theatre report")}</h1><p>${escapeHtml(event.venue || event.location || "")}</p><p>Final report generated ${new Date().toLocaleDateString("en-AU")}</p></div></section>
    <section class="overview"><div class="ring"><b>${percentage(summary.effectiveSoldPercent)}</b><span>sold</span></div><div class="overview-copy"><h2>Run summary</h2><div class="summary-grid"><span><b>${number.format(summary.performances)}</b> Performances</span><span><b>${number.format(summary.totalSeats)}</b> Saleable seats</span><span><b>${number.format(summary.ticketsSold)}</b> Tickets sold</span><span><b>${money.format(summary.revenueEstimate?.amount || 0)}</b> Est. revenue</span></div></div></section>
    <section class="report-section"><h2>Sales across the run</h2><p class="subtle">Actual ticket sales at each daily scheduled snapshot. Red points identify the final snapshot for a performance; completed performances remain included in the run total.</p>${chart(data.dailySnapshots || [], "sales-chart", data.finalSnapshotMarkers || [])}</section>
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
