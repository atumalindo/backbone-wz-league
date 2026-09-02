const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const DISCORD_TOK_KEY = "tournament_discord_token";
const PREFS_KEY = "tournament_ui_prefs";
const DRAFT_KEY = "tournament_form_draft";
const DEFAULT_TOURNAMENT_IMAGE = "https://i.postimg.cc/MH16zg2N/image.png";

const state = {
  meta: null,
  tournaments: [],
  history: [],
  templates: [],
  listFilter: "active",
  editingId: null,
  user: null, // { id, username, avatar }
  pollTimer: null,
  bracketTournamentId: null,
};

const STATUS_BADGE = {
  0: ["Não iniciado", "badge-closed"],
  1: ["Inscrições abertas", "badge-open"],
  2: ["Inscrições fechadas", "badge-closed"],
  3: ["Finalizado", "badge-done"],
  4: ["Cancelado", "badge-cancel"],
  5: ["Em andamento", "badge-run"],
  [-1]: ["—", "badge-done"],
};

function getDiscordTok() {
  return localStorage.getItem(DISCORD_TOK_KEY) || "";
}
function setDiscordTok(t) {
  if (t) localStorage.setItem(DISCORD_TOK_KEY, t);
  else localStorage.removeItem(DISCORD_TOK_KEY);
}

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
  } catch {
    return {};
  }
}
function savePrefs(partial) {
  const p = { ...loadPrefs(), ...partial };
  localStorage.setItem(PREFS_KEY, JSON.stringify(p));
}

function saveDraft() {
  if (state.editingId) return;
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(formPayload()));
  } catch {}
}
function loadDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
    if (d && typeof d === "object") fillFormFromData(d);
  } catch {}
}
function clearDraft() {
  localStorage.removeItem(DRAFT_KEY);
}

async function api(path, opts = {}) {
  let res;
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  const tok = getDiscordTok();
  if (tok) headers.Authorization = "Bearer " + tok;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    res = await fetch(path, {
      headers,
      cache: "no-store",
      signal: controller.signal,
      ...opts,
    });
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Servidor demorou demais para responder (timeout)");
    throw new Error("Servidor offline");
  } finally {
    clearTimeout(timeoutId);
  }
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error("Resposta inválida");
  }
  if (res.status === 401 && data.needLogin) {
    setDiscordTok("");
    state.user = null;
    updateUserUI();
    throw new Error("Faça login com Discord");
  }
  if (!res.ok) throw new Error(data.error || data.message || "Erro " + res.status);
  return data;
}

function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 3200);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function requireLogin() {
  if (state.user) return true;
  toast("Faça login com Discord para essa ação", true);
  return false;
}

function updateUserUI() {
  const box = $("#user-box");
  const btnLogin = $("#btn-discord-login");
  const hint = $("#login-hint");
  if (state.user) {
    box.hidden = false;
    btnLogin.hidden = true;
    btnLogin.style.display = "none";
    if (hint) { hint.hidden = true; hint.style.display = "none"; }
    $("#user-name").textContent = state.user.username || "User";
    const creditChip = $("#credits-chip");
    if (creditChip) {
      creditChip.textContent = state.user.isAdmin ? "Administrador · criação ilimitada" : `Créditos: ${state.user.tournamentCredits ?? 0}`;
      creditChip.classList.toggle("unlimited", !!state.user.isAdmin);
    }
    const av = $("#user-avatar");
    if (state.user.avatar) {
      av.src = state.user.avatar;
      av.hidden = false;
    } else {
      av.hidden = true;
    }
  } else {
    box.hidden = true;
    btnLogin.hidden = false;
    btnLogin.style.display = "block";
    if (hint) { hint.hidden = false; hint.style.display = "block"; }
  }
  updateAuthGate();
}

// Login com Discord é obrigatório: sem login, o site fica bloqueado atrás
// de um overlay e nada pode ser usado (só a tela de login).
function updateAuthGate() {
  const gate = $("#auth-gate");
  if (!gate) return;
  const locked = !state.user;
  gate.hidden = !locked;
  document.body.classList.toggle("gate-locked", locked);
}

async function checkAuth() {
  const tok = getDiscordTok();
  if (!tok) {
    state.user = null;
    updateUserUI();
    return;
  }
  try {
    const me = await api("/api/auth/me");
    if (me.authenticated) {
      state.user = { id: me.id, username: me.username, avatar: me.avatar, isAdmin: !!me.isAdmin, canCreateUnlimited: !!me.canCreateUnlimited, tournamentCredits: me.tournamentCredits };
    } else {
      setDiscordTok("");
      state.user = null;
    }
  } catch {
    setDiscordTok("");
    state.user = null;
  }
  updateUserUI();
}

function handleOAuthReturn() {
  const params = new URLSearchParams(location.search);
  const tok = params.get("discord_token");
  const err = params.get("discord_error");
  const detail = params.get("discord_error_detail") || "";
  if (tok) {
    setDiscordTok(tok);
    history.replaceState({}, "", location.pathname);
    toast("Login Discord ok");
  }
  if (err) {
    const map = {
      not_in_server: "Você precisa estar no servidor Discord configurado (Guild ID)",
      not_allowed: "Seu Discord não está na lista de IDs permitidos",
      missing_role: "Você não tem o cargo Discord necessário",
      roles_unreadable: "Não foi possível ler seus cargos. Remova cargos obrigatórios em /admin ou peça o scope guilds.members.read",
      token: "Falha ao trocar o código OAuth (redirect URI ou Client Secret errados)",
      no_secret: "Client Secret não está salvo no /admin",
      user: "Não foi possível obter seu usuário Discord",
      no_code: "Código OAuth ausente — tente de novo",
      access_denied: "Você cancelou o login no Discord",
      invalid_scope: "Scope inválido — limpe Guild ID e cargos em /admin e tente só com identify",
      invalid_state: "Sessão OAuth inválida ou expirada — tente novamente",
      server: "Erro no servidor durante o login",
    };
    let msg = map[err] || String(err);
    if (detail) msg += " — " + detail;
    $("#discord-error-text").textContent = msg;
    $("#discord-error").hidden = false;
    const gateErr = $("#gate-error");
    if (gateErr) {
      gateErr.textContent = msg;
      gateErr.hidden = false;
    }
    history.replaceState({}, "", location.pathname);
    console.error("[discord login]", err, detail);
  }
}

$("#btn-dismiss-err")?.addEventListener("click", () => {
  $("#discord-error").hidden = true;
});

$("#btn-logout")?.addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch {}
  setDiscordTok("");
  state.user = null;
  updateUserUI();
  toast("Desconectado");
});

function switchView(name) {
  $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  $$(".view").forEach((v) => (v.hidden = v.id !== "view-" + name));
  savePrefs({ lastView: name });
  // Login com Discord é obrigatório — sem login não busca nem mostra nada.
  if (!state.user) {
    const msg = `<tr><td colspan="7" class="empty">Faça login com Discord para ver os torneios</td></tr>`;
    if (name === "list") { const b = $("#tournaments-body"); if (b) b.innerHTML = msg; }
    if (name === "history") { const b = $("#history-body"); if (b) b.innerHTML = msg; }
    return;
  }
  if (name === "list") {
    state.listFilter = "active";
    loadTournaments("active");
  }
  if (name === "history") loadTournaments("history");
  if (name === "calendar") loadCalendar();
  if (name === "ranking") loadRanking();
  if (name === "create") {
    if (!state.editingId) {
      resetForm();
      loadDraft();
    }
  }
  if (name === "templates") loadTemplates();
}

$$(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.view === "create") {
      if (!requireLogin()) return;
      state.editingId = null;
    }
    if (btn.dataset.view === "templates" && !requireLogin()) return;
    switchView(btn.dataset.view);
  });
});

$("#btn-new-from-list")?.addEventListener("click", () => {
  if (!requireLogin()) return;
  state.editingId = null;
  switchView("create");
});

async function loadMeta() {
  state.meta = await api("/api/meta");
  $("#setup-banner").hidden = !state.meta.needSetup;

  const coverLink = $("#cover-tool-link");
  if (coverLink) {
    if (state.meta.coverToolUrl) {
      coverLink.href = state.meta.coverToolUrl;
      coverLink.hidden = false;
    } else {
      coverLink.hidden = true;
    }
  }

  const regionSel = $("#f-region");
  regionSel.innerHTML =
    '<option value="">—</option>' +
    state.meta.regions.map((r) => `<option value="${r.value}">${r.name}</option>`).join("");

  // se rounds vazio, gera padrão
  if (!$("#rounds-list")?.children?.length) {
    refreshAutomaticRounds();
  }
  if (!phaseRows().length) renderPhaseEditor();
}

function mapOptionsHtml(selected = "") {
  const maps = (state.meta && state.meta.maps) || [];
  const normalizedSelected = String(selected || "").trim();
  const hasSelected = maps.some((m) => String(m) === normalizedSelected);
  const preserved = normalizedSelected && !hasSelected
    ? `<option value="${escapeHtml(normalizedSelected)}" selected>${escapeHtml(normalizedSelected)}</option>`
    : "";
  return (
    '<option value="">— mapa —</option>' + preserved +
    maps.map((m) => `<option value="${escapeHtml(m)}" ${String(m) === normalizedSelected ? "selected" : ""}>${escapeHtml(m)}</option>`).join("")
  );
}

function emoteOptionsHtml(selected = []) {
  const emotes = (state.meta && state.meta.emotes) || [];
  const chosen = Array.isArray(selected) ? selected : (selected ? [selected] : []);
  const all = ["none", ...emotes];
  return all.map((e) => `<option value="${e}" ${chosen.includes(e) ? "selected" : ""}>${e === "none" ? "Nenhum (sem emotes)" : e}</option>`).join("");
}

function selectedValues(select) {
  return Array.from(select?.selectedOptions || []).map((option) => option.value).filter(Boolean);
}

function normalizeEmoteSelection(values) {
  const list = [...new Set((values || []).filter(Boolean))];
  return list.includes("none") ? ["none"] : list;
}

function readRoundsFromDom() {
  return $$("#rounds-list .round-row").map((row, i) => {
    const emotes = normalizeEmoteSelection(selectedValues(row.querySelector(".r-emotes")));
    return {
      round: i + 1,
      map: row.querySelector(".r-map")?.value || "",
      emotes,
      emote1: emotes[0] || "",
      emote2: emotes[1] || "",
    };
  });
}

function addRoundRow(data = {}) {
  const list = $("#rounds-list");
  if (!list) return;
  const n = list.children.length + 1;
  const row = document.createElement("div");
  row.className = "round-row";
  const selectedEmotes = data.emotes || [data.emote1, data.emote2].filter(Boolean);
  row.innerHTML = `
    <span class="r-num">R${n}</span>
    <select class="r-map">${mapOptionsHtml(data.map || "")}</select>
    <select class="r-emotes" multiple size="4">${emoteOptionsHtml(selectedEmotes)}</select>
    <div class="round-actions">
      <button type="button" class="btn btn-ghost btn-sm r-copy" title="Copiar mapa/emotes para os próximos">Copiar ↓</button>
      <button type="button" class="btn btn-ghost btn-sm r-del" title="Remover">✕</button>
    </div>
  `;
  const renumber = () => {
    $$("#rounds-list .round-row").forEach((r, i) => {
      const el = r.querySelector(".r-num");
      if (el) el.textContent = "R" + (i + 1);
    });
    const rc = $("#f-round-count");
    if (rc) rc.value = String($$("#rounds-list .round-row").length);
    saveDraft();
    updatePreview();
  };
  row.querySelector(".r-del").onclick = () => {
    row.remove();
    renumber();
  };
  row.querySelector(".r-copy").onclick = () => {
    const map = row.querySelector(".r-map").value;
    const emotes = normalizeEmoteSelection(selectedValues(row.querySelector(".r-emotes")));
    let found = false;
    $$("#rounds-list .round-row").forEach((r) => {
      if (r === row) {
        found = true;
        return;
      }
      if (!found) return;
      r.querySelector(".r-map").value = map;
      Array.from(r.querySelector(".r-emotes").options).forEach((option) => { option.selected = emotes.includes(option.value); });
    });
    toast("Copiado para os rounds abaixo");
    saveDraft();
    updatePreview();
  };
  row.querySelectorAll("select").forEach((s) => s.addEventListener("change", () => {
    if (s.classList.contains("r-emotes")) {
      const values = normalizeEmoteSelection(selectedValues(s));
      Array.from(s.options).forEach((option) => { option.selected = values.includes(option.value); });
    }
    saveDraft();
    updatePreview();
  }));
  list.appendChild(row);
  renumber();
}

// Traduz o valor único do select "Modo de jogo" (solo, 1v1, 2v2, ...) para o
// contrato { mode, playersPerTeam } consumido pelo restante do painel e pelo
// backend (TournamentRules.ts). Substitui os antigos campos separados
// "Modo da match" + "Party size".
function parseGameMode(raw) {
  const value = String(raw || "1v1").trim().toLowerCase();
  if (value === "solo" || value === "ffa") return { mode: "solo", playersPerTeam: 1 };
  const match = value.match(/^(\d+)v\d+$/);
  const playersPerTeam = match ? Math.max(1, parseInt(match[1], 10)) : 1;
  return { mode: "teams", playersPerTeam };
}

function getClientTournamentFormat() {
  const { mode, playersPerTeam } = parseGameMode($("#f-mode")?.value);
  const maxTeamsPerMatch = mode === "solo" ? 4 : 2;
  return {
    mode,
    playersPerTeam,
    maxTeamsPerMatch,
    matchPlayerCapacity: playersPerTeam * maxTeamsPerMatch,
    minTeamsPerMatch: mode === "solo" ? 4 : 2,
  };
}

// Espelha o contrato puro de TournamentRules.ts para o preview estático. O
// servidor continua sendo a fonte de verdade na gravação.
function calculateRoundCount() {
  const players = Math.max(1, Number($("#f-max")?.value) || 1);
  const format = getClientTournamentFormat();
  const competitors = Math.max(1, Math.floor(players / format.playersPerTeam));
  const type = $("#f-type")?.value || "bracket";
  if (type === "roundrobin") return Math.max(1, Math.ceil((competitors - 1) / Math.max(1, format.maxTeamsPerMatch - 1)));
  let remaining = competitors;
  let rounds = 0;
  while (remaining > 1) {
    rounds++;
    const matches = Math.ceil(remaining / format.maxTeamsPerMatch);
    if (matches <= 1) break;
    remaining = matches * Math.max(1, Math.floor(format.maxTeamsPerMatch / 2));
  }
  return Math.max(1, rounds);
}

function refreshAutomaticRounds() {
  const count = calculateRoundCount();
  const field = $("#f-round-count");
  if (field) field.value = String(count);
  if ($("#rounds-list") && $$("#rounds-list .round-row").length !== count) buildRounds(count);
}

function buildRounds(count, seed = null) {
  const list = $("#rounds-list");
  if (!list) return;
  const prev = seed || readRoundsFromDom();
  list.innerHTML = "";
  const n = Math.max(1, Math.min(32, count || 1));
  for (let i = 0; i < n; i++) {
    addRoundRow(prev[i] || { map: $("#f-maps")?.value || "" });
  }
}

function refreshPhaseEditorFromInputs() {
  const saved = phaseRows().length ? readPhasesFromDom() : null;
  renderPhaseEditor(saved);
  saveDraft();
  updatePreview();
}
["#f-max", "#f-mode"].forEach((selector) => $(selector)?.addEventListener("input", refreshPhaseEditorFromInputs));
["#f-max", "#f-mode"].forEach((selector) => $(selector)?.addEventListener("change", refreshPhaseEditorFromInputs));


function resetForm() {
  state.editingId = null;
  $("#edit-id").value = "";
  $("#form-title").textContent = "Criar torneio";
  $("#btn-submit-form").textContent = "Criar";
  $("#tournament-form").reset();
  ["f-name", "f-max", "f-start", "f-fee", "f-image", "f-stream", "f-prize-pool", "f-color"].forEach(
    (id) => {
      const el = $("#" + id);
      if (el) el.value = "";
    }
  );
  if ($("#f-image")) $("#f-image").value = DEFAULT_TOURNAMENT_IMAGE;
  $("#f-region").value = "";
  $("#f-type").value = "";
  if ($("#f-mode")) $("#f-mode").value = "1v1";
  $("#f-phase-count").value = "1";
  Array.from($("#f-maps")?.options || []).forEach((option) => { option.selected = false; });
  Array.from($("#f-emote1")?.options || []).forEach((option) => { option.selected = false; });
  if ($("#f-emote2")) $("#f-emote2").value = "fixed";
  if ($("#rounds-list")) {
    const n = Number($("#f-round-count")?.value) || 8;
    buildRounds(n);
  }
  $("#f-leaderboard").checked = false;
  $("#f-color-picker").value = "#daef20";
  renderPhaseEditor();
  updatePreview();
}

function addPrizeRow(pos = "", amount = "", label = "") {
  const row = document.createElement("div");
  row.className = "prize-row";
  row.innerHTML = `
    <input type="number" class="p-pos" min="1" value="${pos}" placeholder="Pos" />
    <input type="number" class="p-amt" min="0" value="${amount}" placeholder="Valor" />
    <input type="text" class="p-lbl" value="${label}" placeholder="Label" />
    <button type="button" class="btn btn-ghost btn-sm p-del">✕</button>
  `;
  row.querySelector(".p-del").onclick = () => {
    row.remove();
    updatePreview();
    saveDraft();
  };
  row.querySelectorAll("input").forEach((i) =>
    i.addEventListener("input", () => {
      updatePreview();
      saveDraft();
    })
  );
  $("#prizes-list").appendChild(row);
}

$("#btn-add-prize")?.addEventListener("click", () => addPrizeRow());

function valuesOf(id) {
  return Array.from($(id)?.selectedOptions || []).map((option) => option.value).filter(Boolean);
}
function setupFriendlyMultiSelect(id, noneValue = "") {
  const select = $(id);
  if (!select || select.dataset.friendlyMulti === "1") return;
  select.dataset.friendlyMulti = "1";
  select.addEventListener("mousedown", (event) => {
    const option = event.target.closest("option");
    if (!option) return;
    event.preventDefault();
    if (noneValue && option.value === noneValue) {
      Array.from(select.options).forEach((item) => { item.selected = item === option; });
    } else {
      const none = noneValue ? Array.from(select.options).find((item) => item.value === noneValue) : null;
      if (none) none.selected = false;
      option.selected = !option.selected;
    }
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
setupFriendlyMultiSelect("#f-maps");
setupFriendlyMultiSelect("#f-emote1", "none");

function phaseRows() { return $$("#phases-list .phase-config"); }
function phaseChoiceHtml(values, selected = [], noneLabel = "") {
  const chosen = new Set(Array.isArray(selected) ? selected : (selected ? String(selected).split(",") : []));
  return values.map((value) => `<button type="button" class="choice-chip ${chosen.has(value) ? "selected" : ""}" data-value="${escapeHtml(value)}">${escapeHtml(value)}</button>`).join("");
}
function selectedChoices(container) {
  return Array.from(container?.querySelectorAll(".choice-chip.selected") || []).map((el) => el.dataset.value).filter(Boolean);
}
function renderPhaseEditor(phases = null) {
  const box = $("#phases-list");
  if (!box) return;
  const count = Math.max(1, Math.min(3, Number($("#f-phase-count")?.value) || (phases?.length || 1)));
  if ($("#f-phase-count")) $("#f-phase-count").value = String(count);
  const maps = (state.meta && state.meta.maps) || [];
  const emotes = (state.meta && state.meta.emotes) || [];
  const players = Math.max(1, Number($("#f-max")?.value) || 1);
  const { mode, playersPerTeam: party } = parseGameMode($("#f-mode")?.value);
  const bracketRounds = calculateRoundCount();
  ["#f-map-mode", "#f-maps", "#f-emote1", "#f-emote2"].forEach((id) => $(id)?.closest("label") && ($(id).closest("label").hidden = true));
  const chipGrid = (values, selected, cls) => `<div class="choice-grid ${cls}">${phaseChoiceHtml(values, selected)}</div>`;
  box.innerHTML = Array.from({ length: count }, (_, index) => {
    const phase = phases?.[index] || {};
    const bracket = index === count - 1;
    const savedRounds = Array.isArray(phase.rounds) ? phase.rounds : [];
    const savedMaps = phase.maps || phase.Maps || [];
    const savedEmotes = phase.emotes || phase.Emotes || phase.RoundEmotes || [];
    const rounds = bracket ? bracketRounds : Math.max(1, Number(phase.rounds || phase.RoundCount) || 1);
    const normalMap = savedMaps[0] || "";
    const normalEmotes = Array.isArray(savedEmotes[0]) ? savedEmotes[0] : savedEmotes;
    const roundRows = bracket ? Array.from({ length: rounds }, (_, r) => {
      const cfg = savedRounds[r] || {};
      const map = cfg.map || savedMaps[r] || "";
      const selected = cfg.emotes || (Array.isArray(savedEmotes[r]) ? savedEmotes[r] : []);
      return `<div class="bracket-round" data-round="${r + 1}"><strong>Round ${r + 1}</strong><select class="phase-round-map">${mapOptionsHtml(map)}</select>${chipGrid(["none", ...emotes], selected, "phase-round-emotes")}<button type="button" class="btn btn-ghost btn-sm phase-apply-all">Aplicar este round a todos</button></div>`;
    }).join("") : `<label><span>Rounds da fase</span><input class="phase-rounds" type="number" min="1" max="32" value="${rounds}" /></label><label><span>Um mapa fixo para todos os rounds</span><select class="phase-normal-map">${mapOptionsHtml(normalMap)}</select></label>${chipGrid(["none", ...emotes], normalEmotes, "phase-emotes")} `;
    return `<div class="phase-config glass" data-phase-index="${index}" data-phase-type="${bracket ? "bracket" : "normal"}"><div class="phase-heading"><strong>Fase ${index + 1}${bracket ? " · BRACKET FINAL" : " · NORMAL"}</strong><small>${bracket ? `Rounds automáticos pela quantidade de jogadores: ${bracketRounds}` : "Um mapa e os emotes escolhidos valem para todos os rounds."}</small></div>${bracket ? `<div class="bracket-rounds">${roundRows}</div>` : `<div class="normal-phase-config">${roundRows}</div>`}</div>`;
  }).join("");
  const applyEmoteBehavior = (grid) => grid.addEventListener("click", (event) => {
    const chip = event.target.closest(".choice-chip"); if (!chip) return;
    if (chip.dataset.value === "none") grid.querySelectorAll(".choice-chip").forEach((item) => item.classList.remove("selected"));
    else { grid.querySelector('.choice-chip[data-value="none"]')?.classList.remove("selected"); chip.classList.toggle("selected"); }
    saveDraft(); updatePreview();
  });
  box.querySelectorAll(".phase-emotes,.phase-round-emotes").forEach(applyEmoteBehavior);
  box.querySelectorAll(".phase-apply-all").forEach((button) => button.addEventListener("click", () => {
    const source = button.closest(".bracket-round"); const map = source.querySelector(".phase-round-map").value; const emotes = selectedChoices(source.querySelector(".phase-round-emotes"));
    box.querySelectorAll(".bracket-round").forEach((row) => { row.querySelector(".phase-round-map").value = map; row.querySelectorAll(".choice-chip").forEach((chip) => chip.classList.toggle("selected", emotes.includes(chip.dataset.value))); });
    saveDraft(); updatePreview();
  }));
  box.querySelectorAll("input,select").forEach((el) => el.addEventListener("change", () => { saveDraft(); updatePreview(); }));
}
function readPhasesFromDom() {
  return phaseRows().map((row, index) => {
    const bracket = row.dataset.phaseType === "bracket";
    if (!bracket) return { name: `Fase ${index + 1}`, type: "normal", rounds: Math.max(1, Number(row.querySelector(".phase-rounds")?.value) || 1), maps: [row.querySelector(".phase-normal-map")?.value || ""], emotes: normalizeEmoteSelection(selectedChoices(row.querySelector(".phase-emotes"))) };
    const rounds = Array.from(row.querySelectorAll(".bracket-round")).map((round, i) => ({ round: i + 1, map: round.querySelector(".phase-round-map")?.value || "", emotes: normalizeEmoteSelection(selectedChoices(round.querySelector(".phase-round-emotes"))) }));
    return { name: `Fase ${index + 1}`, type: "bracket", rounds, maps: rounds.map((r) => r.map), emotes: rounds.map((r) => r.emotes) };
  });
}

function formPayload() {
  const phaseCount = Math.max(1, Math.min(3, Number($("#f-phase-count")?.value) || 1));
  const prizes = $$(".prize-row").map((row) => ({
    position: parseInt(row.querySelector(".p-pos")?.value, 10) || 1,
    amount: parseInt(row.querySelector(".p-amt")?.value, 10) || 0,
    label: row.querySelector(".p-lbl")?.value.trim() || "",
  }));
  const rounds = phaseCount > 1 ? [] : readRoundsFromDom();
  const mapsFromRounds = rounds.map((r) => r.map).filter(Boolean);
  const selectedEmotes = valuesOf("#f-emote1");
  return {
    name: $("#f-name").value.trim(),
    maxPlayers: parseInt($("#f-max").value, 10),
    startInMinutes: parseInt($("#f-start").value, 10),
    region: $("#f-region").value,
    type: $("#f-type").value,
    mode: getClientTournamentFormat().mode,
    party: getClientTournamentFormat().playersPerTeam,
    playersPerTeam: getClientTournamentFormat().playersPerTeam,
    maxTeamsPerMatch: getClientTournamentFormat().maxTeamsPerMatch,
    matchCapacity: getClientTournamentFormat().matchPlayerCapacity,
    fee: parseInt($("#f-fee").value, 10) || 0,
    phases: readPhasesFromDom(),
    maxTeams: null,
    maps: mapsFromRounds.join(","),
    mapMode: "fixed",
    rounds,
    emotes: [],
    emoteMode: "fixed",
    emote1: null,
    emote2: null,
    image: $("#f-image").value.trim(),
    color: $("#f-color").value.trim() || "#7f62ff",
    countForLeaderboard: $("#f-leaderboard").checked,
    streamUrl: $("#f-stream").value.trim(),
    prizeMode: $("#f-prize-mode")?.value === "tag" ? "tag" : "gems",
    prizePoolGems: Math.max(0, parseInt($("#f-prize-pool")?.value || "0", 10) || 0),
    prizeTag: $("#f-prize-tag")?.value.trim() || "",
    prizeTagDurationValue: Math.max(1, parseInt($("#f-prize-duration-value")?.value || "1", 10) || 1),
    prizeTagDurationUnit: $("#f-prize-duration-unit")?.value || "days",
    prizes,
  };
}

function fillFormFromData(d) {
  const props = d.Properties || {};
  const name = d.name ?? d.TournamentName;
  const maxPlayers = d.maxPlayers ?? d.MaxInvites;
  const storedMode = d.mode ?? d.Mode ?? props.Mode ?? (((d.MaxTeamsPerMatch || d.MaxPlayersPerMatch || 2) > 2 && (d.PlayersPerTeam ?? d.PartySize ?? 1) === 1) ? "solo" : "teams");
  const party = d.party ?? d.PlayersPerTeam ?? d.PartySize;
  const fee = d.fee ?? d.EntryFee;
  const region = d.region ?? d.Region;
  const startInMinutes = d.startInMinutes != null ? d.startInMinutes : (d.StartTime ? Math.max(0, Math.round((new Date(d.StartTime).getTime() - Date.now()) / 60000)) : null);
  if (name) $("#f-name").value = name;
  if (maxPlayers != null) $("#f-max").value = maxPlayers;
  if (startInMinutes != null) $("#f-start").value = startInMinutes;
  if (region) $("#f-region").value = region;
  if (d.type || d.TournamentType != null) $("#f-type").value = d.type || ({ 1: "arena", 2: "bracket", 3: "roundrobin" }[d.TournamentType] || "bracket");
  if ($("#f-mode")) {
    const storedParty = Math.max(1, Number(party) || 1);
    $("#f-mode").value = storedMode === "solo" ? "solo" : `${storedParty}v${storedParty}`;
  }
  if (fee != null) $("#f-fee").value = fee;
  const storedMaps = d.maps ?? props.RoundMaps;
  if (storedMaps) {
    const mapValues = Array.isArray(storedMaps) ? storedMaps : String(storedMaps).split(",").map((x) => x.trim());
    Array.from($("#f-maps")?.options || []).forEach((option) => { option.selected = mapValues.includes(option.value); });
  }
  if (d.mapMode || props.MapMode) { const mapMode = $("#f-map-mode"); if (mapMode) mapMode.value = d.mapMode || props.MapMode; }
  const storedEmotes = d.emotes ?? props.SelectedEmotes;
  if (storedEmotes) {
    const emoteValues = Array.isArray(storedEmotes) ? storedEmotes : [storedEmotes];
    Array.from($("#f-emote1")?.options || []).forEach((option) => { option.selected = emoteValues.includes(option.value); });
  } else if (d.emote1 && $("#f-emote1")) $("#f-emote1").value = d.emote1;
  if (d.emoteMode || props.EmoteMode) { const emoteMode = $("#f-emote2"); if (emoteMode) emoteMode.value = d.emoteMode || props.EmoteMode; }
  const image = d.image ?? d.TournamentImage;
  const color = d.color ?? d.TournamentColor;
  if (image) $("#f-image").value = image;
  if (color) {
    $("#f-color").value = color;
    $("#f-color-picker").value = String(color).startsWith("#") ? color : "#7f62ff";
  }
  if (d.streamUrl || props.StreamURL) $("#f-stream").value = d.streamUrl || props.StreamURL;
  if (Array.isArray(d.phases || d.Phases)) {
    const storedPhases = d.phases || d.Phases;
    $("#f-phase-count").value = String(Math.max(1, Math.min(3, storedPhases.length)));
    renderPhaseEditor(storedPhases);
  }
  const prizeMode = d.prizeMode ?? d.PrizeMode ?? "gems";
  if ($("#f-prize-mode")) $("#f-prize-mode").value = prizeMode === "tag" ? "tag" : "gems";
  if ($("#f-prize-pool") && (d.prizePoolGems != null || d.PrizePoolGems != null)) $("#f-prize-pool").value = d.prizePoolGems ?? d.PrizePoolGems;
  if ($("#f-prize-tag")) $("#f-prize-tag").value = d.prizeTag ?? d.PrizeTag ?? "";
  if ($("#f-prize-duration-value")) $("#f-prize-duration-value").value = d.prizeTagDurationValue ?? d.PrizeTagDurationValue ?? 1;
  if ($("#f-prize-duration-unit")) $("#f-prize-duration-unit").value = d.prizeTagDurationUnit ?? d.PrizeTagDurationUnit ?? "days";
  togglePrizeFields();
  if (Array.isArray(d.rounds) && d.rounds.length) {
    buildRounds(d.rounds.length, d.rounds);
  } else if (storedMaps) {
    const maps = (Array.isArray(storedMaps) ? storedMaps : String(storedMaps).split(",")).map((s) => String(s).trim()).filter(Boolean);
    if (maps.length) buildRounds(maps.length, maps.map((m) => ({ map: m })));
  }
  $("#f-leaderboard").checked = !!(d.countForLeaderboard ?? props.CountForLeaderboard);
  if ($("#f-prize-pool") && d.prizePoolGems == null) $("#f-prize-pool").value = (d.prizes || []).reduce((sum, prize) => sum + (Number(prize.amount) || 0), 0);
  updatePreview();
}

function updatePreview() {
  const p = formPayload();
  $("#pv-name").textContent = p.name || "—";
  $("#pv-name").style.color = p.color || "#daef20";
  const thumb = $("#pv-thumb");
  if (p.image) thumb.style.backgroundImage = `url("${p.image}")`;
  else {
    thumb.style.backgroundImage = "none";
    thumb.style.background = `linear-gradient(135deg, ${p.color || "#daef20"}33, #5b8cff22)`;
  }
  $("#pv-meta").innerHTML = `
    <div>Região: <strong>${(p.region || "—").toUpperCase()}</strong></div>
    <div>Jogadores: <strong>${p.maxPlayers || "—"}</strong> · Modo <strong>${p.mode === "solo" ? "Solo (1v1v1v1)" : "Times"}</strong> · Jogadores/time <strong>${p.playersPerTeam || "—"}</strong> · Capacidade/match <strong>${p.matchCapacity || "—"}</strong></div>
    <div>Tipo: <strong>${p.type || "—"}</strong> · Rounds: <strong>${(p.rounds && p.rounds.length) || "—"}</strong></div>
    <div>Mapas: <strong>${(p.rounds && p.rounds.filter(r=>r.map).map(r=>r.map).slice(0,4).join(", ")) || p.maps || "—"}</strong></div>
    <div>Início em: <strong>${p.startInMinutes || "—"} min</strong></div>
  `;
  const prizesEl = $("#pv-prizes");
  if (prizesEl) {
    if (p.prizeMode === "tag") {
      const unit = p.prizeTagDurationUnit === "permanent" ? "permanente" : `${p.prizeTagDurationValue} ${p.prizeTagDurationUnit}`;
      prizesEl.innerHTML = `<div class="preview-tag">Tag <strong>${escapeHtml(p.prizeTag || "—")}</strong> · ${escapeHtml(unit)}</div>`;
    } else {
      const prizes = p.prizes || [];
      prizesEl.innerHTML = prizes.length
        ? prizes.map((x) => `<div>#${x.position} · ${x.amount} ${escapeHtml(x.label || "")}</div>`).join("")
        : `<div class="muted">Pool: ${p.prizePoolGems || 0} gemas</div>`;
    }
  }
}

function togglePrizeFields() {
  const isTag = $("#f-prize-mode")?.value === "tag";
  if ($("#prize-tag-fields")) $("#prize-tag-fields").hidden = !isTag;
  if ($("#prize-gems-field")) $("#prize-gems-field").hidden = isTag;
}
$("#f-prize-mode")?.addEventListener("change", () => { togglePrizeFields(); updatePreview(); saveDraft(); });
togglePrizeFields();

[
  "f-name", "f-max", "f-start", "f-region", "f-type", "f-mode", "f-fee",
  "f-maps", "f-emote1", "f-emote2", "f-image", "f-color", "f-stream", "f-prize-pool", "f-prize-tag", "f-prize-duration-value", "f-prize-duration-unit",
].forEach((id) => {
  const el = $("#" + id);
  if (el) {
    el.addEventListener("input", () => {
      updatePreview();
      saveDraft();
    });
    el.addEventListener("change", () => {
      updatePreview();
      saveDraft();
    });
  }
});
$("#f-leaderboard")?.addEventListener("change", saveDraft);
$("#f-phase-count")?.addEventListener("change", () => { renderPhaseEditor(); saveDraft(); updatePreview(); });

$("#f-color-picker")?.addEventListener("input", (e) => {
  $("#f-color").value = e.target.value;
  updatePreview();
  saveDraft();
});

$("#btn-submit-form")?.addEventListener("click", async (e) => {
  e.preventDefault();
  if (!requireLogin()) return;
  const payload = formPayload();
  if (!payload.name || !payload.maxPlayers || !payload.region || !payload.type) {
    toast("Preencha nome, jogadores, região e tipo", true);
    return;
  }
  if (Number.isNaN(payload.startInMinutes)) {
    toast("Informe minutos até o início", true);
    return;
  }
  try {
    if (state.editingId) {
      await api("/api/tournaments/" + state.editingId, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      toast("Atualizado");
    } else {
      const saved = await api("/api/tournaments", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      toast("Criado · ID " + saved.TournamentId + " · embed enviada se webhook ok");
      clearDraft();
    }
    state.editingId = null;
    switchView("list");
  } catch (ex) {
    toast(ex.message, true);
  }
});

$("#btn-save-template")?.addEventListener("click", async () => {
  if (!requireLogin()) return;
  const payload = formPayload();
  const name = prompt("Nome do template:", payload.name || "Meu template");
  if (!name) return;
  try {
    await api("/api/templates", {
      method: "POST",
      body: JSON.stringify({ name, data: payload }),
    });
    toast("Template salvo");
  } catch (ex) {
    toast(ex.message, true);
  }
});

function pad2(n) { return String(n).padStart(2, "0"); }

function formatCountdown(iso) {
  if (!iso) return "—";
  const d = new Date(iso).getTime();
  const now = Date.now();
  const diff = d - now;
  if (diff <= 0) {
    const ago = Math.abs(diff);
    if (ago < 60000) return "agora";
    if (ago < 3600000) return "há " + Math.floor(ago / 60000) + "m";
    return "iniciado";
  }
  const s = Math.floor(diff / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h >= 48) {
    return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  }
  if (h >= 24) return Math.floor(h / 24) + "d " + pad2(h % 24) + "h";
  return (h > 0 ? h + ":" : "") + pad2(m) + ":" + pad2(sec);
}

function formatStart(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const cd = formatCountdown(iso);
  return `<span class="countdown" data-start="${escapeHtml(iso)}" title="${d.toLocaleString("pt-BR")}">${cd}</span>`;
}

function tickCountdowns() {
  $$(".countdown[data-start]").forEach((el) => {
    el.textContent = formatCountdown(el.dataset.start);
  });
}
setInterval(tickCountdowns, 1000);

function rowActions(t) {
  if (!state.user) return "";
  return `
    <div class="row-actions">
      <button type="button" class="btn btn-ghost btn-sm" data-act="edit" data-id="${escapeHtml(t.TournamentId)}">Editar</button>
      <button type="button" class="btn btn-primary btn-sm" data-act="bracket" data-id="${escapeHtml(t.TournamentId)}">Ver bracket</button>
      <button type="button" class="btn btn-ghost btn-sm" data-act="cancel" data-id="${escapeHtml(t.TournamentId)}">Cancelar</button>
    </div>
  `;
}

function renderTable(bodyId, list) {
  const body = $("#" + bodyId);
  if (!list.length) {
    body.innerHTML = `<tr><td colspan="7" class="empty">Nenhum torneio</td></tr>`;
    return;
  }
  body.innerHTML = list
    .map((t) => {
      const [label, cls] = STATUS_BADGE[t.Status] || STATUS_BADGE[-1];
      const players = `${t.CurrentInvites || 0}/${t.MaxInvites || "?"}`;
      return `<tr>
        <td data-label="Nome"><strong style="color:${escapeHtml(t.TournamentColor || "var(--accent)")}">${escapeHtml(t.TournamentName || "")}</strong>
          ${t.CreatedByDiscordTag || t.CreatedByDiscordId ? `<div class="muted creator-line" style="font-size:0.75rem" title="Discord ID: ${escapeHtml(t.CreatedByDiscordId || "")}">por ${escapeHtml(t.CreatedByDiscordTag || "—")} <code class="id-chip">${escapeHtml(t.CreatedByDiscordId || "")}</code></div>` : ""}
        </td>
        <td data-label="ID"><code>${escapeHtml(t.TournamentId)}</code></td>
        <td data-label="Região">${escapeHtml(String(t.Region || "").toUpperCase())}</td>
        <td data-label="Jogadores">${players}</td>
        <td data-label="Início">${formatStart(t.StartTime)}</td>
        <td data-label="Status"><span class="badge ${cls}">${label}</span></td>
        <td data-label="">${rowActions(t)}</td>
      </tr>`;
    })
    .join("");

  body.querySelectorAll("[data-act]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const act = btn.dataset.act;
      if (act === "edit") {
        if (!requireLogin()) return;
        try {
          const t = await api("/api/tournaments/" + id);
          state.editingId = id;
          $("#edit-id").value = id;
          $("#form-title").textContent = "Editar · " + id;
          $("#btn-submit-form").textContent = "Salvar";
          fillFormFromData({
            name: t.TournamentName,
            maxPlayers: t.MaxInvites,
            region: t.Region,
            mode: (t.Properties && t.Properties.Mode) || ((Number(t.PlayersPerTeam ?? t.PartySize ?? 1) === 1 && Number(t.MaxTeamsPerMatch ?? t.MaxPlayersPerMatch ?? 2) > 2) ? "solo" : "teams"),
            party: t.PlayersPerTeam ?? t.PartySize,
            fee: t.EntryFee,
            image: t.TournamentImage || "",
            color: t.TournamentColor || "#daef20",
            streamUrl: (t.Properties && t.Properties.StreamURL) || "",
            countForLeaderboard: !!(t.Properties && t.Properties.CountForLeaderboard),
            emotes: (t.Properties && t.Properties.SelectedEmotes) || [],
            mapMode: (t.Properties && t.Properties.MapMode) || "fixed",
            emoteMode: (t.Properties && t.Properties.EmoteMode) || "fixed",
            rounds: ((t.Properties && t.Properties.RoundMaps) || []).map((map, index) => ({
              map,
              emotes: ((t.Properties && t.Properties.RoundEmotes) || [])[index] || [],
            })),
            prizes: t.Prizes || [],
            prizePoolGems: t.PrizePoolGems,
            type: { 1: "arena", 2: "bracket", 3: "roundrobin" }[t.TournamentType] || "bracket",
            maps: ((t.Properties && t.Properties.RoundMaps) || []).join(","),
            phases: t.Phases || [],
            startInMinutes: Math.max(1, Math.round((new Date(t.StartTime) - Date.now()) / 60000)),
          });
          switchView("create");
        } catch (ex) {
          toast(ex.message, true);
        }
      }
      if (act === "bracket") {
        if (!requireLogin()) return;
        showBracket(id);
      }
      if (act === "cancel") {
        if (!requireLogin()) return;
        if (!confirm("Cancelar este torneio? (some do site em até 5 min)")) return;
        try {
          await api("/api/tournaments/" + id + "?soft=1", { method: "DELETE" });
          toast("Cancelado");
          loadTournaments(state.listFilter);
        } catch (ex) {
          toast(ex.message, true);
        }
      }
    });
  });
}

function matchStatusClass(match) { return match.isLive ? "live" : match.isFinished ? "finished" : "pending"; }
function renderBracketMatch(match) {
  const isPlayer = !!match.viewerIsPlayer || (match.players || []).some((player) => String(player.id) === String(state.user?.id));
  const players = (match.players || []).map((player) => `<div class="bracket-player ${player.winner ? "winner" : ""}"><span>${escapeHtml(player.nick || "—")}</span><code>${escapeHtml(player.id || "—")}</code></div>`).join("") || `<div class="muted">Nenhum jogador alocado</div>`;
  const watch = match.isLive && !isPlayer ? `<button class="btn btn-primary btn-sm bracket-watch" data-match="${escapeHtml(match.id)}">Assistir</button>` : "";
  const wo = state.user?.isAdmin && !match.isFinished && (match.players || []).length ? `<button class="btn btn-danger btn-sm bracket-wo" data-match="${escapeHtml(match.id)}">Aplicar WO</button>` : "";
  return `<article class="bracket-match ${matchStatusClass(match)}"><header><strong>Match ${escapeHtml(match.matchNumber)}</strong><span>${escapeHtml(match.phaseLabel)} · Round ${escapeHtml(match.round)}</span><b>${escapeHtml(match.statusLabel)}</b></header><div class="bracket-players">${players}</div><footer>${watch}${wo}</footer></article>`;
}
async function showBracket(tournamentId) {
  const modal = $("#modal"); const body = $("#modal-body");
  if (!modal || !body) return;
  body.innerHTML = `<div class="modal-loading">Carregando bracket…</div>`; modal.hidden = false;
  try {
    const data = await api(`/api/tournaments/${encodeURIComponent(tournamentId)}/bracket`);
    state.bracketTournamentId = tournamentId;
    const winners = (data.tournament?.winners || []).map((winner) => `<div class="winner-card"><strong>${escapeHtml(winner.nick || winner.Name || winner.userId)}</strong><code>${escapeHtml(winner.userId || winner.PlayerId || "—")}</code><span>${winner.rewardType === "tag" ? `Tag: ${escapeHtml(winner.rewardTag || data.tournament.prizeTag || "—")}` : `Gemas: ${escapeHtml(winner.rewardAmount ?? "0")}`}</span></div>`).join("");
    body.innerHTML = `<div class="bracket-modal"><div class="bracket-title"><span class="eyebrow">TORNEIO · ${escapeHtml(data.tournament?.id || tournamentId)}</span><h2>${escapeHtml(data.tournament?.name || "Bracket")}</h2><p class="muted">Cada match mostra nick, ID, fase, round e status. Espectadores entram como ghost e não podem interferir.</p></div><div class="winner-strip"><h3>Winners</h3>${winners || `<span class="muted">Ainda não há vencedores.</span>`}</div><div class="bracket-grid">${(data.matches || []).map(renderBracketMatch).join("") || `<p class="empty">Nenhuma match criada ainda.</p>`}</div></div>`;
    body.querySelectorAll(".bracket-watch").forEach((button) => button.addEventListener("click", async () => {
      try { const view = await api(`/api/matches/${encodeURIComponent(button.dataset.match)}/spectate`, { method: "POST", body: JSON.stringify({}) }); renderSpectator(view); } catch (error) { toast(error.message, true); }
    }));
    body.querySelectorAll(".bracket-wo").forEach((button) => button.addEventListener("click", async () => {
      const match = (data.matches || []).find((item) => item.id === button.dataset.match); const selected = match?.players?.[0];
      if (!selected || !confirm(`Aplicar WO para ${selected.nick} (${selected.id})?`)) return;
      try { await api(`/api/wo/${encodeURIComponent(button.dataset.match)}`, { method: "POST", body: JSON.stringify({ playerId: selected.id }) }); toast("WO aplicado"); await showBracket(tournamentId); loadTournaments(state.listFilter); } catch (error) { toast(error.message, true); }
    }));
  } catch (error) { body.innerHTML = `<p class="error-msg">${escapeHtml(error.message)}</p>`; }
}
function renderSpectator(view) {
  const body = $("#modal-body"); if (!body) return;
  body.innerHTML = `<div class="spectator-screen"><span class="eyebrow">MODO ESPECTADOR · GHOST</span><h2>${escapeHtml(view.tournamentName || "Partida")}</h2><p class="muted">Você está observando como se já tivesse sido eliminado. Este modo não altera resultado, check-in, equipe ou pontuação.</p><div class="spectator-live"><strong>${view.isLive ? "AO VIVO" : escapeHtml(view.statusLabel || "Partida")}</strong><span>${escapeHtml(view.phaseLabel || "Fase")} · Round ${escapeHtml(view.round || "—")}</span></div><div class="bracket-players">${(view.players || []).map((player) => `<div class="bracket-player"><span>${escapeHtml(player.nick)}</span><code>${escapeHtml(player.id)}</code></div>`).join("")}</div><div class="spectator-rules"><span>Ghost: sim</span><span>Interferência: não</span><span>Resultado: bloqueado</span></div><button type="button" class="btn btn-ghost" data-close>Voltar ao bracket</button></div>`;
  body.querySelector("[data-close]")?.addEventListener("click", () => showBracket(view.tournamentId));
}

async function loadTournaments(filter) {
  const bodyId = filter === "history" || filter === "finished" ? "history-body" : "tournaments-body";
  try {
    const list = await api("/api/tournaments?filter=" + encodeURIComponent(filter));
    if (filter === "history" || filter === "finished") {
      state.history = list;
      renderTable("history-body", list);
    } else {
      state.tournaments = list;
      let filtered = list;
      const q = ($("#search-tournaments")?.value || "").trim().toLowerCase();
      if (q) {
        filtered = list.filter(
          (t) =>
            (t.TournamentName || "").toLowerCase().includes(q) ||
            String(t.TournamentId).includes(q) ||
            String(t.Region || "").toLowerCase().includes(q)
        );
      }
      renderTable("tournaments-body", filtered);
    }
    updateStats();
  } catch (ex) {
    toast(ex.message, true);
    const body = $("#" + bodyId);
    if (body) {
      body.innerHTML = `<tr><td colspan="7" class="empty" style="color:#f66">Erro ao carregar: ${escapeHtml(ex.message)} <button type="button" class="btn btn-ghost btn-sm" id="retry-${bodyId}" style="margin-left:8px">Tentar de novo</button></td></tr>`;
      $("#retry-" + bodyId)?.addEventListener("click", () => loadTournaments(filter));
    }
  }
}

$("#search-tournaments")?.addEventListener("input", () => {
  const q = ($("#search-tournaments").value || "").trim().toLowerCase();
  let filtered = state.tournaments;
  if (q) {
    filtered = state.tournaments.filter(
      (t) =>
        (t.TournamentName || "").toLowerCase().includes(q) ||
        String(t.TournamentId).includes(q) ||
        String(t.Region || "").toLowerCase().includes(q)
    );
  }
  renderTable("tournaments-body", filtered);
});

async function updateStats() {
  const el = $("#stats-row");
  if (!el) return;
  try {
    const s = await api("/api/stats");
    el.innerHTML = `
      <div class="stat-chip">Abertos <strong>${s.open}</strong></div>
      <div class="stat-chip">Em jogo <strong>${s.running}</strong></div>
      <div class="stat-chip">Histórico <strong>${s.finishedRecent}</strong></div>
      <div class="stat-chip">Total <strong>${s.total}</strong></div>
    `;
  } catch {
    const open = state.tournaments.filter((t) => t.Status === 1).length;
    const run = state.tournaments.filter((t) => t.Status === 5).length;
    el.innerHTML = `
      <div class="stat-chip">Abertos <strong>${open}</strong></div>
      <div class="stat-chip">Em jogo <strong>${run}</strong></div>
    `;
  }
}

async function loadTemplates() {
  try {
    state.templates = await api("/api/templates");
    const box = $("#templates-list");
    if (!state.templates.length) {
      box.innerHTML = `<p class="empty">Nenhum template ainda</p>`;
      return;
    }
    box.innerHTML = state.templates
      .map(
        (t) => `
      <div class="template-card glass">
        <strong>${escapeHtml(t.name)}</strong>
        <small class="muted">${new Date(t.createdAt).toLocaleString("pt-BR")}</small>
        <div class="header-actions" style="margin-top:10px">
          <button type="button" class="btn btn-primary btn-sm" data-use="${t.id}">Usar</button>
          <button type="button" class="btn btn-ghost btn-sm" data-del="${t.id}">Apagar</button>
        </div>
      </div>`
      )
      .join("");
    box.querySelectorAll("[data-use]").forEach((btn) => {
      btn.onclick = () => {
        if (!requireLogin()) return;
        const item = state.templates.find((x) => x.id === btn.dataset.use);
        if (!item) return;
        state.editingId = null;
        fillFormFromData(item.data || item);
        switchView("create");
        toast("Template aplicado");
      };
    });
    box.querySelectorAll("[data-del]").forEach((btn) => {
      btn.onclick = async () => {
        if (!requireLogin()) return;
        if (!confirm("Apagar template?")) return;
        try {
          await api("/api/templates/" + btn.dataset.del, { method: "DELETE" });
          loadTemplates();
        } catch (ex) {
          toast(ex.message, true);
        }
      };
    });
  } catch (ex) {
    toast(ex.message, true);
  }
}

async function loadCalendar() {
  try {
    const days = $("#cal-days")?.value || "14";
    const data = await api("/api/calendar?days=" + days);
    const box = $("#calendar-grid");
    const keys = Object.keys(data.byDay || {}).sort();
    if (!keys.length) {
      box.innerHTML = `<p class="empty">Nenhum torneio nos próximos ${days} dias</p>`;
      return;
    }
    box.innerHTML = keys
      .map((day) => {
        const items = data.byDay[day];
        const label = new Date(day + "T12:00:00").toLocaleDateString("pt-BR", {
          weekday: "short",
          day: "2-digit",
          month: "short",
        });
        return `<div class="cal-day glass">
          <h3>${escapeHtml(label)}</h3>
          <div class="cal-items">
            ${items
              .map(
                (t) => `<div class="cal-item" style="border-left-color:${escapeHtml(t.TournamentColor || "#daef20")}">
              <strong>${escapeHtml(t.TournamentName)}</strong>
              <span class="countdown" data-start="${escapeHtml(t.StartTime)}">${formatCountdown(t.StartTime)}</span>
              <small>${escapeHtml(String(t.Region || "").toUpperCase())} · ${t.CurrentInvites || 0}/${t.MaxInvites || "?"}
              ${t.CreatedByDiscordTag ? ` · <span title="${escapeHtml(t.CreatedByDiscordId || "")}">${escapeHtml(t.CreatedByDiscordTag)}</span>` : ""}</small>
            </div>`
              )
              .join("")}
          </div>
        </div>`;
      })
      .join("");
  } catch (ex) {
    toast(ex.message, true);
  }
}

$("#cal-days")?.addEventListener("change", () => loadCalendar());

async function loadRanking() {
  try {
    const data = await api("/api/leaderboard?limit=50");
    const body = $("#ranking-body");
    if (!data.ranking || !data.ranking.length) {
      body.innerHTML = `<tr><td colspan="6" class="empty">Sem dados de Winners ainda (torneios finalizados com ranking)</td></tr>`;
      return;
    }
    body.innerHTML = data.ranking
      .map(
        (r) => `<tr>
        <td data-label="#"><strong>${r.rank}</strong></td>
        <td data-label="Jogador">${escapeHtml(r.name)}</td>
        <td data-label="ID"><code>${escapeHtml(r.id)}</code></td>
        <td data-label="Vitórias">${r.wins}</td>
        <td data-label="Pódios">${r.podiums}</td>
        <td data-label="Torneios">${r.tournaments}</td>
      </tr>`
      )
      .join("");
  } catch (ex) {
    toast(ex.message, true);
  }
}

function startPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => {
    if (!state.user) return;
    const view = $$(".nav-item.active")[0]?.dataset.view;
    if (view === "list") loadTournaments("active");
    if (view === "history") loadTournaments("history");
    if (view === "calendar") loadCalendar();
  }, 20000);
}

// Init
(async () => {
  handleOAuthReturn();
  await checkAuth();
  try {
    await loadMeta();
  } catch (e) {
    $("#setup-banner").hidden = false;
  }
  const prefs = loadPrefs();
  const startView = prefs.lastView && ["list", "history", "create", "templates", "calendar", "ranking"].includes(prefs.lastView)
    ? prefs.lastView
    : "list";
  if ((startView === "create" || startView === "templates") && !state.user) {
    switchView("list");
  } else {
    switchView(startView);
  }
  startPolling();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
})();
