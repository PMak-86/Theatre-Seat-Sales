(() => {
  const $ = selector => document.querySelector(selector);
  const tabs = [...document.querySelectorAll(".show-tabs [role=tab]")];
  const unlock = $("#campaign-unlock");
  const postForm = $("#campaign-post-form");
  const notesForm = $("#campaign-notes-form");
  const notesStatus = $("#campaign-notes-status");
  const scheduleText = $("#campaign-schedule-summary");
  const pane = $("#campaign-pane");
  const status = $("#campaign-status");
  const platforms = { facebook: "Facebook", instagram: "Instagram", tiktok: "TikTok" };
  const dateTime = new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short", timeZone: "Australia/Sydney" });
  const calendar = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Australia/Sydney" });
  const day = new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeZone: "UTC" });
  const number = new Intl.NumberFormat("en-AU");
  let eventUrl;
  let accessKey = "";
  let generation = 0;
  let detailController;
  let campaignFinish;
  const editForm = $("#campaign-edit-form");
  const editor = $("#campaign-editor");
  const editStatus = $("#campaign-edit-status");
  let editedPost = null;
  let editTrigger = null;
  let removedPost = null;
  editForm.elements.postType.replaceChildren(...[...postForm.elements.postType.options].map(option => option.cloneNode(true)));

  function setStatus(message = "", error = false) {
    status.textContent = message;
    status.hidden = !message;
    status.classList.toggle("error", error);
  }

  function showTab(tab) {
    for (const item of tabs) {
      item.setAttribute("aria-selected", String(item === tab));
      item.tabIndex = item === tab ? 0 : -1;
      document.getElementById(item.getAttribute("aria-controls")).hidden = item !== tab;
    }
    $("#export-csv").hidden = tab.id === "campaign-tab";
    if (tab.id === "campaign-tab" && accessKey) load();
  }

  for (const tab of tabs) {
    tab.addEventListener("click", () => showTab(tab));
    tab.addEventListener("keydown", event => {
      const target = { ArrowLeft: tabs.find(item => item !== tab), ArrowRight: tabs.find(item => item !== tab),
        Home: tabs[0], End: tabs.at(-1) }[event.key];
      if (!target) return;
      event.preventDefault();
      showTab(target);
      target.focus();
    });
  }

  document.addEventListener("show-analysed", event => {
    if (eventUrl === event.detail.url) return;
    eventUrl = event.detail.url;
    campaignFinish = null;
    ++generation;
    editor.hidden = true;
    editedPost = null;
    removedPost = null;
    $("#campaign-removed").hidden = true;
    detailController?.abort();
    $("#campaign-title").textContent = `Campaign log · ${event.detail.name}`;
    $("#campaign-content").hidden = true;
    $("#campaign-report").hidden = true;
    unlock.hidden = Boolean(accessKey);
    postForm.reset();
    postForm.elements.publishedOn.value = calendar.format(new Date());
    postForm.elements.publishedOn.max = calendar.format(new Date());
    setStatus();
    showTab(tabs[0]);
  });

  async function request({ body, postId, signal } = {}) {
    const path = new URL("/api/campaign", location.origin);
    const headers = { Authorization: `Bearer ${accessKey}` };
    const options = { headers, cache: "no-store", signal };
    if (body) {
      headers["Content-Type"] = "application/json";
      options.method = "POST";
      options.body = JSON.stringify({ ...body, eventUrl });
    } else {
      path.searchParams.set("eventUrl", eventUrl);
      if (postId) path.searchParams.set("postId", postId);
    }
    const response = await fetch(path, options);
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error || "The campaign request failed.");
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function rowWith(values) {
    const row = document.createElement("tr");
    for (const value of values) {
      const cell = row.insertCell();
      if (value instanceof HTMLElement) cell.append(value);
      else cell.textContent = value;
    }
    return row;
  }

  function metric(value) {
    return value == null ? "—" : number.format(value);
  }

  function datePosted(value) {
    return day.format(new Date(value + "T00:00:00Z"));
  }

  function postName(post) {
    const kind = post.post_type;
    return `${platforms[post.platform]} ${kind}`;
  }

  function render(data) {
    unlock.hidden = true;
    $("#campaign-content").hidden = false;
    campaignFinish = data.finishAt ? new Date(data.finishAt) : null;
    if (data.openingAt && data.finishAt) {
      const opening = new Date(calendar.format(new Date(data.openingAt)) + "T00:00:00Z");
      opening.setUTCDate(opening.getUTCDate() - 7);
      const finish = campaignFinish;
      scheduleText.textContent = finish <= new Date()
        ? `Captures ended ${dateTime.format(finish)} Sydney time.`
        : `Daily captures begin ${day.format(opening)} and end ${dateTime.format(finish)} Sydney time.`;
    } else {
      scheduleText.textContent = "Capture dates will appear when the ticketing provider supplies the performance times.";
    }

    $("#campaign-empty").hidden = data.posts.length > 0;
    $("#campaign-table-wrap").hidden = data.posts.length === 0;
    $("#campaign-posts").replaceChildren(...data.posts.map(post => {
      const capture = post.campaign_captures?.[0] || {};
      const button = document.createElement("button");
      button.type = "button";
      button.className = "text-button";
      button.textContent = postName(post);
      button.setAttribute("aria-pressed", "false");
      button.setAttribute("aria-controls", "campaign-report");
      button.addEventListener("click", () => readPost(post, button));
      const link = document.createElement("a");
      link.href = post.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Original post";
      const postCell = document.createElement("div");
      postCell.className = "campaign-post-links";
      const notes = document.createElement("span");
      notes.className = "campaign-row-notes";
      notes.textContent = post.notes || "";
      notes.hidden = !notes.textContent;
      postCell.append(button, link, notes);
      const last = capture.captured_at ? dateTime.format(new Date(capture.captured_at))
        : campaignFinish && campaignFinish > new Date() ? "Pending" : "No check recorded";
      const actions = document.createElement("div");
      actions.className = "campaign-entry-actions";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "text-button";
      edit.textContent = "Edit";
      edit.addEventListener("click", () => editPost(post, edit));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "text-button";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => removePost(post, remove));
      actions.append(edit, remove);
      return rowWith([postCell, datePosted(post.published_on), metric(capture.views), metric(capture.clicks), metric(capture.engagements), last, actions]);
    }));
  }

  async function load(successMessage = "") {
    const operation = ++generation;
    $("#campaign-report").hidden = true;
    editor.hidden = true;
    editedPost = null;
    detailController?.abort();
    setStatus("Loading campaign…");
    try {
      const data = await request();
      if (operation !== generation) return;
      render(data);
      setStatus(successMessage);
    } catch (error) {
      if (operation !== generation) return;
      if (error.status === 401) {
        accessKey = "";
        unlock.hidden = false;
        $("#campaign-content").hidden = true;
      }
      setStatus(error.message, true);
    }
  }

  unlock.addEventListener("submit", async event => {
    event.preventDefault();
    accessKey = unlock.elements.accessKey.value;
    unlock.reset();
    await load();
  });

  postForm.addEventListener("submit", async event => {
    event.preventDefault();
    const operation = generation;
    const submit = postForm.querySelector("button");
    submit.disabled = true;
    setStatus("Saving post…");
    try {
      await request({ body: { action: "post", ...Object.fromEntries(new FormData(postForm)) } });
      if (operation !== generation) return;
      postForm.elements.url.value = "";
      postForm.elements.notes.value = "";
      const active = campaignFinish && campaignFinish > new Date();
      await load(active ? "Post logged. The first public capture will run on the next scheduled check." : "Post logged.");
    } catch (error) {
      if (operation === generation) setStatus(error.message, true);
    } finally {
      submit.disabled = false;
    }
  });

  async function readPost(post, button) {
    detailController?.abort();
    const controller = new AbortController();
    detailController = controller;
    for (const choice of $("#campaign-posts").querySelectorAll("[aria-pressed]")) {
      choice.setAttribute("aria-pressed", String(choice === button));
    }
    const report = $("#campaign-report");
    const preview = $("#campaign-preview");
    const message = $("#campaign-report-status");
    $("#campaign-report-title").textContent = `${postName(post)} snapshot history`;
    $("#campaign-original").href = post.url;
    preview.replaceChildren();
    notesForm.hidden = true;
    $("#campaign-report-table").hidden = true;
    message.textContent = "Loading snapshots…";
    report.hidden = false;
    try {
      const data = await request({ postId: post.id, signal: controller.signal });
      if (controller.signal.aborted) return;
      const saved = data.post;
      enableNotes(saved, button, controller.signal);
      if (saved.preview?.kind === "screenshot" && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(saved.preview_image || "")) {
        const image = document.createElement("img");
        image.src = saved.preview_image;
        image.alt = `Saved screenshot of the ${postName(saved)}`;
        const stamp = document.createElement("p");
        stamp.textContent = `Post screenshot captured ${dateTime.format(new Date(saved.preview.capturedAt))} Sydney time.`;
        preview.append(image, stamp);
      }
      const captureStatus = saved.capture_status || "The first public snapshot has not been recorded yet.";
      message.textContent = `${captureStatus} A dash means the figure was unavailable. Counts shown in abbreviated form by the platform are approximate.`;
      $("#campaign-captures").replaceChildren(...data.captures.map(capture => rowWith([
        dateTime.format(new Date(capture.captured_at)), capture.cadence === "daily" ? "Daily" : "Weekly",
        metric(capture.views), metric(capture.clicks), metric(capture.engagements),
        metric(capture.likes), metric(capture.comments), metric(capture.shares),
      ])));
      $("#campaign-report-table").hidden = !data.captures.length;
    } catch (error) {
      if (!controller.signal.aborted) message.textContent = error.message;
    }
  }

  function editPost(post, trigger) {
    detailController?.abort();
    $("#campaign-report").hidden = true;
    editedPost = post.id;
    editTrigger = trigger;
    $("#campaign-edit-post").textContent = `${postName(post)} · ${post.url}`;
    editForm.elements.publishedOn.value = post.published_on;
    editForm.elements.publishedOn.max = calendar.format(new Date());
    editForm.elements.postType.value = post.post_type;
    editForm.elements.notes.value = post.notes || "";
    editStatus.hidden = true;
    editor.hidden = false;
    editForm.elements.publishedOn.focus();
  }

  $("#campaign-edit-cancel").addEventListener("click", () => {
    editor.hidden = true;
    editedPost = null;
    editTrigger?.focus();
  });

  editForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (!editedPost) return;
    const operation = generation;
    const submit = editForm.querySelector("[type=submit]");
    submit.disabled = true;
    editStatus.hidden = false;
    editStatus.textContent = "Saving changes…";
    try {
      await request({ body: { action: "edit", postId: editedPost, ...Object.fromEntries(new FormData(editForm)) } });
      if (operation !== generation) return;
      await load("Entry updated.");
    } catch (error) {
      if (operation === generation) editStatus.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  });

  async function removePost(post, trigger) {
    const operation = generation;
    trigger.disabled = true;
    try {
      await request({ body: { action: "remove", postId: post.id } });
      if (operation !== generation) return;
      removedPost = post.id;
      await load();
      $("#campaign-removed").hidden = false;
      $("#campaign-undo").focus();
    } catch (error) {
      if (operation === generation) setStatus(error.message, true);
    } finally {
      trigger.disabled = false;
    }
  }

  $("#campaign-undo").addEventListener("click", async event => {
    if (!removedPost) return;
    const operation = generation;
    const trigger = event.currentTarget;
    trigger.disabled = true;
    try {
      await request({ body: { action: "restore", postId: removedPost } });
      if (operation !== generation) return;
      removedPost = null;
      $("#campaign-removed").hidden = true;
      await load("Entry restored.");
    } catch (error) {
      if (operation === generation) setStatus(error.message, true);
    } finally {
      trigger.disabled = false;
    }
  });

  function enableNotes(post, button, signal) {
    const field = notesForm.elements.notes;
    const submit = notesForm.querySelector("button");
    field.value = post.notes || "";
    notesStatus.hidden = true;
    notesForm.hidden = false;
    submit.disabled = false;

    notesForm.onsubmit = async event => {
      event.preventDefault();
      const notes = field.value;
      submit.disabled = true;
      notesStatus.textContent = "Saving notes…";
      notesStatus.hidden = false;
      try {
        const { post: saved } = await request({ body: { action: "notes", postId: post.id, notes }, signal });
        if (signal.aborted) return;
        const rowNotes = button.parentElement.querySelector(".campaign-row-notes");
        rowNotes.textContent = saved.notes;
        rowNotes.hidden = !saved.notes;
        if (field.value === notes) field.value = saved.notes;
        notesStatus.textContent = "Notes saved.";
      } catch (error) {
        if (!signal.aborted) notesStatus.textContent = error.message;
      } finally {
        if (!signal.aborted) submit.disabled = false;
      }
    };
  }
})();
