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
  let tutorialSeen = false;
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
      case "PLAYER_JOINED":     /* handled via full state sync */ break;
      case "ROUND_RESULTS":     onRoundResults(msg.payload); break;
      case "DEBRIEF_SUBMITTED": onDebriefSubmitted(msg.payload); break;
      case "GAME_OVER":         onGameOver(msg.payload);     break;
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
        showDebrief(p.round_number, p.submitted_count, p.total_count,
                    p.your_role, p.your_mission, p.agent_name, p.agent_mission);
        break;
      case "ROUND_SUMMARY":
        if (lastResults) showSummary(lastResults);
        break;
      case "GAME_OVER":
        if (p.game_over) onGameOver(p.game_over);
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

  function onRoundResults(p) {
    lastResults = p;
    showSummary(p);
  }

  function onDebriefSubmitted(p) {
    updateDebriefProgress(p.submitted_count, p.total_count);
  }

  function onGameOver(p) {
    showView("gameover-view");
    clearTimer();

    // Final leaderboard
    const lb = document.getElementById("gameover-leaderboard");
    const rows = (p.leaderboard || []).map((pl, i) => `
      <div class="leaderboard-row${i === 0 ? " leaderboard-winner" : ""}">
        <span class="rank">${i === 0 ? "🏆" : `${i + 1}.`}</span>
        <span>${esc(pl.name)}</span>
        <span class="score">${pl.score}</span>
      </div>`).join("");
    lb.innerHTML = `<h2>Final Standings</h2>${rows}`;

    // Mission history
    const hist = document.getElementById("gameover-history");
    const outcomeLabels = {
      PERFECT_CRIME: "Perfect Crime", HONORABLE_EFFORT: "Honorable Effort",
      MISSION_FAILED: "Mission Failed", SLOPPY_AGENT: "Burner",
      FALSE_ACCUSATION: "False Accusation",
    };
    const hRows = (p.history || []).map((r) => {
      const chips = (r.outcomes || []).map((o) => {
        const vetoStyle = o.vetoed ? ' style="opacity:0.4;text-decoration:line-through;"' : "";
        return `<span class="outcome-chip outcome-${o.type}"${vetoStyle}>${outcomeLabels[o.type] || o.type}</span>`;
      }).join(" ");
      const burnDetails = (r.burns || []).map((b) => {
        const correctTag = b.correct
          ? `<span class="burn-correct">correct</span>`
          : `<span class="burn-wrong">wrong</span>`;
        const vetoedTag = b.vetoed ? `<span class="burn-vetoed-badge">vetoed</span>` : "";
        const guess = b.mission_guess
          ? `<div class="burn-guess">"${esc(b.mission_guess)}"</div>`
          : "";
        return `<div class="burn-row${b.vetoed ? " burn-row-vetoed" : ""}">
          <div class="burn-header">
            <span class="burn-accuser">${esc(b.accuser_name)}</span>
            <span class="burn-arrow">→</span>
            <span class="burn-target">${esc(b.target_name)}</span>
            ${correctTag}${vetoedTag}
          </div>
          ${guess}
        </div>`;
      }).join("");
      return `<div class="history-row">
        <div class="history-header">
          <span class="history-round">Round ${r.round_number}</span>
          <span class="history-agent">${esc(r.agent_name)}</span>
        </div>
        <p class="history-mission">${esc(r.mission)}</p>
        <div style="margin-top:6px;">${chips}</div>
        ${burnDetails ? `<div style="margin-top:8px;">${burnDetails}</div>` : ""}
      </div>`;
    }).join("");
    hist.innerHTML = `<h2>Mission History</h2>${hRows}`;
  }

  // ── Views ─────────────────────────────────────────────────────────────────
  function showView(id) {
    ["lobby-view", "round-view", "debrief-view", "summary-view", "gameover-view"].forEach((v) => {
      document.getElementById(v).classList.add("hidden");
    });
    document.getElementById("pause-overlay").classList.add("hidden");
    document.getElementById("howtoplay-overlay").classList.add("hidden");
    document.getElementById(id).classList.remove("hidden");
  }

  const WEBHOOK_STORAGE_KEY = "undercurrent_discord_webhook";

  // LOBBY
  function showLobby(players) {
    showView("lobby-view");
    clearTimer();

    const url = `${location.origin}/join/${ROOM_CODE}`;
    document.getElementById("join-url").textContent = url;

    // Pre-populate webhook input from localStorage (host only)
    if (IS_HOST) {
      const webhookInput = document.getElementById("discord-webhook-input");
      if (webhookInput) {
        webhookInput.value = localStorage.getItem(WEBHOOK_STORAGE_KEY) || "";
        webhookInput.addEventListener("change", () => {
          const val = webhookInput.value.trim();
          if (val) localStorage.setItem(WEBHOOK_STORAGE_KEY, val);
          else localStorage.removeItem(WEBHOOK_STORAGE_KEY);
        });
      }
    }

    const copyBtn = document.getElementById("copy-url-btn");
    if (copyBtn) {
      copyBtn.onclick = () => {
        navigator.clipboard.writeText(url).then(() => {
          copyBtn.textContent = "Copied!";
          setTimeout(() => { copyBtn.textContent = "Copy"; }, 2000);
        });
      };
    }

    renderPlayerList(players);
    updateStartButton();
  }

  function renderPlayerList(players) {
    const ul = document.getElementById("player-list");
    ul.innerHTML = "";
    players.forEach((p) => ul.appendChild(makePlayerLi(p)));

    const msg = document.getElementById("player-count-msg");
    msg.textContent = players.length < 3
      ? `${players.length} / 3 minimum players joined`
      : `${players.length} players ready`;

    if (IS_HOST) {
      ul.querySelectorAll(".rename-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const newName = prompt(`Rename "${btn.dataset.name}":`, btn.dataset.name);
          if (newName && newName.trim() && newName.trim() !== btn.dataset.name) {
            send("RENAME_PLAYER", { player_id: btn.dataset.id, new_name: newName.trim().slice(0, 30) });
          }
        });
      });
    }
  }

  function makePlayerLi(player) {
    const li = document.createElement("li");
    const hostBadge = player.is_host ? '<span class="host-badge">Host</span>' : "";
    // Host can rename non-host players while in lobby
    const renameBtn = (IS_HOST && !player.is_host)
      ? `<button class="rename-btn" data-id="${esc(player.id)}" data-name="${esc(player.name)}" title="Rename">✏</button>`
      : "";
    li.innerHTML = `<span class="dot"></span><span class="player-name">${esc(player.name)}</span>${hostBadge}${renameBtn}`;
    return li;
  }

  function updateStartButton() {
    const btn = document.getElementById("start-game-btn");
    if (!btn) return;
    btn.disabled = allPlayers.length < 3;
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

    if (roundNumber === 1 && !tutorialSeen) {
      document.getElementById("howtoplay-overlay").classList.remove("hidden");
    }
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
  // role/mission params passed directly from the state sync payload so the
  // form is always built with fresh data even on reconnect.
  function showDebrief(roundNumber, submittedCount, totalCount, role, mission, agentName, agentMission) {
    // Update globals if fresh data arrived
    if (role) { myRole = role; myMission = mission || null; }
    if (agentName) { myAgentName = agentName; myAgentMission = agentMission || null; }

    showView("debrief-view");
    clearTimer();
    setText("debrief-round-label", `Round ${roundNumber}`);

    // Always unhide form content (may have been hidden from a previous round's submission)
    document.getElementById("debrief-form-content").classList.remove("hidden");
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
      container.innerHTML = `<p class="hint">Loading your role…</p>`;
      setTimeout(buildDebriefForm, 400);
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
      // CROWD
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

    const reveal = document.getElementById("reveal-card");
    reveal.innerHTML = `
      <h2>The Mission</h2>
      <div class="reveal-row"><span class="label">Agent</span><span class="value">${esc(results.agent_name || "?")}</span></div>
      <div class="reveal-row"><span class="label">Witness</span><span class="value">${esc(results.witness_name || "?")}</span></div>
      <div class="reveal-row"><span class="label">Mission</span><span class="value" style="max-width:60%;text-align:right;">${esc(results.mission || "?")}</span></div>`;

    const outcomeLabels = {
      PERFECT_CRIME: "Perfect Crime", HONORABLE_EFFORT: "Honorable Effort",
      MISSION_FAILED: "Mission Failed", SLOPPY_AGENT: "Burner",
      FALSE_ACCUSATION: "False Accusation",
    };
    const chips = (results.outcomes || []).map((o) => {
      const label = outcomeLabels[o.type] || o.type;
      const detail = o.accuser_name ? ` — ${esc(o.accuser_name)}` : "";
      const vetoStyle = o.vetoed ? ' style="opacity:0.4;text-decoration:line-through;"' : "";
      return `<span class="outcome-chip outcome-${o.type}"${vetoStyle}>${label}${detail}</span>`;
    }).join(" ");
    document.getElementById("outcomes-card").innerHTML =
      `<h2>Outcome</h2><div style="display:flex;flex-wrap:wrap;gap:8px;">${chips}</div>`;

    // Burns section
    const burnsCard = document.getElementById("burns-card");
    const burns = results.burns || [];
    if (burns.length > 0) {
      const burnRows = burns.map((b) => {
        const correctTag = b.correct
          ? `<span class="burn-correct">correct</span>`
          : `<span class="burn-wrong">wrong</span>`;
        const vetoedTag = b.vetoed ? `<span class="burn-vetoed-badge">vetoed</span>` : "";
        const guess = b.mission_guess
          ? `<div class="burn-guess">"${esc(b.mission_guess)}"</div>`
          : "";
        const vetoBtn = (IS_HOST && b.correct)
          ? `<button class="veto-btn" data-burn-id="${esc(b.id)}">${b.vetoed ? "Un-veto" : "Veto"}</button>`
          : "";
        return `<div class="burn-row${b.vetoed ? " burn-row-vetoed" : ""}">
          <div class="burn-header">
            <span class="burn-accuser">${esc(b.accuser_name)}</span>
            <span class="burn-arrow">→</span>
            <span class="burn-target">${esc(b.target_name)}</span>
            ${correctTag}${vetoedTag}
            ${vetoBtn}
          </div>
          ${guess}
        </div>`;
      }).join("");
      burnsCard.innerHTML = `<h2>Burns</h2>${burnRows}`;
      burnsCard.classList.remove("hidden");

      burnsCard.querySelectorAll(".veto-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          send("VETO_BURN", { report_id: btn.dataset.burnId });
        });
      });
    } else {
      burnsCard.classList.add("hidden");
      burnsCard.innerHTML = "";
    }

    const lbCard = document.getElementById("leaderboard-card");
    const roleLabel = { AGENT: "Agent", WITNESS: "Witness" };
    const deltaRows = (results.score_deltas || []).map((d) => {
      const sign = d.delta > 0 ? "+" : "";
      const cls  = d.delta > 0 ? "pos" : d.delta < 0 ? "neg" : "zero";
      const badge = roleLabel[d.role]
        ? `<span class="role-badge-small ${d.role.toLowerCase()}-color">${roleLabel[d.role]}</span>`
        : "";
      return `<div class="score-row">
        <span>${esc(d.name)}${badge}</span>
        <span><span class="delta ${cls}">${sign}${d.delta}</span><span class="total"> (${d.total} total)</span></span>
      </div>`;
    }).join("");
    const lbRows = (results.leaderboard || []).map((p, i) =>
      `<div class="leaderboard-row">
        <span class="rank">${i + 1}.</span><span>${esc(p.name)}</span><span class="score">${p.score}</span>
      </div>`
    ).join("");
    lbCard.innerHTML = `<h2>This Round</h2>${deltaRows}
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

  // ── Duration helper ────────────────────────────────────────────────────────
  function selectedDuration() {
    // Summary select takes priority when visible, otherwise lobby select
    const summaryEl = document.getElementById("summary-duration-select");
    if (summaryEl && !document.getElementById("summary-view").classList.contains("hidden")) {
      return parseInt(summaryEl.value, 10);
    }
    const lobbyEl = document.getElementById("lobby-duration-select");
    return lobbyEl ? parseInt(lobbyEl.value, 10) : 60;
  }

  // ── Host controls ──────────────────────────────────────────────────────────
  on("start-game-btn", "click", () => {
    const webhookInput = document.getElementById("discord-webhook-input");
    const webhookUrl = webhookInput ? webhookInput.value.trim() : "";
    if (webhookUrl) localStorage.setItem(WEBHOOK_STORAGE_KEY, webhookUrl);
    send("START_GAME", {
      duration_minutes: selectedDuration(),
      discord_webhook_url: webhookUrl || null,
    });
  });
  on("pause-btn",         "click", () => send("PAUSE_GAME"));
  on("resume-btn",        "click", () => send("RESUME_GAME"));
  on("next-round-btn",    "click", () => send("NEXT_ROUND",  { duration_minutes: selectedDuration() }));
  on("force-results-btn", "click", () => send("FORCE_RESULTS"));
  on("force-debrief-btn", "click", () => {
    if (confirm("End the round early and open debrief?")) send("FORCE_DEBRIEF");
  });
  on("howtoplay-close-btn", "click", () => {
    tutorialSeen = true;
    document.getElementById("howtoplay-overlay").classList.add("hidden");
  });
  on("abandon-round-btn", "click", () => {
    if (confirm("Abandon this round and retry with newly assigned roles? No points will be awarded.")) {
      send("ABANDON_ROUND");
    }
  });
  on("end-game-btn", "click", () => {
    if (confirm("End the game and show the final leaderboard? This cannot be undone.")) {
      send("END_GAME");
    }
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
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  connect();
  registerSW();

  // Re-sync when a backgrounded tab regains focus — browsers throttle timers
  // while hidden, so the clock drifts and missed WS messages can leave stale UI.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      if (ws && ws.readyState === WebSocket.OPEN) {
        send("REQUEST_SYNC", {});
      }
      // If WS is closed the reconnect handler will fire and sync on connect.
    }
  });
})();
