/*
 * Impeccable CUA Driver — the view.
 *
 * This file never invents a driver, a ticket, a receipt or a conversation row. Every row it draws
 * came from the configured adapter, from an action the axis answered, or from this tab's own upload
 * response. A refusal is drawn by code, with the word the adapter used.
 *
 * Adapters:
 *   axis  — GET /api/axis/state, POST /api/axis/tickets, then POST the driver task adapter
 *   fleet — GET /v1/fleet, POST /v1/tasks with a bearer held in tab memory only
 *
 * Endpoints may be overridden with URL query parameters: adapter, state, tickets, tasks, uploads,
 * skills, activity, system, stars, civilians, driver. A bearer is never read from the URL and never
 * written to storage.
 */
(() => {
  "use strict";

  const q = (selector, root = document) => root.querySelector(selector);
  const qa = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const params = new URLSearchParams(location.search);
  const THEME_KEY = "impeccable.cua.theme";
  const REFRESH_MS = 5000;

  class Refusal extends Error {
    constructor(code, why, status) {
      super(code + (why ? " · " + why : ""));
      this.name = "Refusal";
      this.code = code;
      this.why = why || "";
      this.status = status || 0;
    }
  }

  function endpointsFor(adapter) {
    return adapter === "fleet"
      ? {
          state: "/v1/fleet", tickets: "", tasks: "/v1/tasks", uploads: "/v1/uploads",
          skills: "", activity: "", system: "/api/axis/system", stars: "/api/axis/stars",
          civilians: "/api/axis/civilians",
        }
      : {
          state: "/api/axis/state", tickets: "/api/axis/tickets", tasks: "/api/axis/tasks",
          uploads: "/api/axis/uploads", skills: "/api/axis/skills", activity: "/api/axis/activity",
          system: "/api/axis/system", stars: "/api/axis/stars", civilians: "/api/axis/civilians",
        };
  }

  const adapter = (params.get("adapter") || "axis").toLowerCase() === "fleet" ? "fleet" : "axis";
  const defaults = endpointsFor(adapter);
  const state = {
    adapter,
    endpoints: {
      state: params.get("state") || defaults.state,
      tickets: params.get("tickets") || defaults.tickets,
      tasks: params.get("tasks") || defaults.tasks,
      uploads: params.get("uploads") || defaults.uploads,
      skills: params.get("skills") || defaults.skills,
      activity: params.get("activity") || defaults.activity,
      system: params.get("system") || defaults.system,
      stars: params.get("stars") || defaults.stars,
      civilians: params.get("civilians") || defaults.civilians,
    },
    driver: params.get("driver") || "environment_driver",
    token: "",
    theme: localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark",
    drivers: [],
    activity: [],
    localActivity: [],
    skills: [],
    tasks: [],
    system: null,
    stars: null,
    civilians: null,
    axis: null,
    selected: null,
    connected: false,
    error: null,
    busy: false,
    announced: false,
    panel: "chat",
  };

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  };

  async function api(url, options = {}) {
    if (!url) throw new Refusal("endpoint-absent", "this adapter has no endpoint for that act");
    const headers = new Headers(options.headers || {});
    if (state.token) headers.set("authorization", "Bearer " + state.token);
    let response;
    try {
      response = await fetch(url, { ...options, headers, cache: "no-store" });
    } catch (error) {
      throw new Refusal("adapter-unreachable", String(error && error.message ? error.message : error));
    }
    const text = await response.text();
    let body = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { detail: text.slice(0, 300) };
      }
    }
    if (!response.ok) {
      const code = body.refused || (body.error && body.error.code) || "http-" + response.status;
      const why = body.why || (body.error && body.error.detail) || body.detail || "";
      throw new Refusal(code, why, response.status);
    }
    return body;
  }

  const safe = async (promise) => {
    try {
      return await promise;
    } catch (error) {
      return { __refused: error };
    }
  };

  // ---------------------------------------------------------------- readings

  function adopt(body) {
    if (state.adapter === "axis") {
      state.drivers = (Array.isArray(body.drivers) ? body.drivers : []).map((driver) => ({
        id: String(driver.id || ""),
        trusted: Boolean(driver.trusted),
        capabilities: Array.isArray(driver.capabilities) ? driver.capabilities.slice() : [],
        attestedUntil: Number(driver.attestedUntil) || 0,
        receipts: Number(driver.receipts) || 0,
        generation: driver.generation ?? null,
        last: null,
      }));
      state.axis = {
        schema: body.schema || "secure-shell.axis/63b0129a9a354ccfa21b74b17e4af1a3",
        tickets: Number(body.tickets) || 0,
        receipts: Number(body.receipts) || 0,
        refusals: Number(body.refusals) || 0,
      };
    } else {
      state.drivers = (Array.isArray(body.driver_rows) ? body.driver_rows : []).map((driver) => ({
        id: String(driver.driver || ""),
        trusted: Boolean(driver.trusted),
        capabilities: Array.isArray(driver.capabilities) ? driver.capabilities.slice() : [],
        attestedUntil: 0,
        receipts: Number(driver.receipts) || 0,
        generation: driver.generation ?? null,
        last: driver.last_receipt || null,
      }));
      state.axis = {
        schema: body.schema || "cua.fleet.summary/2975721bba429d4f123977ab18fe5587",
        tickets: 0,
        receipts: Number(body.receipts) || 0,
        refusals: Number(body.declined) || 0,
      };
    }
    if (!state.drivers.some((driver) => driver.id === state.selected)) {
      state.selected = state.drivers.length ? state.drivers[0].id : null;
    }
  }

  async function load() {
    const stateAnswer = await safe(api(state.endpoints.state));
    if (stateAnswer.__refused) {
      state.connected = false;
      state.error = stateAnswer.__refused;
    } else {
      state.connected = true;
      state.error = null;
      adopt(stateAnswer);
    }

    const [activity, skills, system, stars, civilians, tasks] = await Promise.all([
      state.endpoints.activity ? safe(api(state.endpoints.activity)) : Promise.resolve(null),
      state.endpoints.skills ? safe(api(state.endpoints.skills)) : Promise.resolve(null),
      state.endpoints.system ? safe(api(state.endpoints.system)) : Promise.resolve(null),
      state.endpoints.stars ? safe(api(state.endpoints.stars)) : Promise.resolve(null),
      state.endpoints.civilians ? safe(api(state.endpoints.civilians)) : Promise.resolve(null),
      state.adapter === "fleet" && state.endpoints.tasks
        ? safe(api(state.endpoints.tasks))
        : Promise.resolve(null),
    ]);

    if (activity && Array.isArray(activity.activity)) state.activity = activity.activity;
    else if (tasks && Array.isArray(tasks.tasks)) {
      state.activity = tasks.tasks.map((task) => ({
        kind: "task",
        at: "",
        driver: state.driver,
        action: task.tool || "task",
        detail: (task.status || "unknown") + " · " + (task.task_id || task.call_id || ""),
      }));
    }
    if (tasks && Array.isArray(tasks.tasks)) state.tasks = tasks.tasks;
    if (system && !system.__refused) state.system = system;
    if (stars && !stars.__refused) state.stars = stars;
    if (civilians && !civilians.__refused) state.civilians = civilians;
    if (skills && Array.isArray(skills.skills)) state.skills = skills.skills;
    else state.skills = deriveSkills();

    renderAll();
    if (!state.announced) {
      state.announced = true;
      if (state.connected) {
        addTurn("system", "connected · " + state.adapter + " · " + state.drivers.length +
          " system" + (state.drivers.length === 1 ? "" : "s") + " · " + state.axis.schema);
      } else {
        addTurn("system", "refused · " + (state.error ? state.error.code : "adapter-unreachable") +
          (state.error && state.error.why ? " · " + state.error.why : ""));
      }
      if (state.connected) {
        addTurn("system", "no conversation yet · a task goes to " + state.driver +
          " under an axis ticket");
      }
    }
  }

  function deriveSkills() {
    const map = new Map();
    for (const driver of state.drivers) {
      for (const capability of driver.capabilities) {
        const row = map.get(capability) || {
          id: capability, drivers: [], trusted: 0, state: "unverified", source: "driver declaration",
        };
        row.drivers.push(driver.id);
        if (driver.trusted) row.trusted += 1;
        map.set(capability, row);
      }
    }
    return Array.from(map.values())
      .map((row) => ({ ...row, state: row.trusted > 0 ? "present" : "unverified" }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  // ---------------------------------------------------------------- rendering

  function driver() {
    return state.drivers.find((item) => item.id === state.selected) || null;
  }

  function indexOfDriver(id) {
    return state.drivers.findIndex((item) => item.id === id);
  }

  function mergedActivity() {
    const rows = state.localActivity.concat(state.activity);
    return rows.slice(0, 50);
  }

  function renderAll() {
    renderSystems();
    renderCard();
    renderHeader();
    renderActivity();
    renderFooter();
    renderLauncher();
    if (state.panel !== "chat") renderDrawer();
  }

  function renderSystems() {
    const host = q("#systems");
    host.replaceChildren();
    q("#system-count").textContent = String(state.drivers.length);
    if (!state.drivers.length) {
      host.append(el("p", "empty", "no CUA registered"));
      return;
    }
    state.drivers.forEach((item, index) => {
      const button = el("button", "system" + (item.id === state.selected ? " selected" : ""));
      button.type = "button";
      button.dataset.id = item.id;
      const idx = el("span", "sys-index", "System " + (index + 1));
      const name = el("span", "sys-name", item.id);
      const word = el("span", "sys-word" + (item.trusted ? "" : " lapsed"),
        item.trusted ? "trusted" : "lapsed");
      button.append(idx, name, word);
      button.addEventListener("click", () => {
        state.selected = item.id;
        renderSystems();
        renderCard();
        renderHeader();
      });
      host.append(button);
    });
  }

  function lastActionFor(id) {
    const row = mergedActivity().find((item) => item.driver === id);
    if (!row) return "none";
    return (row.action || row.kind || "activity") + " · " + (row.detail || "");
  }

  function renderCard() {
    const item = driver();
    q("#card-kicker").textContent = item ? "System " + (indexOfDriver(item.id) + 1) : "System";
    const stateWord = q("#card-state");
    stateWord.className = "state-word" + (item ? (item.trusted ? "" : " lapsed") : " unknown");
    stateWord.textContent = item ? (item.trusted ? "trusted" : "lapsed") : "unknown";
    q("#card-name").textContent = item ? item.id : "no CUA selected";

    let uptime = "unknown";
    if (item && item.attestedUntil) {
      const left = item.attestedUntil - Date.now();
      uptime = left > 0 ? "attested " + Math.ceil(left / 60000) + "m" : "attestation lapsed";
    }
    q("#fact-uptime").textContent = uptime;
    q("#fact-action").textContent = item ? lastActionFor(item.id) : "none";
    const rows = item
      ? mergedActivity().filter((row) => row.driver === item.id).length + item.receipts
      : 0;
    q("#fact-journal").textContent = rows + (rows === 1 ? " row" : " rows");
  }

  function renderHeader() {
    const item = driver();
    q("#chat-title").textContent = item
      ? "System " + (indexOfDriver(item.id) + 1) + " CUA"
      : "CUA Driver";
    q("#chat-target").textContent = state.driver;
    q("#adapter-badge").textContent = state.adapter;
    const connection = q("#connection");
    connection.dataset.state = state.connected ? "live" : "refused";
    const word = q("span", connection);
    word.textContent = state.connected ? "live" : (state.error ? state.error.code : "refused");
    q("#composer-hint").textContent = state.adapter === "axis"
      ? "axis ticket → driver task"
      : "fleet task adapter";
  }

  function renderActivity() {
    const host = q("#activity-list");
    host.replaceChildren();
    const rows = mergedActivity().slice(0, 5);
    if (!rows.length) {
      host.append(el("li", "empty", "no live activity yet"));
      return;
    }
    for (const row of rows) {
      const item = el("li");
      const kind = el("span", "act-kind " + (row.kind || ""), row.kind || "row");
      const body = el("span", "act-body",
        (row.driver ? row.driver + " · " : "") + (row.action || "") +
        (row.detail ? " · " + row.detail : ""));
      item.append(kind, body);
      host.append(item);
    }
  }

  function renderFooter() {
    const system = state.system || {};
    const version = system.version || "version unknown";
    const host = system.host || "host unknown";
    q("#version").textContent = version + " · " + host;

    const starsHost = q("#stars");
    starsHost.replaceChildren();
    const contract = state.stars && state.stars.contract ? state.stars.contract : null;
    const count = contract && Number(contract.axisCount) ? Number(contract.axisCount) : 9;
    const ladders = contract && contract.ladders ? Object.keys(contract.ladders) : [];
    for (let index = 0; index < count; index += 1) {
      const star = el("span", "star" + (contract ? "" : " absent"));
      star.innerHTML = '<svg class="icon icon-star" aria-hidden="true" focusable="false"><use href="#i-star"></use></svg>';
      star.title = ladders[index] || "axis ladder " + (index + 1);
      starsHost.append(star);
    }
    starsHost.setAttribute("aria-label", count + " axis ladders");

    const civilians = state.civilians && !state.civilians.__refused
      ? state.civilians
      : (system.civilians || null);
    const shield = q("#shield");
    const score = q("#shield-score");
    if (civilians && typeof civilians.score === "number") {
      shield.dataset.band = civilians.band || "red";
      score.textContent = "civilians " + civilians.score + " · " + (civilians.band || "red");
      shield.title = civiliansTooltip(civilians);
    } else {
      shield.dataset.band = "unknown";
      score.textContent = "civilians unknown";
      shield.title = "the axis did not return a civilians measurement";
    }
    q("#foot-mode").textContent = state.connected
      ? state.adapter + " · " + (state.axis ? state.axis.schema : "connected")
      : "disconnected";
  }

  function civiliansTooltip(civilians) {
    const parts = Array.isArray(civilians.components) ? civilians.components : [];
    return "civilians " + civilians.score + "/100 (" + (civilians.band || "red") + ")\n" +
      parts.map((part) => part.id + " " + Math.round(part.value * 100) + "% · " + part.detail).join("\n");
  }

  // ---------------------------------------------------------------- transcript

  function scrollTranscript() {
    const transcript = q("#transcript");
    transcript.scrollTop = transcript.scrollHeight;
  }

  function addTurn(kind, text) {
    const turn = el("div", "turn " + kind);
    turn.append(el("div", "who", kind === "user" ? "you" : kind));
    turn.append(el("p", "said", text));
    q("#transcript").append(turn);
    scrollTranscript();
    return turn;
  }

  function addToolCard(target, goal) {
    const card = el("div", "turn tool");
    card.dataset.state = "pending";
    card.append(el("div", "who", "tool call"));
    const head = el("div", "tool-head");
    head.append(el("code", "", "cua_delegate"), el("span", "arrow", "→"), el("b", "", target));
    card.append(head);
    const receipt = el("p", "tool-receipt", "waiting for the axis…");
    card.append(receipt);
    q("#transcript").append(card);
    scrollTranscript();
    return {
      ticket(ticket) {
        receipt.textContent = "ticket " + ticket.id + " · " + ticket.action + " · " + ticket.scope;
      },
      ok(task) {
        card.dataset.state = "ok";
        const id = task.task_id || task.call_id || "accepted";
        receipt.textContent = "receipt " + id + " · " + (task.status || "ok") +
          (task.code ? " · " + task.code : "") + " · " + (goal || "").slice(0, 80);
        scrollTranscript();
      },
      refuse(error) {
        card.dataset.state = "refused";
        receipt.textContent = "refused " + error.code + (error.why ? " · " + error.why : "") +
          (error.status ? " · http " + error.status : "");
        scrollTranscript();
      },
    };
  }

  // ---------------------------------------------------------------- send

  async function send(text) {
    const said = text.trim();
    if (!said || state.busy) return;
    state.busy = true;
    q("#send").disabled = true;
    addTurn("user", said);
    const card = addToolCard(state.driver, said);
    try {
      let ticket = null;
      if (state.adapter === "axis") {
        const target = state.drivers.find((item) => item.id === state.driver) || driver();
        if (!target) {
          throw new Refusal("driver-unknown", "no CUA is registered; use Add CUA first");
        }
        const action = target.capabilities.includes("cua_delegate")
          ? "cua_delegate"
          : target.capabilities[0];
        if (!action) throw new Refusal("ticket-action", target.id + " declares no capability");
        const answer = await api(state.endpoints.tickets, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ driver: target.id, action }),
        });
        ticket = answer.ticket;
        card.ticket(ticket);
      }
      if (!state.endpoints.tasks) throw new Refusal("endpoint-absent", "no driver task endpoint is configured");
      const stamp = Date.now().toString(36);
      const task = await api(state.endpoints.tasks, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          call_id: "cua-" + stamp,
          tool: "agent.delegate",
          task: {
            agent: state.driver,
            goal: said,
            task: said,
            idempotency_key: "cua:" + stamp,
          },
        }),
      });
      card.ok(task);
      state.localActivity.unshift({
        kind: "delegation",
        at: new Date().toISOString(),
        driver: state.driver,
        action: "cua_delegate",
        detail: (task.task_id || task.call_id || "accepted") + (ticket ? " · " + ticket.id : ""),
      });
    } catch (error) {
      const refusal = error instanceof Refusal ? error : new Refusal("client-error", String(error));
      card.refuse(refusal);
      state.localActivity.unshift({
        kind: "refusal",
        at: new Date().toISOString(),
        driver: state.driver,
        action: "cua_delegate",
        detail: refusal.code + (refusal.why ? " · " + refusal.why : ""),
      });
    } finally {
      state.busy = false;
      q("#send").disabled = false;
      renderActivity();
      renderCard();
    }
  }

  // ---------------------------------------------------------------- drawer

  const PANEL_TITLES = {
    tasks: "Tasks", status: "Status", tools: "Tools", agents: "Agents",
    journal: "Journal", skills: "Skills", settings: "Settings",
  };

  function readout(rows) {
    const dl = el("dl", "readout");
    for (const [term, value] of rows) {
      const row = el("div");
      row.append(el("dt", "", term), el("dd", "", value));
      dl.append(row);
    }
    return dl;
  }

  function rowList(rows) {
    const list = el("ul", "row-list");
    if (!rows.length) {
      list.append(el("li", "", "nothing to read"));
      return list;
    }
    for (const [title, detail] of rows) {
      const item = el("li");
      item.append(el("b", "", title), el("span", "", detail ? " · " + detail : ""));
      list.append(item);
    }
    return list;
  }

  function heading(text) {
    return el("h3", "", text);
  }

  function openPanel(name) {
    state.panel = name;
    qa(".rail-row[data-panel]").forEach((button) => {
      const on = button.dataset.panel === name;
      button.classList.toggle("active", on);
      if (on) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    if (name === "chat") {
      q("#drawer").hidden = true;
      return;
    }
    q("#drawer").hidden = false;
    renderDrawer();
  }

  function renderDrawer() {
    const panel = state.panel;
    if (panel === "chat") return;
    q("#drawer-title").textContent = PANEL_TITLES[panel] || "Panel";
    const body = q("#drawer-body");
    body.replaceChildren();

    if (panel === "tasks") {
      body.append(heading("Axis"));
      body.append(readout([
        ["adapter", state.adapter],
        ["tickets issued", String(state.axis ? state.axis.tickets : 0)],
        ["receipts", String(state.axis ? state.axis.receipts : 0)],
        ["refusals", String(state.axis ? state.axis.refusals : 0)],
        ["task endpoint", state.endpoints.tasks || "absent"],
      ]));
      body.append(heading("Task rows"));
      body.append(rowList(state.tasks.map((task) => [
        task.task_id || task.call_id || "task",
        (task.status || "unknown") + (task.tool ? " · " + task.tool : ""),
      ])));
    }

    if (panel === "status") {
      const civilians = state.civilians && typeof state.civilians.score === "number" ? state.civilians : null;
      body.append(heading("Connection"));
      body.append(readout([
        ["adapter", state.adapter],
        ["state", state.connected ? "live" : "refused"],
        ["schema", state.axis ? state.axis.schema : "unknown"],
        ["state endpoint", state.endpoints.state],
        ["systems", String(state.drivers.length)],
      ]));
      body.append(heading("Civilians"));
      if (civilians) {
        body.append(readout([
          ["score", civilians.score + " / 100"],
          ["band", civilians.band || "red"],
          ["state", civilians.state || "present"],
        ]));
        body.append(rowList((civilians.components || []).map((part) => [
          part.id,
          Math.round(part.value * 100) + "% of " + part.weight + " · " + part.detail,
        ])));
      } else {
        body.append(el("p", "note", "the axis returned no civilians measurement"));
      }
    }

    if (panel === "tools") {
      body.append(heading("Client acts"));
      body.append(rowList([
        ["cua_delegate", state.endpoints.tasks ? "configured · " + state.endpoints.tasks : "endpoint absent"],
        ["ticket", state.endpoints.tickets ? "configured · " + state.endpoints.tickets : "endpoint absent"],
        ["upload", state.endpoints.uploads ? "configured · " + state.endpoints.uploads : "endpoint absent"],
        ["add-cua", state.adapter === "axis" ? "wish · /api/axis/drivers" : "axis adapter only"],
      ]));
      body.append(heading("Refusals this view can draw"));
      body.append(rowList([
        ["driver-unknown", "no CUA is registered"],
        ["ticket-*", "the axis refused the ticket by code"],
        ["adapter-unreachable", "the configured endpoint did not answer"],
      ]));
    }

    if (panel === "agents") {
      body.append(heading("Registered CUAs"));
      body.append(rowList(state.drivers.map((item) => [
        item.id,
        (item.trusted ? "trusted" : "lapsed") + " · " + item.capabilities.length + " capabilities" +
          (item.receipts ? " · " + item.receipts + " receipts" : ""),
      ])));
      body.append(heading("Capabilities"));
      body.append(rowList(state.skills.map((skill) => [
        skill.id, skill.state + " · " + (skill.drivers || []).join(", "),
      ])));
    }

    if (panel === "journal") {
      const rows = mergedActivity();
      body.append(heading("Activity"));
      body.append(rowList(rows.map((row) => [
        (row.kind || "row") + " · " + (row.driver || "axis"),
        (row.action || "") + (row.detail ? " · " + row.detail : ""),
      ])));
    }

    if (panel === "skills") {
      body.append(heading("Declared skills"));
      body.append(el("p", "note", "Each row is a capability a registered driver declared. The axis does not grant it; a ticket for it is still required."));
      body.append(rowList(state.skills.map((skill) => [
        skill.id,
        skill.state + " · " + (skill.drivers || []).join(", ") + " · " + (skill.source || ""),
      ])));
    }

    if (panel === "settings") renderSettings(body);
  }

  function field(labelText, input) {
    const label = el("label", "", labelText);
    label.append(input);
    return label;
  }

  function renderSettings(body) {
    const form = el("form", "form-grid");
    const theme = document.createElement("select");
    for (const value of ["dark", "light"]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      if (state.theme === value) option.selected = true;
      theme.append(option);
    }
    const adapterSelect = document.createElement("select");
    for (const value of ["axis", "fleet"]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      if (state.adapter === value) option.selected = true;
      adapterSelect.append(option);
    }
    const driverInput = document.createElement("input");
    driverInput.value = state.driver;
    const inputs = {};
    for (const key of ["state", "tickets", "tasks", "uploads", "skills", "activity", "system", "stars"]) {
      const input = document.createElement("input");
      input.value = state.endpoints[key] || "";
      input.placeholder = key === "tickets" && state.adapter === "fleet" ? "(not used by fleet)" : "";
      inputs[key] = input;
    }
    const token = document.createElement("input");
    token.type = "password";
    token.autocomplete = "off";
    token.placeholder = state.token ? "held in this tab" : "not set";

    form.append(
      field("Theme", theme), field("Adapter", adapterSelect), field("Task target", driverInput),
      field("State endpoint", inputs.state), field("Ticket endpoint", inputs.tickets),
      field("Task endpoint", inputs.tasks), field("Upload endpoint", inputs.uploads),
      field("Skills endpoint", inputs.skills), field("Activity endpoint", inputs.activity),
      field("System endpoint", inputs.system), field("Stars endpoint", inputs.stars),
      field("Driver bearer", token),
    );
    const actions = el("div", "form-actions");
    const apply = el("button", "send", "Apply");
    apply.type = "submit";
    actions.append(apply);
    form.append(actions);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      applyTheme(theme.value);
      state.adapter = adapterSelect.value;
      state.driver = driverInput.value.trim() || "environment_driver";
      for (const key of Object.keys(inputs)) state.endpoints[key] = inputs[key].value.trim();
      state.token = token.value;
      openPanel("chat");
      q("#adapter-badge").textContent = state.adapter;
      q("#chat-target").textContent = state.driver;
      load();
    });
    body.append(form);
    body.append(el("p", "note", "A bearer is held in this tab's memory only: it is never written to localStorage, sessionStorage, a URL or a file. The axis proxy holds the Debian-side driver token in its own environment."));

    body.append(heading("Other harnesses"));
    body.append(el("p", "note", "A harness reaches the selected CUA through the driver's OpenAI-compatible completions route. Use the bearer your Debian operator installed; it is not the browser's."));
    const base = (state.system && state.system.driverUrl) || "http://127.0.0.1:8790";
    const recipe = el("pre", "recipe",
      "curl -s " + base + "/v1/chat/completions \\\n" +
      "  -H \"authorization: Bearer $CUA_TOKEN\" \\\n" +
      "  -H \"content-type: application/json\" \\\n" +
      "  -d '{\"messages\":[{\"role\":\"user\",\"content\":\"observe the desktop\"}]}'");
    body.append(recipe);
    body.append(el("p", "note", "Tools: GET " + base + "/v1/tools · Fleet: GET " + base + "/v1/fleet · Tasks: POST " + base + "/v1/tasks"));
  }

  // ---------------------------------------------------------------- apps launcher

  function applicationRows() {
    return [
      { label: "Axis console", note: "legacy /axis", run: () => window.open("/axis", "_blank", "noopener") },
      { label: "Axis state", note: "live json", run: () => window.open(state.endpoints.state, "_blank", "noopener") },
      { label: "Skills", note: "panel", run: () => openPanel("skills") },
      { label: "Stars", note: "6 stars / 9 ladders", run: () => window.open(state.endpoints.stars, "_blank", "noopener") },
      { label: "Civilians", note: "score", run: () => openPanel("status") },
      { label: "World", note: "observations", run: () => window.open("/api/axis/world", "_blank", "noopener") },
    ];
  }

  function renderLauncher() {
    const grid = q("#apps-grid");
    grid.replaceChildren();
    for (const app of applicationRows()) {
      const button = el("button", "app-tile");
      button.type = "button";
      button.append(el("b", "", app.label), el("span", "", app.note));
      button.addEventListener("click", () => {
        closeLauncher();
        app.run();
      });
      grid.append(button);
    }
    q("#launcher-state").textContent = state.adapter + " · " + state.drivers.length + " systems";
  }

  function openLauncher() {
    q("#apps-launcher").hidden = false;
    q("#apps").setAttribute("aria-expanded", "true");
  }

  function closeLauncher() {
    q("#apps-launcher").hidden = true;
    q("#apps").setAttribute("aria-expanded", "false");
  }

  // ---------------------------------------------------------------- theme and controls

  function applyTheme(theme) {
    state.theme = theme === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = state.theme;
    localStorage.setItem(THEME_KEY, state.theme);
    q("#theme-toggle").textContent = state.theme === "dark" ? "Light mode" : "Dark mode";
  }

  function setUpload(text, refused) {
    const node = q("#upload-state");
    node.textContent = text;
    node.classList.toggle("refused", Boolean(refused));
  }

  async function upload(file) {
    if (!file) return;
    setUpload("uploading " + file.name + "…");
    try {
      const headers = new Headers({
        "content-type": file.type || "application/octet-stream",
        "x-filename": file.name,
      });
      if (state.token) headers.set("authorization", "Bearer " + state.token);
      const response = await fetch(state.endpoints.uploads, { method: "POST", headers, body: file });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Refusal(body.refused || (body.error && body.error.code) || "http-" + response.status,
          body.why || (body.error && body.error.detail) || "");
      }
      const record = body.upload || body;
      setUpload(record.name + " · " + record.bytes + " B", false);
      state.localActivity.unshift({
        kind: "upload",
        at: new Date().toISOString(),
        driver: state.driver,
        action: "upload",
        detail: record.name + " · " + String(record.sha256 || "").slice(0, 19),
      });
      renderActivity();
      renderCard();
    } catch (error) {
      const refusal = error instanceof Refusal ? error : new Refusal("upload-failed", String(error));
      setUpload(refusal.code + " · " + refusal.why, true);
    }
  }

  function wireMic() {
    const button = q("#mic");
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      button.title = "speech is not available in this runtime";
      button.addEventListener("click", () => setUpload("speech-unavailable", true));
      return;
    }
    const recognition = new Recognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = document.documentElement.lang || "en";
    let listening = false;
    recognition.addEventListener("result", (event) => {
      const text = Array.from(event.results).map((row) => row[0].transcript).join(" ").trim();
      if (!text) return;
      const message = q("#message");
      message.value = (message.value ? message.value + " " : "") + text;
      message.focus();
    });
    recognition.addEventListener("end", () => {
      listening = false;
      button.classList.remove("live");
    });
    recognition.addEventListener("error", (event) => {
      listening = false;
      button.classList.remove("live");
      setUpload("speech-" + (event.error || "error"), true);
    });
    button.addEventListener("click", () => {
      if (listening) {
        recognition.stop();
        return;
      }
      try {
        recognition.start();
        listening = true;
        button.classList.add("live");
        setUpload("listening…", false);
      } catch (error) {
        setUpload("speech-" + String(error && error.message ? error.message : error), true);
      }
    });
  }

  function wire() {
    q("#theme-toggle").addEventListener("click", () => {
      applyTheme(state.theme === "dark" ? "light" : "dark");
      if (state.panel === "settings") renderDrawer();
    });

    qa(".rail-row[data-panel]").forEach((button) => {
      button.addEventListener("click", () => openPanel(button.dataset.panel));
    });
    q("#drawer-close").addEventListener("click", () => openPanel("chat"));

    q("#composer").addEventListener("submit", (event) => {
      event.preventDefault();
      const message = q("#message");
      const text = message.value;
      message.value = "";
      send(text);
    });
    q("#message").addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        q("#composer").requestSubmit();
      }
    });

    q("#attach").addEventListener("click", () => q("#upload-input").click());
    q("#upload-input").addEventListener("change", (event) => {
      const file = event.target.files && event.target.files[0];
      event.target.value = "";
      upload(file);
    });
    q("#book").addEventListener("click", () => openPanel("skills"));
    q("#file").addEventListener("click", () => openPanel("tools"));
    wireMic();

    const dialog = q("#register-dialog");
    q("#add-cua").addEventListener("click", () => {
      q("#register-refusal").hidden = true;
      dialog.showModal();
    });
    q("#register-cancel").addEventListener("click", () => dialog.close());
    q("#register-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.target;
      const data = new FormData(form);
      const refusal = q("#register-refusal");
      if (state.adapter !== "axis") {
        refusal.hidden = false;
        refusal.textContent = "register-route-absent · the fleet adapter has no register route";
        return;
      }
      const id = String(data.get("id") || "").trim();
      const revision = String(data.get("revision") || "").trim();
      const capabilities = String(data.get("capabilities") || "")
        .split(",").map((item) => item.trim()).filter(Boolean);
      const verifier = String(data.get("verifier") || "").trim();
      const minutes = Number(data.get("minutes") || 60);
      try {
        await api("/api/axis/drivers", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, kind: "cua-node", revision, capabilities }),
        });
        await api("/api/axis/attest", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ driver: id, verifier, expiresAt: Date.now() + minutes * 60000 }),
        });
        form.reset();
        dialog.close();
        refusal.hidden = true;
        await load();
      } catch (error) {
        refusal.hidden = false;
        refusal.textContent = error.code + (error.why ? " · " + error.why : "");
      }
    });

    q("#apps").addEventListener("click", (event) => {
      event.stopPropagation();
      if (q("#apps-launcher").hidden) openLauncher();
      else closeLauncher();
    });
    document.addEventListener("click", (event) => {
      if (q("#apps-launcher").hidden) return;
      if (!q("#apps-launcher").contains(event.target) && event.target !== q("#apps")) closeLauncher();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !q("#apps-launcher").hidden) closeLauncher();
    });
  }

  applyTheme(state.theme);
  wire();
  renderAll();
  load();
  setInterval(() => {
    if (!document.hidden) load();
  }, REFRESH_MS);
})();
