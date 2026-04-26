(function () {
  "use strict";

  // ── Bootstrap ────────────────────────────────────────────────────────────
  const root = document.getElementById("game-root");
  const ROOM_CODE     = root.dataset.roomCode;
  const PLAYER_ID     = root.dataset.playerId;
  const SESSION_TOKEN = root.dataset.sessionToken;
  const IS_HOST       = root.dataset.isHost === "true";
  const VAPID_KEY     = root.dataset.vapidKey || "";

  let ws = null;
  let myRole = null;
  let myMission = null;
  let myAgentName = null;
  let myAgentMission = null;
  let timerInterval = null;
  let timeRemainingMs = 0;
  let allPlayers = [];   // [{id, name, score, is_host}]
  let lastResults = null;

  // ── WebSocket ─────────────────────────────────────────────────────────────
  function connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/ws/${ROOM_CODE}/${PLAYER_ID}/${SESSION_TOKEN}`);

    ws.onopen = () => console.log("[WS] connected");

    ws.onmessage = (e) => {
      try { dispatch(JSON.parse(e.data)); } catch (err) { console.error(err); }
    };

    ws.onclose = () => {
      console.log("[WS] disconnected — reconnecting in 2s");
      setTimeout(connect, 2000);
    };
  }

  function send(action, payload = {}) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ action, payload }));
    }
  }

  // ── Message dispatcher ───────────────────────────────────────────────────
  function dispatch(msg) {
    switch (msg.event) {
      case "ROOM_STATE_SYNC":   onStateSync(msg.payload);    break;
      case "ROLE_ASSIGNED":     onRoleAssigned(msg.payload); break;
      case "PLAYER_JOINED":     onPlayerJoined(msg.payload); break;
      case "ROUND_RESULTS":     onRoundResults(msg.payload); break;
      case "DEBRIEF_SUBMITTED": onDebriefSubmitted(msg.payload); break;
      case "ERROR":             alert(msg.payload.message);  break;
    }
  }

  // ── State sync ────────────────────────────────────────────────────────────
  function onStateSync(p) {
    allPlayers = p.players || [];

    if (p.your_role) {
      myRole = p.your_role;
      myMission = p.your_mission || null;
      myAgentName = p.agent_name || null;
      myAgentMission = p.agent_mission || null;
    }

    if (p.results) lastResults = p.results;

    switch (p.state) {
      case "LOBBY":
        showLobby(allPlayers);
        break;
      case "ROUND_ACTIVE":
        showRound(p.round_number, p.time_remaining_ms, false);
        break;
      case "PAUSED":
        showRound(p.round_number, p.time_remaining_ms, true);
        break;
      case "DEBRIEF_PENDING":
        showDebrief(p.round_number, p.submitted_count, p.total_count);
        break;
      case "ROUND_SUMMARY":
        if (lastResults) showSummary(lastResults);
        break;
    }
  }

  function onRoleAssigned(p) {
    myRole = p.role;
    myMission = p.mission_text || null;
    myAgentName = p.agent_name || null;
    myAgentMission = p.agent_mission || null;
    applyRoleCard();
  }

  function onPlayerJoined(_p) {
    // Player list is kept in sync via ROOM_STATE_SYNC; this is a no-op placeholder
    // kept in case we want to add a toast notification later.
  }

  function onRoundResults(p) {
    lastResults = p;
    showSummary(p);
  }

  function onDebriefSubmitted(p) {
    updateDebriefProgress(p.submitted_count, p.total_count);
  }

  // ── Views ─────────────────────────────────────────────────────────────────
  function showView(id) {
    ["lobby-view", "round-view", "debrief-view", "summary-view"].forEach((v) => {
      document.getElementById(v).classList.add("hidden");
    });
    document.getElementById("pause-overlay").classList.add("hidden");
    document.getElementById(id).classList.remove("hidden");
  }

  // LOBBY
  function showLobby(players) {
    showView("lobby-view");
    clearTimer();

    const url = `${location.origin}/join/${ROOM_CODE}`;
    document.getElementById("join-url").textContent = url;

    renderPlayerList(players);
    updateStartButton();
  }

  function renderPlayerList(players) {
    const ul = document.getElementById("player-list");
    ul.innerHTML = "";
    players.forEach((p) => ul.appendChild(makePlayerLi(p.name, p.is_host)));
    const msg = document.getElementById("player-count-msg");
    if (players.length < 3) {
      msg.textContent = `${players.length} / 3 minimum players joined`;
    } else {
      msg.textContent = `${players.length} players ready`;
    }
  }

  function makePlayerLi(name, isHost) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="dot"></span><span>${esc(name)}</span>${isHost ? '<span class="host-badge">Host</span>' : ""}`;
    return li;
  }

  function updateStartButton() {
    const btn = document.getElementById("start-game-btn");
    if (!btn) return;
    const count = document.getElementById("player-list").children.length;
    btn.disabled = count < 3;
  }

  // ROUND
  function showRound(roundNumber, remainingMs, paused) {
    showView("round-view");
    setText("round-label", `Round ${roundNumber}`);

    timeRemainingMs = remainingMs || 0;
    updateTimerDisplay();

    if (paused) {
      clearTimer();
      document.getElementById("pause-overlay").classList.remove("hidden");
    } else {
      startTimer();
    }

    applyRoleCard();
  }

  function applyRoleCard() {
    if (!myRole) return;
    const card = document.getElementById("role-card");
    card.className = `role-card ${myRole.toLowerCase()}`;

    setText("role-badge", myRole);

    const missionBlock  = document.getElementById("mission-block");
    const witnessBlock  = document.getElementById("witness-block");
    const witnessHint   = document.getElementById("witness-hint");
    const crowdHint     = document.getElementById("crowd-hint");

    missionBlock.classList.add("hidden");
    witnessBlock.classList.add("hidden");
    witnessHint.classList.add("hidden");
    crowdHint.classList.add("hidden");

    if (myRole === "AGENT" && myMission) {
      setText("mission-text", myMission);
      missionBlock.classList.remove("hidden");
    } else if (myRole === "WITNESS") {
      if (myAgentName) {
        setText("witness-agent-name", myAgentName);
        setText("witness-agent-mission", myAgentMission || "Unknown");
        witnessBlock.classList.remove("hidden");
      }
      witnessHint.classList.remove("hidden");
    } else if (myRole === "CROWD") {
      crowdHint.classList.remove("hidden");
    }
  }

  // DEBRIEF
  function showDebrief(roundNumber, submittedCount, totalCount) {
    showView("debrief-view");
    clearTimer();
    setText("debrief-round-label", `Round ${roundNumber}`);
    buildDebriefForm();

    document.getElementById("waiting-for-others").classList.add("hidden");
    const btn = document.getElementById("submit-debrief-btn");
    btn.disabled = false;
    btn.textContent = "Submit Report";

    updateDebriefProgress(submittedCount || 0, totalCount || allPlayers.length);
  }

  function buildDebriefForm() {
    const container = document.getElementById("debrief-form-content");
    container.innerHTML = "";

    if (!myRole) {
      container.innerHTML = `<p class="hint">Waiting for role assignment…</p>`;
      return;
    }

    if (myRole === "AGENT") {
      container.innerHTML = `
        <p class="debrief-question">Did you complete your mission?</p>
        ${myMission ? `<p class="mission-reminder">"${esc(myMission)}"</p>` : ""}
        <div class="radio-group">
          <label><input type="radio" name="report" value="SUCCESS"> Yes, I completed it</label>
          <label><input type="radio" name="report" value="FAILURE"> No, I didn't manage it</label>
        </div>`;
    } else if (myRole === "WITNESS") {
      const agentReminder = myAgentName
        ? `<p class="mission-reminder">Agent: <strong>${esc(myAgentName)}</strong> — "${esc(myAgentMission || "")}"</p>`
        : "";
      container.innerHTML = `
        <p class="debrief-question">Did you witness the Agent complete their mission?</p>
        ${agentReminder}
        <div class="radio-group">
          <label><input type="radio" name="report" value="WITNESSED"> Yes, I saw it happen</label>
          <label><input type="radio" name="report" value="MISSED"> No, I missed it</label>
        </div>`;
    } else {
      const others = allPlayers.filter((p) => p.id !== PLAYER_ID);
      const options = others.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
      container.innerHTML = `
        <p class="debrief-question">Did you notice anything suspicious?</p>
        <div class="radio-group">
          <label><input type="radio" name="report" value="NO_SUSPICION" checked> Nothing suspicious</label>
          <label><input type="radio" name="report" value="BURN" id="burn-radio"> I want to burn someone</label>
        </div>
        <div id="burn-details" class="hidden" style="display:flex;flex-direction:column;gap:10px;margin-top:8px;">
          <p class="hint">Who do you think was the Agent?</p>
          <select id="burn-target">${options}</select>
          <p class="hint">What do you think their mission was? <em>(optional)</em></p>
          <input type="text" id="mission-guess" placeholder="Describe the mission…" maxlength="200">
        </div>`;

      document.getElementById("burn-radio").addEventListener("change", () => {
        document.getElementById("burn-details").classList.remove("hidden");
      });
      container.querySelector('input[value="NO_SUSPICION"]').addEventListener("change", () => {
        document.getElementById("burn-details").classList.add("hidden");
      });
    }
  }

  function updateDebriefProgress(submitted, total) {
    const pct = total > 0 ? Math.round((submitted / total) * 100) : 0;
    const bar = document.getElementById("debrief-progress-bar");
    const txt = document.getElementById("debrief-progress-text");
    if (bar) bar.style.width = pct + "%";
    if (txt) txt.textContent = `${submitted} of ${total} reports submitted`;
  }

  // SUMMARY
  function showSummary(results) {
    showView("summary-view");
    clearTimer();

    setText("summary-round-label", `Round ${results.round_number}`);

    // Reveal card
    const reveal = document.getElementById("reveal-card");
    reveal.innerHTML = `
      <h2>The Mission</h2>
      <div class="reveal-row"><span class="label">Agent</span><span class="value">${esc(results.agent_name || "?")}</span></div>
      <div class="reveal-row"><span class="label">Witness</span><span class="value">${esc(results.witness_name || "?")}</span></div>
      <div class="reveal-row"><span class="label">Mission</span><span class="value" style="max-width:60%;text-align:right;">${esc(results.mission || "?")}</span></div>`;

    // Outcomes card
    const outcomesCard = document.getElementById("outcomes-card");
    const outcomeLabels = {
      PERFECT_CRIME:    "Perfect Crime",
      HONORABLE_EFFORT: "Honorable Effort",
      MISSION_FAILED:   "Mission Failed",
      SLOPPY_AGENT:     "Sloppy Agent",
      FALSE_ACCUSATION: "False Accusation",
    };
    const outcomeChips = (results.outcomes || []).map((o) => {
      const label = outcomeLabels[o.type] || o.type;
      const detail = o.accuser_name ? ` — ${esc(o.accuser_name)}` : "";
      return `<span class="outcome-chip outcome-${o.type}">${label}${detail}</span>`;
    }).join(" ");

    outcomesCard.innerHTML = `<h2>Outcome</h2><div style="display:flex;flex-wrap:wrap;gap:8px;">${outcomeChips}</div>`;

    // Score deltas card
    const lbCard = document.getElementById("leaderboard-card");
    const deltaRows = (results.score_deltas || []).map((d) => {
      const sign  = d.delta > 0 ? "+" : "";
      const cls   = d.delta > 0 ? "pos" : d.delta < 0 ? "neg" : "zero";
      return `<div class="score-row">
        <span>${esc(d.name)}</span>
        <span>
          <span class="delta ${cls}">${sign}${d.delta}</span>
          <span class="total"> (${d.total} total)</span>
        </span>
      </div>`;
    }).join("");

    const lbRows = (results.leaderboard || []).map((p, i) =>
      `<div class="leaderboard-row">
        <span class="rank">${i + 1}.</span>
        <span>${esc(p.name)}</span>
        <span class="score">${p.score}</span>
      </div>`
    ).join("");

    lbCard.innerHTML = `
      <h2>This Round</h2>${deltaRows}
      <div style="margin-top:12px;"><h2 style="margin-bottom:8px;">Leaderboard</h2>${lbRows}</div>`;
  }

  // ── Timer ──────────────────────────────────────────────────────────────────
  function startTimer() {
    clearTimer();
    timerInterval = setInterval(() => {
      timeRemainingMs = Math.max(0, timeRemainingMs - 1000);
      updateTimerDisplay();
    }, 1000);
  }

  function clearTimer() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  }

  function updateTimerDisplay() {
    const el = document.getElementById("timer-display");
    if (!el) return;
    const m = Math.floor(timeRemainingMs / 60000);
    const s = Math.floor((timeRemainingMs % 60000) / 1000);
    el.textContent = `${m}:${String(s).padStart(2, "0")}`;
    el.className = "timer";
    if (timeRemainingMs <= 5 * 60 * 1000) el.classList.add("critical");
    else if (timeRemainingMs <= 15 * 60 * 1000) el.classList.add("warning");
  }

  // ── Host controls ──────────────────────────────────────────────────────────
  on("start-game-btn",    "click", () => send("START_GAME"));
  on("pause-btn",         "click", () => send("PAUSE_GAME"));
  on("resume-btn",        "click", () => send("RESUME_GAME"));
  on("next-round-btn",    "click", () => send("NEXT_ROUND"));
  on("force-results-btn", "click", () => send("FORCE_RESULTS"));
  on("force-debrief-btn", "click", () => {
    if (confirm("End the round early and open debrief?")) send("FORCE_DEBRIEF");
  });

  // Debrief submit
  on("submit-debrief-btn", "click", () => {
    const selected = document.querySelector('input[name="report"]:checked');
    if (!selected) { alert("Please select an option."); return; }

    const payload = { report_type: selected.value };
    if (selected.value === "BURN") {
      const target = document.getElementById("burn-target");
      if (!target || !target.value) { alert("Please select who you want to burn."); return; }
      payload.target_id = target.value;
      const guess = document.getElementById("mission-guess");
      payload.mission_guess = guess ? guess.value.trim() || null : null;
    }

    send("SUBMIT_DEBRIEF", payload);

    const btn = document.getElementById("submit-debrief-btn");
    btn.disabled = true;
    btn.textContent = "Report submitted ✓";
    document.getElementById("debrief-form-content").classList.add("hidden");
    document.getElementById("waiting-for-others").classList.remove("hidden");
  });

  // ── Service worker & push ─────────────────────────────────────────────────
  async function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    try {
      const reg = await navigator.serviceWorker.register("/sw.js");
      if (VAPID_KEY) await subscribePush(reg);
    } catch (e) {
      console.warn("SW registration failed:", e);
    }
  }

  async function subscribePush(reg) {
    if (!("PushManager" in window)) return;
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return;
    try {
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_KEY),
      });
      send("SAVE_PUSH_SUB", { subscription: JSON.parse(JSON.stringify(sub)) });
    } catch (e) {
      console.warn("Push subscription failed:", e);
    }
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
  }

  // ── Utilities ─────────────────────────────────────────────────────────────
  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function on(id, event, handler) {
    const el = document.getElementById(id);
    if (el) el.addEventListener(event, handler);
  }

  function esc(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  connect();
  registerSW();
})();
