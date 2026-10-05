(function () {
  const STATUS_ORIGIN = "https://www.githubstatus.com";
  const STORAGE_RATE = "github-downtime-clock.rate";
  const DEFAULT_RATE = "65";
  const STORAGE_COMPONENT = "github-downtime-clock.component";
  const REFRESH_MS = 60 * 1000;

  const RANK = {
    operational: 0,
    degraded_performance: 1,
    partial_outage: 2,
    major_outage: 3,
  };

  const STATUS_LABEL = {
    operational: "Operational",
    degraded_performance: "Degraded",
    partial_outage: "Partial outage",
    major_outage: "Full outage",
    under_maintenance: "Maintenance",
  };

  const moneyFormat = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const incidentCache = new Map();
  let summary = null;
  let showcase = null;
  let snapshot = null;
  let refreshTimer = 0;
  let activeController = null;
  let rendered = {};

  function worstStatus(state) {
    let best = "operational";
    let bestRank = 0;
    for (const status of state.values()) {
      const rank = RANK[status] || 0;
      if (rank > bestRank) {
        best = status;
        bestRank = rank;
      }
    }
    return best;
  }

  // Merge every incident that touched the component. A partial outage on the
  // status page is 30% of these seconds; degraded performance is 0%. The
  // returned seconds are the full time spent in each state.
  function accumulate(incidents, componentId, windowStartMs, nowMs) {
    const events = [];
    for (const incident of incidents) {
      const updates = (incident.incident_updates || [])
        .slice()
        .sort(function (a, b) {
          return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
        });
      let last = null;
      let mentioned = false;
      for (const update of updates) {
        const comps = (update.affected_components || []).filter(function (component) {
          return component.code === componentId;
        });
        if (!comps.length) continue;
        mentioned = true;
        last = comps[comps.length - 1].new_status;
        events.push({
          t: Date.parse(update.created_at),
          id: incident.id,
          status: last,
        });
      }
      if (mentioned && incident.resolved_at && last && last !== "operational") {
        events.push({
          t: Date.parse(incident.resolved_at),
          id: incident.id,
          status: "operational",
        });
      }
    }

    events.sort(function (a, b) {
      if (a.t !== b.t) return a.t - b.t;
      const aClose = a.status === "operational" ? 0 : 1;
      const bClose = b.status === "operational" ? 0 : 1;
      return aClose - bClose;
    });

    const state = new Map();
    let current = "operational";
    let currentTime = null;
    const totals = {
      major_outage: 0,
      partial_outage: 0,
      degraded_performance: 0,
    };

    function add(from, to, status) {
      if (!totals.hasOwnProperty(status)) return;
      const start = Math.max(from, windowStartMs);
      const end = Math.min(to, nowMs);
      if (end > start) totals[status] += (end - start) / 1000;
    }

    for (const event of events) {
      const previous = current;
      state.set(event.id, event.status);
      if (event.status === "operational") state.delete(event.id);
      current = worstStatus(state);
      if (currentTime === null) {
        currentTime = event.t;
        continue;
      }
      if (previous !== "operational") add(currentTime, event.t, previous);
      currentTime = event.t;
    }
    if (currentTime !== null && current !== "operational") {
      add(currentTime, nowMs, current);
    }
    return totals;
  }

  function formatDuration(seconds) {
    const whole = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor((whole % 3600) / 60);
    if (hours === 0) return minutes + "m";
    return hours + "h " + String(minutes).padStart(2, "0") + "m";
  }

  function formatMoney(dollars) {
    return moneyFormat.format(dollars);
  }

  function roundMoney(dollars) {
    return Math.round((dollars + Number.EPSILON) * 100) / 100;
  }

  function readRate(raw) {
    if (raw === null || String(raw).trim() === "") return 0;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return 0;
    return value;
  }

  function dayStart(isoDate) {
    const parts = isoDate.slice(0, 10).split("-").map(Number);
    return Date.UTC(parts[0], parts[1] - 1, parts[2]);
  }

  function showcaseComponents(summaryJson) {
    return (summaryJson.components || []).filter(function (component) {
      return component.showcase;
    });
  }

  function selectedComponent() {
    const select = document.getElementById("component");
    const id = select.value;
    return showcaseComponents(summary).find(function (component) {
      return component.id === id;
    });
  }

  function publishedUptime(componentId) {
    const row = (showcase.values || []).find(function (value) {
      return value.component === componentId;
    });
    return row ? row.ninety : null;
  }

  function incidentCodes(componentId) {
    const timeline = showcase.timelines && showcase.timelines[componentId];
    const codes = [];
    const seen = new Set();
    const days = (timeline && timeline.days) || [];
    for (const day of days) {
      for (const event of day.related_events || []) {
        if (!seen.has(event.code)) {
          seen.add(event.code);
          codes.push(event.code);
        }
      }
    }
    for (const incident of summary.incidents || []) {
      const touched = (incident.components || []).some(function (component) {
        return component.id === componentId;
      });
      if (touched && !seen.has(incident.id)) {
        seen.add(incident.id);
        codes.push(incident.id);
      }
    }
    return { codes: codes, days: days };
  }

  async function getJson(path, signal) {
    const response = await fetch(STATUS_ORIGIN + path, {
      headers: { Accept: "application/json" },
      signal: signal,
    });
    if (!response.ok) {
      throw new Error("GitHub status returned " + response.status);
    }
    return response.json();
  }

  async function loadIncident(code, signal) {
    const payload = await getJson("/api/v2/incidents/" + code + ".json", signal);
    const incident = payload.incident;
    const previous = incidentCache.get(incident.id);
    if (!previous || (incident.updated_at || "") >= (previous.updated_at || "")) {
      incidentCache.set(incident.id, incident);
    }
    return incidentCache.get(incident.id);
  }

  async function refresh() {
    if (activeController) activeController.abort();
    const controller = new AbortController();
    activeController = controller;
    const signal = controller.signal;

    try {
      summary = await getJson("/api/v2/summary.json", signal);
      const components = showcaseComponents(summary);
      ensureComponentSelect(components);
      const component = selectedComponent();
      const ids = components.map(function (item) {
        return item.id;
      }).join(",");
      showcase = await getJson(
        "/uptime_showcase?components=" + encodeURIComponent(ids),
        signal
      );
      const bundle = incidentCodes(component.id);
      const incidents = await Promise.all(
        bundle.codes.map(function (code) {
          return loadIncident(code, signal);
        })
      );
      if (signal.aborted) return;

      const days = bundle.days;
      const windowStartMs = days.length ? dayStart(days[0].date) : Date.now() - 90 * 86400000;
      const fetchedAt = Date.now();
      const totals = accumulate(incidents, component.id, windowStartMs, fetchedAt);
      const rows = incidents
        .map(function (incident) {
          const solo = accumulate([incident], component.id, windowStartMs, fetchedAt);
          return {
            id: incident.id,
            name: incident.name,
            when: incident.started_at || incident.created_at,
            major: solo.major_outage,
            partial: solo.partial_outage,
            degraded: solo.degraded_performance,
          };
        })
        .filter(function (row) {
          return row.major + row.partial + row.degraded > 0;
        })
        .sort(function (a, b) {
          return a.when < b.when ? 1 : -1;
        });

      snapshot = {
        component: component,
        status: component.status,
        fetchedAt: fetchedAt,
        major: totals.major_outage,
        partial: totals.partial_outage,
        degraded: totals.degraded_performance,
        windowSeconds: (days.length || 90) * 86400,
        published: publishedUptime(component.id),
        rows: rows,
      };
      paintStatus();
      renderIncidents();
      paint(fetchedAt);
    } catch (error) {
      if (error.name === "AbortError") return;
      const line = document.getElementById("status-line");
      const message = error.message || "Could not reach GitHub's status page.";
      line.textContent = snapshot
        ? "Showing the last successful read. " + message
        : message;
    }
  }

  function preferredComponentId(components) {
    const params = new URLSearchParams(location.search);
    const wanted = params.get("component") || localStorage.getItem(STORAGE_COMPONENT) || "Actions";
    const byId = components.find(function (component) {
      return component.id === wanted;
    });
    if (byId) return byId.id;
    const byName = components.find(function (component) {
      return component.name.toLowerCase() === String(wanted).toLowerCase();
    });
    if (byName) return byName.id;
    return components[0].id;
  }

  function ensureComponentSelect(components) {
    const select = document.getElementById("component");
    const known = new Set(
      Array.from(select.options).map(function (option) {
        return option.value;
      })
    );
    const sameList =
      known.size === components.length &&
      components.every(function (component) {
        return known.has(component.id);
      });
    if (sameList && known.has(select.value)) return;

    const preferred = select.value || preferredComponentId(components);
    select.replaceChildren();
    for (const component of components) {
      const option = document.createElement("option");
      option.value = component.id;
      option.textContent = component.name;
      select.appendChild(option);
    }
    select.value = known.has(preferred) || components.some(function (component) {
      return component.id === preferred;
    })
      ? preferred
      : preferredComponentId(components);
  }

  function liveSeconds(now) {
    const extra = Math.max(0, (now - snapshot.fetchedAt) / 1000);
    const totals = {
      major: snapshot.major,
      partial: snapshot.partial,
      degraded: snapshot.degraded,
    };
    if (snapshot.status === "major_outage") totals.major += extra;
    else if (snapshot.status === "partial_outage") totals.partial += extra;
    else if (snapshot.status === "degraded_performance") totals.degraded += extra;
    return totals;
  }

  function paintStatus() {
    const pill = document.getElementById("status-pill");
    const line = document.getElementById("status-line");
    const name = snapshot.component.name;
    const status = snapshot.status;
    pill.dataset.state = status;
    pill.textContent = STATUS_LABEL[status] || status;
    if (status === "major_outage") {
      line.textContent = name + " is in a full outage. That clock is running.";
    } else if (status === "partial_outage") {
      line.textContent = name + " is in a partial outage. That time is adding to the degraded clock.";
    } else if (status === "degraded_performance") {
      line.textContent = name + " is degraded. That clock is running.";
    } else if (status === "under_maintenance") {
      line.textContent = name + " is in maintenance. Both clocks are holding at the 90-day total.";
    } else {
      line.textContent = name + " is operational. Both clocks are holding at the 90-day total.";
    }
    document.title = name + " downtime clock";
  }

  function renderIncidents() {
    const list = document.getElementById("incidents");
    list.replaceChildren();
    if (!snapshot.rows.length) {
      const item = document.createElement("li");
      item.className = "empty";
      item.textContent = "No incidents for this component in the window.";
      list.appendChild(item);
      return;
    }
    for (const row of snapshot.rows) {
      const item = document.createElement("li");
      item.className = "incident";
      const time = document.createElement("time");
      time.dateTime = row.when;
      time.textContent = new Date(row.when).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      });
      const link = document.createElement("a");
      link.href = STATUS_ORIGIN + "/incidents/" + row.id;
      link.textContent = row.name;
      const duration = document.createElement("span");
      duration.className = "duration";
      const parts = [];
      if (row.major) parts.push(formatDuration(row.major) + " full");
      if (row.partial) parts.push(formatDuration(row.partial) + " partial");
      if (row.degraded) parts.push(formatDuration(row.degraded) + " degraded");
      duration.textContent = parts.join(" · ");
      item.append(time, link, duration);
      list.appendChild(item);
    }
  }

  function setText(id, value) {
    if (rendered[id] === value) return;
    rendered[id] = value;
    document.getElementById(id).textContent = value;
  }

  function renderFrame() {
    if (snapshot) paint(Date.now());
    requestAnimationFrame(renderFrame);
  }

  function paint(now) {
    const totals = liveSeconds(now);
    const rate = readRate(document.getElementById("rate").value);
    const fullHours = totals.major / 3600;
    const degradedSeconds = totals.degraded + totals.partial;
    const degradedHours = degradedSeconds / 3600;
    const fullCost = roundMoney(fullHours * rate);
    const degradedCost = roundMoney(degradedHours * rate);

    setText("full-cost", formatMoney(fullCost));
    setText("full-hours", formatDuration(totals.major) + " major outage");
    setText("degraded-cost", formatMoney(degradedCost));
    setText("degraded-hours", formatDuration(degradedSeconds));
    setText(
      "degraded-split",
      formatDuration(totals.degraded) + " degraded · " + formatDuration(totals.partial) + " partial"
    );

    const combined = roundMoney(fullCost + degradedCost);
    setText(
      "combined",
      rate > 0 ? "Combined " + formatMoney(combined) : "Enter an hourly rate to price this window."
    );

    const counted = totals.major + totals.partial * 0.3;
    const countedUptime = (1 - counted / snapshot.windowSeconds) * 100;
    const inclusiveUptime = (1 - (totals.major + totals.partial + totals.degraded) / snapshot.windowSeconds) * 100;
    const published =
      snapshot.published === null ? countedUptime.toFixed(2) : Number(snapshot.published).toFixed(2);
    setText(
      "compare",
      "GitHub reports " +
        published +
        "% uptime for " +
        snapshot.component.name +
        " over these 90 days. Counting every degraded and partial minute, uptime is " +
        inclusiveUptime.toFixed(2) +
        "%."
    );

    document.getElementById("full-card").classList.toggle("ticking", snapshot.status === "major_outage");
    document.getElementById("degraded-card").classList.toggle(
      "ticking",
      snapshot.status === "degraded_performance" || snapshot.status === "partial_outage"
    );
  }

  function rememberRate() {
    const input = document.getElementById("rate");
    localStorage.setItem(STORAGE_RATE, input.value);
  }

  function start() {
    const params = new URLSearchParams(location.search);
    const rateInput = document.getElementById("rate");
    const fromQuery = params.get("rate");
    rateInput.value = fromQuery !== null ? fromQuery : localStorage.getItem(STORAGE_RATE) || DEFAULT_RATE;
    rateInput.addEventListener("input", rememberRate);

    document.getElementById("component").addEventListener("change", function (event) {
      localStorage.setItem(STORAGE_COMPONENT, event.target.value);
      refresh();
    });

    refresh();
    refreshTimer = setInterval(function () {
      if (!document.hidden) refresh();
    }, REFRESH_MS);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) refresh();
    });
    requestAnimationFrame(renderFrame);
  }

  const api = {
    accumulate: accumulate,
    formatDuration: formatDuration,
    formatMoney: formatMoney,
    readRate: readRate,
    worstStatus: worstStatus,
  };
  if (typeof globalThis !== "undefined") globalThis.DowntimeClock = api;

  if (typeof document !== "undefined") start();
})();
